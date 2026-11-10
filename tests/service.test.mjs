import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'));
process.env.CODEX_HOME = path.join(temp, 'codex-home');
const THREAD = '01a1a447-735f-7c70-bc41-421df530f753';
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions/2026/11/04'), { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'sessions/2026/11/04', `rollout-2026-11-04T09-58-28-${THREAD}.jsonl`), [
  { type: 'session_meta', payload: { id: THREAD, cwd: temp, timestamp: '2026-11-04T01:58:28Z', source: 'exec' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Reply with exactly: pong' } },
  { type: 'turn_context', payload: { cwd: temp, model: 'gpt-test', effort: 'low', sandbox_policy: { type: 'read-only' } } },
].map(line => JSON.stringify(line)).join('\n') + '\n');
fs.writeFileSync(path.join(process.env.CODEX_HOME, '.codex-global-state.json'), JSON.stringify({
  'local-projects': { p1: { id: 'p1', name: 'Alpha', rootPaths: [temp] }, p2: { id: 'p2', name: 'Beta', rootPaths: [path.join(temp, 'beta')] } },
  'project-order': ['p2', 'p1'], 'selected-project': { type: 'local', projectId: 'p1' },
}));
fs.mkdirSync(path.join(temp, 'beta'));

const { createService } = await import('../service/service.mjs');
const { codexRunner, sessions, threadContext, threadLocked, commandText, THREAD_OPEN } = await import('../lib/codex.mjs');

function makeService(name, extra = {}) {
  const state = path.join(temp, name);
  let service;
  const runner = codexRunner({ state, onChange: () => service?.runnerChanged(), binary: () => process.execPath, prefix: [path.join(here, 'fake-codex.mjs')] });
  service = createService({ state, runner, ...extra });
  const call = (method, params = {}) => service.methods[method]({ client: 'alpha', ...params });
  return { service, call };
}
const base = { workspace: temp };
async function running(call, jobId) {
  for (let i = 0; i < 40 && (await call('status', { jobId })).status !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 100));
}

test('jobs run, answer, and stay with the client that started them', async t => {
  const { service, call } = makeService('run'); t.after(() => service.close());
  const one = await call('start', { ...base, prompt: 'hello', requestId: 'r1', title: 'Greeter' });
  const again = await call('start', { ...base, prompt: 'hello', requestId: 'r1' });
  assert.equal(again.jobId, one.jobId, 'the same requestId never starts a second run');
  const waited = await call('wait', { jobIds: [one.jobId], timeoutMs: 8000 });
  assert.equal(waited.reason, 'ended');
  assert.equal(waited.jobs[0].result, 'answer: hello');
  assert.equal(waited.jobs[0].prompt, 'hello', 'an ended job comes back whole');
  assert.match(waited.jobs[0].sessionId, /^[0-9a-f-]{36}$/);
  await assert.rejects(service.methods.status({ client: 'beta', jobId: one.jobId }), { code: 'bridge/job' });
  assert.deepEqual((await service.methods.list({ client: 'beta' })).jobs, []);
  assert.deepEqual(waited.jobs[0].settings, { workspace: temp, model: 'gpt-config', effort: 'medium', sandbox: 'workspace-write' }, 'what config.toml filled in is read back from the thread');
  const pinned = await call('start', { ...base, sandbox: 'read-only', prompt: 'pinned', requestId: 'r2' });
  assert.equal((await call('wait', { jobIds: [pinned.jobId], timeoutMs: 8000 })).jobs[0].settings.sandbox, 'read-only', 'a passed setting stays');
  const other = await service.methods.start({ client: 'beta', ...base, prompt: 'hello', requestId: 'r1' });
  assert.notEqual(other.jobId, one.jobId, 'request IDs are per client');
  await assert.rejects(call('start', { ...base, client: 'Bad Name', prompt: 'x', requestId: 'x' }), { code: 'bridge/client' });
});

