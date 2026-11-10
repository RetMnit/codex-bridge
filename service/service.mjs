import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { STATE, VERSION, PROTOCOL, BridgeError, atomic, readJson, now, summary, terminal, clientOf } from '../lib/common.mjs';
import { codexRunner, catalog, sessions, threadContext, threadLocked, openThread, projectList, SANDBOXES, THREAD_OPEN } from '../lib/codex.mjs';

const RETAIN_DAYS = 30, RETAIN_PER_CLIENT = 500;
export function createService({ state = STATE, runner, codexApp = { open: openThread }, threadLock = threadLocked, clock = Date.now } = {}) {
  const file = path.join(state, 'jobs.json');
  const jobs = new Map((readJson(file, { jobs: [] }).jobs ?? []).map(job => [job.jobId, job]));
  const changes = new EventEmitter(); changes.setMaxListeners(200);
  let cursor = 0, saveTimer;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => atomic(file, { jobs: [...jobs.values()] }), 50); };
  const changed = () => { cursor++; save(); changes.emit('change'); };
  runner ??= codexRunner({ state, onChange: changed });
  // Codex's own model list, asked at most every ten minutes; the app's cache file when it cannot be asked.
  let modelCache;
  const models = async () => {
    if (!modelCache || clock() - modelCache.at > 600000) {
      try { modelCache = { at: clock(), list: await runner.models() }; } catch { return undefined; }
    }
    return modelCache.list;
  };

  function settingsOf(input) {
    const text = (key, value) => { if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new BridgeError('bridge/invalid', 'Invalid ' + key); return value?.trim(); };
    let workspace = text('workspace', input.workspace);
    if (input.project !== undefined) {
      const project = projectList().projects.find(item => item.id === input.project);
      if (!project) throw new BridgeError('bridge/invalid', 'Unknown Codex project ' + input.project);
      workspace = project.root;
    }
    if (!workspace || !fs.existsSync(workspace)) throw new BridgeError('bridge/invalid', 'workspace does not exist: ' + workspace);
    const value = { workspace };
    for (const key of ['model', 'effort', 'sandbox']) if (input[key]) value[key] = text(key, input[key]);
    if (value.sandbox && !SANDBOXES.includes(value.sandbox)) throw new BridgeError('bridge/invalid', 'Unknown sandbox ' + value.sandbox);
    return value;
  }
  const task = params => {
    // Protocol 1 had a desktop mode that opened each ended run in the Codex app;
    // the app then holds the thread's writer lock until it quits, so it was dropped.
    if (params.mode !== undefined) throw new BridgeError('bridge/invalid', 'mode was removed in protocol 2: runs are always hidden; use open to show a thread');
    for (const key of ['prompt', 'requestId']) if (typeof params[key] !== 'string' || !params[key].trim()) throw new BridgeError('bridge/invalid', key + ' is required');
    if (params.title !== undefined && typeof params.title !== 'string') throw new BridgeError('bridge/invalid', 'Invalid title');
  };
  const own = (client, jobId) => {
    const job = jobs.get(jobId);
    if (!job || job.client !== client) throw new BridgeError('bridge/job', 'Unknown jobId for this client');
    return job;
  };
  function launch(client, params, settings, resumeOf) {
    const existing = [...jobs.values()].find(job => job.client === client && job.requestId === params.requestId);
    if (existing) return existing;
    if (resumeOf && [...jobs.values()].some(job => job.sessionId === resumeOf && !terminal(job.status))) throw new BridgeError('bridge/busy', 'This Codex thread already has a running task');
    if (resumeOf && threadLock(resumeOf)) throw new BridgeError('codex/thread-open', THREAD_OPEN);
    const job = {
      jobId: 'codex-' + randomUUID(), client, requestId: params.requestId,
      title: params.title || summary(params.prompt, 40), prompt: params.prompt, promptSummary: summary(params.prompt, 120),
      status: 'starting', createdAt: now(), settings, activity: [], ...(resumeOf ? { resumeOf, sessionId: resumeOf } : {}),
    };
    jobs.set(job.jobId, job);
    try { runner.start(job); } catch (error) { job.status = 'failed'; job.error = error.message; job.finishedAt = now(); }
    changed();
    return job;
  }
  // Prompts, process IDs and what older versions kept stay inside; `full` adds the prompt and every action.
  const view = (job, { full = false } = {}) => {
    const { prompt, pid, cancelRequested, lastMessage, lastError, activity, offset, mode, appOpen, effectiveRead, ...rest } = job;
    return { ...rest, activity: full ? activity : activity.slice(-8), ...(full ? { prompt } : {}) };
  };
  const waitChange = ms => new Promise(resolve => { const done = () => { clearTimeout(timer); changes.off('change', done); resolve(); }; const timer = setTimeout(done, ms); changes.once('change', done); });

  const methods = {
    health: async () => ({ version: VERSION, protocol: PROTOCOL, pid: process.pid, active: [...jobs.values()].filter(job => !terminal(job.status)).length }),
    catalog: async () => catalog({ models: await models() }),
    sessions: async params => ({ sessions: sessions(params) }),
    start: async params => {
      const client = clientOf(params);
      task(params);
      return view(launch(client, params, settingsOf(params)));
    },
    // The thread keeps the model, effort, sandbox and folder it last ran with.
    resume: async params => {
      const client = clientOf(params);
      task(params);
      if (typeof params.sessionId !== 'string' || !params.sessionId.trim()) throw new BridgeError('bridge/invalid', 'sessionId is required');
      const context = threadContext(params.sessionId);
      if (!context.workspace || !fs.existsSync(context.workspace)) throw new BridgeError('bridge/workspace', 'The thread\'s folder no longer exists: ' + context.workspace);
      const settings = Object.fromEntries(Object.entries({ workspace: context.workspace, model: context.model, effort: context.effort, sandbox: context.sandbox }).filter(([, value]) => value));
      return view(launch(client, params, settings, params.sessionId));
    },
    list: async params => { const client = clientOf(params); return { cursor, jobs: [...jobs.values()].filter(job => job.client === client).map(job => view(job)) }; },
    status: async params => view(own(clientOf(params), params.jobId), { full: true }),
    // Returns once a listed job (default: the client's running ones) has ended or
    // waits on the user, or at the timeout.
    wait: async params => {
      const client = clientOf(params);
      const ids = params.jobIds?.length ? params.jobIds : [...jobs.values()].filter(job => job.client === client && !terminal(job.status)).map(job => job.jobId);
      for (const id of ids) own(client, id);
      const deadline = clock() + Math.max(0, Math.min(params.timeoutMs ?? 45000, 50000));
      const ready = () => ids.some(id => terminal(jobs.get(id).status));
      while (ids.length && !ready() && clock() < deadline) await waitChange(deadline - clock());
      return { cursor, reason: !ids.length ? 'no-active-jobs' : ready() ? 'ended' : 'timeout', jobs: ids.map(id => view(jobs.get(id), { full: terminal(jobs.get(id).status) })) };
    },
    // Long poll for live views: returns the client's jobs as soon as anything changed after `afterCursor`.
    events: async params => {
      const client = clientOf(params);
      const deadline = clock() + Math.max(0, Math.min(params.timeoutMs ?? 25000, 50000));
      while (params.afterCursor === cursor && clock() < deadline) await waitChange(deadline - clock());
      return { cursor, jobs: [...jobs.values()].filter(job => job.client === client).map(job => view(job)) };
    },
    cancel: async params => {
      const job = own(clientOf(params), params.jobId);
      if (!terminal(job.status)) { runner.cancel(job); changed(); }
      return view(job);
    },
    // A message for the turn that is running: Codex reads it before its next step.
    steer: async params => {
      const job = own(clientOf(params), params.jobId);
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new BridgeError('bridge/invalid', 'prompt is required');
      await runner.steer(job, params.prompt);
      return view(job);
    },
    // Once the app loads a thread it keeps the writer lock until it quits and
    // resume is refused meanwhile, so callers open only when the user asks to look.
    open: async params => {
      const client = clientOf(params);
      const job = params.jobId ? own(client, params.jobId) : null;
      const sessionId = job?.sessionId ?? params.sessionId;
      if (!sessionId) throw new BridgeError('bridge/open', 'This task has no thread yet');
      if (job && !terminal(job.status)) throw new BridgeError('bridge/open', 'The Codex app cannot load a thread while this run writes it; open it when the run ends');
      return codexApp.open(sessionId);
    },
  };

  function cleanup() {
    const cutoff = clock() - RETAIN_DAYS * 86400000;
    const counts = new Map();
    for (const job of [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!terminal(job.status)) continue;
      const count = (counts.get(job.client) ?? 0) + 1; counts.set(job.client, count);
      if (Date.parse(job.finishedAt ?? job.createdAt) < cutoff || count > RETAIN_PER_CLIENT) {
        jobs.delete(job.jobId);
        fs.rmSync(path.join(state, 'jobs', job.jobId), { recursive: true, force: true });
      }
    }
    save();
  }
  const ticker = setInterval(() => { if (runner.poll([...jobs.values()])) changed(); }, 500);
  const sweeper = setInterval(cleanup, 3600000);
  cleanup();
  return {
    methods,
    active: () => [...jobs.values()].some(job => !terminal(job.status)),
    runnerChanged: changed,
    close() { clearInterval(ticker); clearInterval(sweeper); clearTimeout(saveTimer); runner.close?.(); atomic(file, { jobs: [...jobs.values()] }); },
  };
}

