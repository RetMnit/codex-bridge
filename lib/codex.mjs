import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { BridgeError, summary, now } from './common.mjs';

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

export function catalog() {
  let models = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'models_cache.json'), 'utf8'));
    models = (cache.models ?? []).filter(model => model.visibility !== 'hide').map(model => ({
      id: model.slug, name: model.display_name ?? model.slug,
      efforts: (model.supported_reasoning_levels ?? []).map(level => level.effort ?? level),
      defaultEffort: model.default_reasoning_level,
    }));
  } catch {}
  let defaults = {};
  try {
    const text = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    for (const key of ['model', 'model_reasoning_effort', 'sandbox_mode']) {
      const match = text.match(new RegExp('^' + key + '\\s*=\\s*"([^"]*)"', 'm'));
      if (match) defaults[key] = match[1];
    }
  } catch {}
  const { projects, selected } = projectList();
  return { models, permissions: SANDBOXES, projects, defaults: { model: defaults.model, effort: defaults.model_reasoning_effort, permission: defaults.sandbox_mode, project: selected } };
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

// The settings a thread last ran with. `codex exec resume` otherwise falls back
// to config.toml, which silently changes the sandbox of an old thread.
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

// Whoever has a thread loaded (the Codex app's app-server, or a `codex exec` run)
// holds a byte-range lock on thread-writer-locks/<id>.lock, and Codex refuses a
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

export function buildArgs({ settings, threadId }) {
  const args = ['exec'];
  if (threadId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (!threadId) args.push('-C', settings.workspace);
  // exec has no one to answer an approval prompt; a request would stall the run.
  args.push('-c', 'approval_policy="never"');
  if (settings.model) args.push('-c', `model="${settings.model}"`);
  if (settings.effort) args.push('-c', `model_reasoning_effort="${settings.effort}"`);
  if (settings.sandbox) args.push('-c', `sandbox_mode="${settings.sandbox}"`);
  if (threadId) args.push(threadId);
  args.push('-');
  return args;
}

export function openThread(threadId) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new BridgeError('codex/thread', 'Invalid Codex thread ID');
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', 'codex://threads/' + threadId], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
  return { opened: true, url: 'codex://threads/' + threadId };
}

const ACTIVITY_LIMIT = 40;
// On Windows every command arrives wrapped as `"...\powershell.exe" -Command "<script>"`;
// the script is what is worth showing.
export function commandText(command) {
  const match = String(command ?? '').match(/^"?[^"]*?(?:powershell|pwsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|\/c)\s+([\s\S]*)$/i);
  const inner = match ? match[1].trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1') : String(command ?? '');
  return summary(inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\'), 120);
}
function describe(item) {
  switch (item.type) {
    case 'command_execution': return { kind: 'command', text: commandText(item.command), status: item.status, exitCode: item.exit_code };
    case 'file_change': return { kind: 'file', text: (item.changes ?? []).map(change => `${change.kind} ${path.basename(change.path)}`).join(', ') };
    case 'mcp_tool_call': return { kind: 'tool', text: `${item.server}.${item.tool}`, status: item.status };
    case 'web_search': return { kind: 'search', text: summary(item.query, 120) };
    case 'agent_message': return { kind: 'message', text: summary(item.text, 160) };
    case 'reasoning': return { kind: 'thinking', text: summary(item.text, 160) };
    case 'todo_list': return { kind: 'plan', text: `${(item.items ?? []).filter(entry => entry.completed).length}/${(item.items ?? []).length}`, items: (item.items ?? []).map(entry => ({ text: summary(entry.text, 80), done: !!entry.completed })) };
    // An error item does not end the turn (a plugin marketplace that failed to
    // refresh, say); turn.failed does. Show it as a warning.
    case 'error': return { kind: 'warning', text: summary(item.message, 200) };
    default: return { kind: item.type, text: '' };
  }
}

// Applies one `codex exec --json` event to a job record; returns true when it changed.
export function applyEvent(job, event) {
  const at = now();
  switch (event.type) {
    case 'thread.started': job.sessionId = event.thread_id; return true;
    case 'turn.started': job.status = 'running'; job.startedAt ??= at; return true;
    case 'item.started': case 'item.updated': case 'item.completed': {
      const item = event.item ?? {};
      if (item.type === 'agent_message' && event.type === 'item.completed') job.lastMessage = item.text;
      if (item.type === 'todo_list') job.plan = describe(item).items;
      const entry = { at, id: item.id, ...describe(item) };
      const index = job.activity.findIndex(existing => existing.id && existing.id === item.id);
      if (index >= 0) job.activity[index] = entry; else job.activity.push(entry);
      if (job.activity.length > ACTIVITY_LIMIT) job.activity.splice(0, job.activity.length - ACTIVITY_LIMIT);
      job.updatedAt = at;
      return true;
    }
    case 'turn.completed':
      job.usage = event.usage; job.status = 'completed'; job.result = job.lastMessage ?? ''; job.finishedAt = at; return true;
    case 'turn.failed':
      job.status = 'failed'; job.error = event.error?.message ?? 'Codex turn failed'; job.finishedAt = at; return true;
    case 'error':
      job.activity.push({ at, kind: 'error', text: summary(event.message, 200) }); job.lastError = event.message; return true;
    default: return false;
  }
}

