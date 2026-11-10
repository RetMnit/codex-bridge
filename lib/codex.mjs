import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { BridgeError, summary, now, terminal } from './common.mjs';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

// The Codex desktop app ships its CLI under %LOCALAPPDATA%\OpenAI\Codex\bin\<build>;
// a standalone install puts codex on PATH. Newest app build wins.
export function findCodex() {
  if (process.env.CODEX_BRIDGE_CODEX) return process.env.CODEX_BRIDGE_CODEX;
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['codex.exe', 'codex.cmd', 'codex']) {
      const file = path.join(directory, name);
      if (directory && fs.existsSync(file)) return file;
    }
  }
  const bin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI/Codex/bin');
  const builds = fs.existsSync(bin) ? fs.readdirSync(bin).map(name => path.join(bin, name, 'codex.exe')).filter(file => fs.existsSync(file)) : [];
  builds.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!builds.length) throw new BridgeError('codex/missing', 'Codex CLI was not found (install the Codex app, or set CODEX_BRIDGE_CODEX)');
  return builds[0];
}

// The Codex app's cached model list, for when Codex itself cannot be asked.
function cachedModels() {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'models_cache.json'), 'utf8'));
    return (cache.models ?? []).filter(model => model.visibility !== 'hide').map(model => ({
      id: model.slug, name: model.display_name ?? model.slug,
      efforts: (model.supported_reasoning_levels ?? []).map(level => level.effort ?? level),
      defaultEffort: model.default_reasoning_level,
    }));
  } catch { return []; }
}
// `models` is Codex's own answer (modelList); left out, the app's cache file stands in.
export function catalog({ models } = {}) {
  let defaults = {};
  try {
    const text = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    for (const key of ['model', 'model_reasoning_effort', 'sandbox_mode']) {
      const match = text.match(new RegExp('^' + key + '\\s*=\\s*"([^"]*)"', 'm'));
      if (match) defaults[key] = match[1];
    }
  } catch {}
  const { projects, selected } = projectList();
  return { models: models ?? cachedModels(), permissions: SANDBOXES, projects, defaults: { model: defaults.model, effort: defaults.model_reasoning_effort, permission: defaults.sandbox_mode, project: selected } };
}

// The Codex app's own project list (sidebar order) and the project it has selected.
export function projectList() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, '.codex-global-state.json'), 'utf8'));
    const local = state['local-projects'] ?? {};
    const order = [...(state['project-order'] ?? []), ...Object.keys(local)].filter((id, index, all) => local[id] && all.indexOf(id) === index);
    const projects = order.map(id => ({ id, name: local[id].name, root: local[id].rootPaths?.[0] })).filter(project => project.root);
    const selected = state['selected-project']?.type === 'local' ? state['selected-project'].projectId : undefined;
    return { projects, selected: projects.some(project => project.id === selected) ? selected : projects[0]?.id };
  } catch { return { projects: [], selected: undefined }; }
}

function rollouts() {
  const root = path.join(CODEX_HOME, 'sessions');
  const files = [];
  const walk = (directory, depth) => {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
    }
  };
  walk(root, 0);
  // File names start with the creation time, so a name sort is a time sort.
  return files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}
function readLines(file, maxBytes = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size); fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8').split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
  } finally { fs.closeSync(fd); }
}
const sandboxName = policy => typeof policy === 'string' ? policy : policy?.type;

// The settings a thread last ran with. A resume passes them back explicitly, so
// neither config.toml nor a default that comes with another setting can change them.
export function threadContext(threadId) {
  const file = rollouts().find(name => name.endsWith(threadId + '.jsonl'));
  if (!file) throw new BridgeError('codex/unknown-thread', 'No Codex session file for thread ' + threadId);
  let meta, context;
  for (const line of readLines(file, 64 * 1024 * 1024)) {
    if (line.type === 'session_meta') meta = line.payload;
    if (line.type === 'turn_context') context = line.payload;
  }
  return { workspace: context?.cwd ?? meta?.cwd, model: context?.model, effort: context?.effort, sandbox: sandboxName(context?.sandbox_policy), source: meta?.source };
}

// Whoever has a thread loaded (the Codex app's app-server, or one of ours during a
// run) holds a byte-range lock on thread-writer-locks/<id>.lock, and Codex refuses a
// second writer. The app keeps the lock while the thread stays loaded; quitting
// the app releases it. A held lock makes reading the file fail with EBUSY.
export const THREAD_OPEN = 'The Codex app has this thread loaded and holds its writer lock, so it cannot be resumed here. Continue it in the Codex app, or quit the Codex app completely and resume again.';
export function threadLocked(threadId) {
  let fd;
  try { fd = fs.openSync(path.join(CODEX_HOME, 'thread-writer-locks', threadId + '.lock'), 'r'); } catch { return false; }
  try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); return false; }
  catch (error) { return error.code === 'EBUSY'; }
  finally { fs.closeSync(fd); }
}