test('settings are checked, and a Codex project means its root folder', async t => {
  const { service, call } = makeService('settings'); t.after(() => service.close());
  await assert.rejects(call('start', { workspace: path.join(temp, 'missing'), prompt: 'x', requestId: 'a' }), { code: 'bridge/invalid' });
  await assert.rejects(call('start', { ...base, sandbox: 'yolo', prompt: 'x', requestId: 'b' }), { code: 'bridge/invalid' });
  await assert.rejects(call('start', { ...base, project: 'nope', prompt: 'x', requestId: 'c' }), { code: 'bridge/invalid' });
  const job = await call('start', { project: 'p2', workspace: 'ignored', prompt: 'x', requestId: 'd' });
  assert.equal(job.settings.workspace, path.join(temp, 'beta'));
  const catalog = await call('catalog');
  assert.deepEqual(catalog.projects.map(project => project.name), ['Beta', 'Alpha']);
  assert.equal(catalog.defaults.project, 'p1');
});

test('failures and cancellations end the job with a reason', async t => {
  const { service, call } = makeService('ends'); t.after(() => service.close());
  const failed = await call('start', { ...base, prompt: 'please fail', requestId: 'f' });
  assert.equal((await call('wait', { jobIds: [failed.jobId], timeoutMs: 8000 })).jobs[0].error, 'fake failure');
  const slow = await call('start', { ...base, prompt: 'slow work', requestId: 's' });
  await running(call, slow.jobId);
  await call('cancel', { jobId: slow.jobId });
  assert.equal((await call('wait', { jobIds: [slow.jobId], timeoutMs: 10000 })).jobs[0].status, 'cancelled');
});

test('a running turn takes a message, an ended one does not', async t => {
  const { service, call } = makeService('steer'); t.after(() => service.close());
  const slow = await call('start', { ...base, prompt: 'slow work', requestId: 's' });
  await running(call, slow.jobId);
  await assert.rejects(service.methods.steer({ client: 'beta', jobId: slow.jobId, prompt: 'x' }), { code: 'bridge/job' });
  await assert.rejects(call('steer', { jobId: slow.jobId, prompt: ' ' }), { code: 'bridge/invalid' });
  const steered = await call('steer', { jobId: slow.jobId, prompt: 'use tabs' });
  assert.equal(steered.activity.at(-1).kind, 'steer');
  const ended = (await call('wait', { jobIds: [slow.jobId], timeoutMs: 8000 })).jobs[0];
  assert.equal(ended.result, 'steered: use tabs');
  assert.ok(!ended.activity.some(entry => entry.text === 'a sub-agent thread'), 'events of another thread are not this job\'s');
  await assert.rejects(call('steer', { jobId: slow.jobId, prompt: 'too late' }), { code: 'bridge/not-running' });
});

test('a job whose service stopped is interrupted, and models come from Codex', async t => {
  const state = path.join(temp, 'restart');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'jobs.json'), JSON.stringify({ jobs: [{ jobId: 'codex-old', client: 'alpha', requestId: 'o', status: 'running', createdAt: new Date().toISOString(), pid: 1, settings: { workspace: temp }, activity: [], sessionId: THREAD }] }));
  const { service, call } = makeService('restart'); t.after(() => service.close());
  const old = (await call('wait', { jobIds: ['codex-old'], timeoutMs: 3000 })).jobs[0];
  assert.equal(old.status, 'interrupted');
  assert.match(old.error, /Resume the thread/);
  assert.deepEqual((await call('catalog')).models, [{ id: 'gpt-fake', name: 'Fake', efforts: ['low', 'high'], defaultEffort: 'low' }]);
});