// `prefix` lets tests run a fake codex script under node.
export function codexRunner({ state, onChange, binary = findCodex, prefix = [] }) {
  const children = new Map();
  const files = job => ({ dir: path.join(state, 'jobs', job.jobId), events: path.join(state, 'jobs', job.jobId, 'events.jsonl'), stderr: path.join(state, 'jobs', job.jobId, 'stderr.txt') });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

  function tail(job) {
    const { events } = files(job);
    let changed = false;
    try {
      const size = fs.statSync(events).size;
      if (size > (job.offset ?? 0)) {
        const fd = fs.openSync(events, 'r');
        const buffer = Buffer.alloc(size - job.offset); fs.readSync(fd, buffer, 0, buffer.length, job.offset); fs.closeSync(fd);
        const text = buffer.toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end >= 0) {
          job.offset += Buffer.byteLength(text.slice(0, end + 1));
          for (const line of text.slice(0, end).split('\n')) {
            try { if (line.trim() && applyEvent(job, JSON.parse(line))) changed = true; } catch {}
          }
        }
      }
    } catch {}
    if (changed) effective(job);
    return changed;
  }
  // A new thread runs with whatever config.toml gives for the settings it was not
  // passed; once Codex has recorded its turn context, read those back so the job
  // shows what actually ran (a resume passes them all already).
  function effective(job) {
    if (job.resumeOf || job.effectiveRead || !job.sessionId || job.status === 'starting') return;
    let context;
    try { context = threadContext(job.sessionId); } catch { return; }
    if (!context.model) return;
    for (const key of ['model', 'effort', 'sandbox']) if (context[key] && !job.settings[key]) job.settings[key] = context[key];
    job.effectiveRead = true;
  }
  function settle(job, exitCode) {
    tail(job);
    effective(job);
    if (!['completed', 'failed'].includes(job.status)) {
      if (job.cancelRequested) job.status = 'cancelled';
      else {
        job.status = 'failed';
        let stderr = '';
        try { stderr = fs.readFileSync(files(job).stderr, 'utf8').trim().split('\n').slice(-6).join('\n'); } catch {}
        // Lost a race with the Codex app loading the thread after the resume check:
        // the writer conflict may be in stderr even when an earlier error event came first.
        job.error = /already has an active writer/.test(`${job.lastError ?? ''}\n${stderr}`) ? THREAD_OPEN : job.lastError || stderr || `Codex exited with code ${exitCode}`;
      }
      job.finishedAt = now();
    }
    delete job.pid;
    return true;
  }
  return {
    start(job) {
      const { dir, events, stderr } = files(job);
      fs.mkdirSync(dir, { recursive: true });
      const out = fs.openSync(events, 'a'); const err = fs.openSync(stderr, 'a');
      job.offset = fs.statSync(events).size;
      const args = buildArgs({ settings: job.settings, threadId: job.resumeOf });
      const child = spawn(binary(), [...prefix, ...args], { cwd: job.settings.workspace, detached: true, windowsHide: true, shell: false, stdio: ['pipe', out, err] });
      fs.closeSync(out); fs.closeSync(err);
      child.on('error', error => { job.lastError = error.message; });
      child.on('exit', code => { children.delete(job.jobId); settle(job, code); onChange(); });
      child.stdin.on('error', () => {});
      child.stdin.end(job.prompt);
      child.unref();
      children.set(job.jobId, child);
      job.pid = child.pid; job.status = 'starting';
      return job;
    },
    // Called on a timer. Survives a daemon restart: output goes to a file, not a pipe.
    poll(jobs) {
      let changed = false;
      for (const job of jobs) {
        if (!job.pid) continue;
        if (tail(job)) changed = true;
        if (!children.has(job.jobId) && !alive(job.pid)) changed = settle(job, null) || changed;
      }
      return changed;
    },
    cancel(job) {
      if (!job.pid) return false;
      job.cancelRequested = true;
      execFile('taskkill.exe', ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true }, () => {});
      return true;
    },
  };
}