// One service per state folder, on 127.0.0.1 with a bearer token kept in service.json.
export async function serve({ state = STATE } = {}) {
  fs.mkdirSync(state, { recursive: true });
  const lock = net.createServer();
  const pipe = '\\\\.\\pipe\\codex-bridge-' + createHash('sha256').update(path.resolve(state).toLowerCase()).digest('hex').slice(0, 16);
  try { await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(pipe, resolve); }); }
  catch { return null; }
  const infoFile = path.join(state, 'service.json');
  const previous = readJson(infoFile, {});
  const token = previous.token || randomBytes(24).toString('hex');
  const service = createService({ state });
  const instanceId = randomUUID();
  let baseUrl, lastCall = Date.now();
  const authorized = header => {
    const expected = Buffer.from('Bearer ' + token);
    const given = Buffer.from(String(header ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.headers.host !== new URL(baseUrl).host) { response.writeHead(403); return response.end('{"error":{"message":"Forbidden host"}}'); }
    if (request.headers.origin) { response.writeHead(403); return response.end('{"error":{"message":"Browser requests are not accepted"}}'); }
    if (!authorized(request.headers.authorization)) { response.writeHead(401); return response.end('{"error":{"message":"Unauthorized"}}'); }
    if (request.url !== '/api' || request.method !== 'POST') { response.writeHead(404); return response.end('{"error":{"message":"Not found"}}'); }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new BridgeError('bridge/size', 'Request too large'); }
      const call = JSON.parse(body);
      lastCall = Date.now();
      if (call.method === 'shutdown') {
        if (service.active()) throw new BridgeError('bridge/busy', 'Jobs are running');
        response.end('{"result":{"stopping":true}}'); service.close(); setTimeout(() => process.exit(0), 50); return;
      }
      if (!Object.hasOwn(service.methods, call.method)) throw new BridgeError('bridge/method', 'Unknown method ' + call.method);
      const result = call.method === 'health' ? { ...await service.methods.health(), instanceId } : await service.methods[call.method](call.params ?? {});
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.end(JSON.stringify({ error: { code: error.code ?? 'bridge/error', message: error.message } }));
    }
  });
  const listen = port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  try { await listen(Number(previous.url ? new URL(previous.url).port : 0)); } catch { await listen(0); }
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  atomic(infoFile, { url: baseUrl, token, pid: process.pid, instanceId, version: VERSION, protocol: PROTOCOL, startedAt: now() });
  // A day with no calls and nothing running: exit, and let the next caller start a fresh one.
  setInterval(() => { if (!service.active() && Date.now() - lastCall > 86400000) { service.close(); process.exit(0); } }, 600000).unref();
  console.error('codex bridge ready at ' + baseUrl);
  return { url: baseUrl, service, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!await serve()) process.exit(0);
}