export function sessions({ query, workspace, limit = 20 } = {}) {
  const found = [];
  for (const file of rollouts()) {
    if (found.length >= limit) break;
    let meta, prompt;
    for (const line of readLines(file, 512 * 1024)) {
      if (line.type === 'session_meta') meta = line.payload;
      if (line.type === 'event_msg' && line.payload?.type === 'user_message' && !prompt) { prompt = line.payload.message; break; }
    }
    if (!meta?.id) continue;
    if (workspace && path.resolve(meta.cwd ?? '').toLowerCase() !== path.resolve(workspace).toLowerCase()) continue;
    if (query && !`${prompt ?? ''} ${meta.cwd ?? ''}`.toLowerCase().includes(String(query).toLowerCase())) continue;
    found.push({ sessionId: meta.id, createdAt: meta.timestamp, workspace: meta.cwd, source: meta.source, title: summary(prompt, 60) });
  }
  return found;
}

export function openThread(threadId) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new BridgeError('codex/thread', 'Invalid Codex thread ID');
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', 'codex://threads/' + threadId], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
  return { opened: true, url: 'codex://threads/' + threadId };
}

// ---------- codex app-server ----------

// One `codex app-server` process: JSON-RPC over stdio, one message per line.
// `record` gets every raw line Codex sends except streaming deltas.
export function appServer({ exe, prefix = [], cwd, stderr = 'ignore', record }) {
  const child = spawn(exe, [...prefix, 'app-server'], { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', stderr] });
  const pending = new Map();
  let buffer = '', next = 0, closed = false;
  const server = { pid: child.pid, onNotification() {}, onRequest() {}, onExit() {} };
  const write = message => { if (!closed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const end = reason => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new BridgeError('codex/exited', reason)); }
    pending.clear();
    server.onExit(reason);
  };
  child.stdin.on('error', () => {});
  child.on('error', error => end(error.message));
  child.on('exit', code => end('Codex exited with code ' + code));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      try {
        if (message.method === undefined) {
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          pending.delete(message.id); clearTimeout(waiter.timer);
          if (message.error) waiter.reject(Object.assign(new BridgeError('codex/rpc', message.error.message), { rpcCode: message.error.code }));
          else waiter.resolve(message.result ?? {});
          continue;
        }
        if (!/delta$/i.test(message.method)) record?.(line);
        if (message.id === undefined) server.onNotification(message.method, message.params ?? {});
        else server.onRequest(message.id, message.method, message.params ?? {});
      } catch {}
    }
  });
  server.call = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    if (closed) return reject(new BridgeError('codex/exited', 'Codex is not running'));
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError('codex/timeout', `Codex did not answer ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
  server.notify = (method, params = {}) => write({ method, params });
  server.respond = (id, result) => write({ id, result });
  server.refuse = (id, message) => write({ id, error: { code: -32601, message } });
  server.start = async () => {
    await server.call('initialize', { clientInfo: { name: 'codex-bridge', version: '1' } });
    server.notify('initialized');
  };
  // Closing stdin lets Codex release the thread and exit; whatever lingers is killed with its children.
  server.close = () => {
    if (child.exitCode !== null || child.signalCode) return;
    try { child.stdin.end(); } catch {}
    const timer = setTimeout(() => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}), 2000);
    child.once('exit', () => clearTimeout(timer));
  };
  return server;
}

// The models Codex offers this account, asked from Codex itself (no model call).
export async function modelList({ binary = findCodex, prefix = [] } = {}) {
  const server = appServer({ exe: binary(), prefix });
  try {
    await server.start();
    const models = [];
    let cursor;
    do {
      const page = await server.call('model/list', cursor ? { cursor } : {});
      models.push(...(page.data ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return models.filter(model => !model.hidden).map(model => ({
      id: model.id, name: model.displayName ?? model.id,
      efforts: (model.supportedReasoningEfforts ?? []).map(option => option.reasoningEffort ?? option),
      defaultEffort: model.defaultReasoningEffort,
    }));
  } finally { server.close(); }
}

const ACTIVITY_LIMIT = 40;
const SANDBOX_OF = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' };
// On Windows every command arrives wrapped as `"...\powershell.exe" -Command "<script>"`;
// the script is what is worth showing.
export function commandText(command) {
  const match = String(command ?? '').match(/^"?[^"]*?(?:powershell|pwsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|\/c)\s+([\s\S]*)$/i);
  const inner = match ? match[1].trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1') : String(command ?? '');
  return summary(inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\'), 120);
}
function describe(item) {
  switch (item.type) {
    case 'commandExecution': return { kind: 'command', text: commandText(item.command), status: item.status, exitCode: item.exitCode ?? undefined };
    case 'fileChange': return { kind: 'file', text: (item.changes ?? []).map(change => `${change.kind?.type ?? 'change'} ${path.basename(change.path)}`).join(', '), status: item.status };
    case 'mcpToolCall': return { kind: 'tool', text: `${item.server}.${item.tool}`, status: item.status };
    case 'webSearch': return { kind: 'search', text: summary(item.query, 120) };
    case 'agentMessage': { const text = summary(item.text, 160); return text ? { kind: 'message', text } : null; }
    case 'reasoning': { const text = summary((item.summary ?? []).join(' '), 160); return text ? { kind: 'thinking', text } : null; }
    default: return null;
  }
}

// Applies one app-server notification to a job record; returns true when the job changed.
export function applyNotification(job, method, params) {
  const at = now();
  const note = entry => {
    const index = entry.id ? job.activity.findIndex(existing => existing.id === entry.id) : -1;
    if (index >= 0) job.activity[index] = entry; else job.activity.push(entry);
    if (job.activity.length > ACTIVITY_LIMIT) job.activity.splice(0, job.activity.length - ACTIVITY_LIMIT);
    job.updatedAt = at;
    return true;
  };
  switch (method) {
    case 'turn/started': job.status = 'running'; job.startedAt ??= at; return true;
    case 'item/started': case 'item/completed': {
      const item = params.item ?? {};
      const done = method === 'item/completed';
      if (item.type === 'agentMessage' && done) job.lastMessage = item.text;
      // Messages and reasoning have no text until they complete.
      if (!done && ['agentMessage', 'reasoning'].includes(item.type)) return false;
      const entry = describe(item);
      return entry ? note({ at, id: item.id, ...entry }) : false;
    }
    case 'turn/plan/updated': {
      const steps = params.plan ?? [];
      job.plan = steps.map(step => ({ text: summary(step.step, 80), done: step.status === 'completed' }));
      return note({ at, id: 'plan', kind: 'plan', text: `${job.plan.filter(step => step.done).length}/${steps.length}` });
    }
    case 'thread/tokenUsage/updated': {
      const total = params.tokenUsage?.total;
      if (total) job.usage = { input_tokens: total.inputTokens, cached_input_tokens: total.cachedInputTokens, output_tokens: total.outputTokens, reasoning_output_tokens: total.reasoningOutputTokens };
      return false;
    }
    case 'error': {
      const message = params.error?.message ?? 'Codex error';
      if (params.willRetry) return note({ at, kind: 'warning', text: summary(message, 200) });
      job.lastError = message;
      return false;
    }
    case 'warning': case 'configWarning': {
      const text = summary(params.message ?? params.summary, 200);
      return text ? note({ at, kind: 'warning', text }) : false;
    }
    case 'turn/completed': {
      const turn = params.turn ?? {};
      if (turn.status === 'completed') { job.status = 'completed'; job.result = job.lastMessage ?? ''; }
      else if (turn.status === 'interrupted') {
        job.status = job.cancelRequested ? 'cancelled' : 'interrupted';
        if (!job.cancelRequested) job.error = 'Codex interrupted this turn';
      } else { job.status = 'failed'; job.error = turn.error?.message ?? job.lastError ?? 'Codex turn failed'; }
      job.finishedAt = at;
      return true;
    }
    default: return false;
  }
}

// What Codex may ask its client mid-turn. Runs use approval_policy "never", so these
// should not come; one that does is turned down instead of stalling the turn.
const REFUSALS = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {} },
  'mcpServer/elicitation/request': { action: 'decline' },
  'item/tool/requestUserInput': { answers: {} },
};
const STOPPED = 'The bridge service stopped during this run. Resume the thread to continue.';
const NO_TURN = 'This task has no running turn to steer. If it has ended, resume its thread instead.';

// One app-server process per job, for the length of its turn: Codex keeps a
// thread's writer lock while a process has it loaded, so the process ends with
// the turn. `prefix` lets tests run a fake codex script under node.
export function codexRunner({ state, onChange, binary = findCodex, prefix = [] }) {
  const live = new Map(); // jobId -> { server, threadId, turnId }
  const folder = job => path.join(state, 'jobs', job.jobId);

  function finish(job, fields) {
    const run = live.get(job.jobId);
    live.delete(job.jobId);
    if (!terminal(job.status)) Object.assign(job, { finishedAt: now() }, fields);
    delete job.pid;
    run?.server.close();
    onChange();
  }
  function stderrTail(job) {
    try { return fs.readFileSync(path.join(folder(job), 'stderr.txt'), 'utf8').trim().split('\n').slice(-6).join('\n'); } catch { return ''; }
  }
  function fail(job, message) {
    if (job.cancelRequested) return finish(job, { status: 'cancelled' });
    const detail = `${message ?? ''}\n${job.lastError ?? ''}\n${stderrTail(job)}`;
    // The Codex app loaded the thread after the resume check.
    finish(job, { status: 'failed', error: /already has an active writer/.test(detail) ? THREAD_OPEN : job.lastError || message || stderrTail(job) || 'Codex stopped unexpectedly' });
  }
  async function run(job, server, record) {
    const entry = live.get(job.jobId);
    const settings = job.settings;
    server.onExit = reason => { record.end(); if (live.get(job.jobId) === entry) fail(job, reason); };
    server.onRequest = (id, method) => {
      if (REFUSALS[method]) server.respond(id, REFUSALS[method]); else server.refuse(id, 'not supported by codex-bridge');
      job.activity.push({ at: now(), kind: 'warning', text: 'Refused a request from Codex: ' + method });
      onChange();
    };
    server.onNotification = (method, params) => {
      // Codex's own sub-agents report on their own threads.
      if (params.threadId && entry.threadId && params.threadId !== entry.threadId) return;
      if (method === 'turn/started' && params.turn?.id) entry.turnId = params.turn.id;
      if (!applyNotification(job, method, params)) return;
      if (terminal(job.status)) finish(job); else onChange();
    };
    await server.start();
    const thread = { cwd: settings.workspace, approvalPolicy: 'never', ...(settings.model ? { model: settings.model } : {}), ...(settings.sandbox ? { sandbox: settings.sandbox } : {}) };
    const reply = job.resumeOf ? await server.call('thread/resume', { threadId: job.resumeOf, ...thread }) : await server.call('thread/start', thread);
    entry.threadId = job.sessionId = reply.thread?.id ?? job.resumeOf;
    // What the caller left out is what Codex's config.toml gave the thread.
    settings.model ??= reply.model;
    settings.effort ??= reply.reasoningEffort ?? undefined;
    const sandbox = SANDBOX_OF[reply.sandbox?.type];
    settings.sandbox ??= sandbox;
    if (sandbox && sandbox !== settings.sandbox) job.activity.push({ at: now(), kind: 'warning', text: `Codex runs this thread as ${sandbox}, not ${settings.sandbox}` });
    onChange();
    const turn = await server.call('turn/start', { threadId: entry.threadId, input: [{ type: 'text', text: job.prompt }], ...(settings.effort ? { effort: settings.effort } : {}) });
    entry.turnId ??= turn.turn?.id;
  }
  return {
    start(job) {
      fs.mkdirSync(folder(job), { recursive: true });
      const record = fs.createWriteStream(path.join(folder(job), 'events.jsonl'), { flags: 'a' });
      const stderr = fs.openSync(path.join(folder(job), 'stderr.txt'), 'a');
      let server;
      try { server = appServer({ exe: binary(), prefix, cwd: job.settings.workspace, stderr, record: line => record.write(line + '\n') }); }
      finally { fs.closeSync(stderr); }
      live.set(job.jobId, { server });
      job.pid = server.pid; job.status = 'starting';
      run(job, server, record).catch(error => { if (live.has(job.jobId)) fail(job, error.message); });
      return job;
    },
    // A job without its process here was running when an earlier service stopped.
    poll(jobs) {
      let changed = false;
      for (const job of jobs) {
        if (terminal(job.status) || live.has(job.jobId)) continue;
        Object.assign(job, { status: 'interrupted', error: STOPPED, finishedAt: now() });
        delete job.pid;
        changed = true;
      }
      return changed;
    },
    // Adds a message to the running turn; Codex reads it before its next step.
    async steer(job, text) {
      const entry = live.get(job.jobId);
      if (!entry?.turnId || job.status !== 'running') throw new BridgeError('bridge/not-running', NO_TURN);
      try { await entry.server.call('turn/steer', { threadId: entry.threadId, expectedTurnId: entry.turnId, input: [{ type: 'text', text }] }); }
      catch (error) { throw error.rpcCode === -32600 ? new BridgeError('bridge/not-running', NO_TURN) : error; }
      job.activity.push({ at: now(), kind: 'steer', text: summary(text, 160) });
      onChange();
    },
    // Asks Codex to stop the turn, which leaves the thread clean; a process that does not answer is killed.
    cancel(job) {
      const entry = live.get(job.jobId);
      job.cancelRequested = true;
      if (!entry) return false;
      if (!entry.turnId) { finish(job, { status: 'cancelled' }); return true; }
      entry.server.call('turn/interrupt', { threadId: entry.threadId, turnId: entry.turnId }).catch(() => {});
      setTimeout(() => { if (live.get(job.jobId) === entry) finish(job, { status: 'cancelled' }); }, 3000);
      return true;
    },
    models: () => modelList({ binary, prefix }),
    // The service is going away: its Codex processes go with it.
    close() { for (const entry of live.values()) entry.server.close(); live.clear(); },
  };
}