test('resume keeps the thread\'s own settings instead of config.toml', async t => {
  const { service, call } = makeService('resume'); t.after(() => service.close());
  assert.deepEqual(threadContext(THREAD), { workspace: temp, model: 'gpt-test', effort: 'low', sandbox: 'read-only', source: 'exec' });
  assert.equal(sessions({ query: 'pong' })[0].sessionId, THREAD);
  const job = await call('resume', { sessionId: THREAD, prompt: 'again', requestId: 'x1' });
  const waited = await call('wait', { jobIds: [job.jobId], timeoutMs: 8000 });
  assert.equal(waited.jobs[0].result, 'resumed: again');
  assert.match(waited.jobs[0].activity[0].text, /"model":"gpt-test","sandbox":"read-only","approval":"never","resumed":true,"effort":"low"/, 'Codex is told every setting again');
  assert.equal(commandText(String.raw`"C:\WINDOWS\powershell.exe" -Command "Get-Content -LiteralPath 'D:\\A B\\x.md'"`), String.raw`Get-Content -LiteralPath 'D:\A B\x.md'`);
});

test('a thread the Codex app holds is refused with a clear reason', async t => {
  const held = new Set([THREAD]);
  const { service, call } = makeService('locked', { threadLock: id => held.has(id) }); t.after(() => service.close());
  await assert.rejects(call('resume', { sessionId: THREAD, prompt: 'again', requestId: 'l1' }), { code: 'codex/thread-open', message: THREAD_OPEN });
  assert.deepEqual((await call('list')).jobs, [], 'a refused resume leaves no job behind');
  held.clear();
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'held-' + THREAD), '');
  const raced = await call('resume', { sessionId: THREAD, prompt: 'again', requestId: 'l2' });
  assert.equal((await call('wait', { jobIds: [raced.jobId], timeoutMs: 8000 })).jobs[0].error, THREAD_OPEN, 'losing the race to the app reads the same');
  fs.rmSync(path.join(process.env.CODEX_HOME, 'held-' + THREAD));
  assert.equal(threadLocked(THREAD), false, 'no lock file means free');
  fs.mkdirSync(path.join(process.env.CODEX_HOME, 'thread-writer-locks'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'thread-writer-locks', THREAD + '.lock'), '');
  assert.equal(threadLocked(THREAD), false, 'a lock file nobody holds is free');
});

test('events answer as soon as something changed', async t => {
  const { service, call } = makeService('events'); t.after(() => service.close());
  const first = await call('events', { timeoutMs: 0 });
  const pending = call('events', { afterCursor: first.cursor, timeoutMs: 8000 });
  await call('start', { ...base, prompt: 'hi', requestId: 'e' });
  const next = await pending;
  assert.ok(next.cursor > first.cursor);
  assert.equal(next.jobs.length, 1);
});

test('threads open in the Codex app only when asked, and never while a run writes them', async t => {
  const opened = [];
  const { service, call } = makeService('open', { codexApp: { open: id => { opened.push(id); return { opened: true }; } } }); t.after(() => service.close());
  await assert.rejects(call('start', { ...base, mode: 'desktop', prompt: 'x', requestId: 'm' }), { code: 'bridge/invalid' }, 'mode is gone in protocol 2');
  const slow = await call('start', { ...base, prompt: 'slow a', requestId: 'a' });
  const quick = await call('start', { ...base, prompt: 'b', requestId: 'b' });
  await call('wait', { jobIds: [quick.jobId], timeoutMs: 8000 });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(opened, [], 'an ended run is not opened by itself');
  await call('open', { jobId: quick.jobId });
  assert.deepEqual(opened, [(await call('status', { jobId: quick.jobId })).sessionId]);
  await assert.rejects(call('open', { jobId: slow.jobId }), { code: 'bridge/open' });
  await call('cancel', { jobId: slow.jobId });
  await call('wait', { jobIds: [slow.jobId], timeoutMs: 8000 });
});

// The fake Codex processes exit a moment after their jobs end, and hold the folder until then.
test.after(async () => {
  const started = Date.now();
  for (;;) {
    try { return fs.rmSync(temp, { recursive: true, force: true }); }
    catch (error) { if (Date.now() - started > 5000) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
});
