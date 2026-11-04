// What a caller imports from the installed runtime (see docs/protocol.md):
//   const { root } = JSON.parse(fs.readFileSync(path.join(stateDir, 'install.json'), 'utf8'))
//   const { connect } = await import(pathToFileURL(path.join(root, 'lib/client.mjs')).href)
//   const bridge = await connect()
//   await bridge.call('start', { client: 'my-agent', requestId, prompt, workspace })
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, STATE, VERSION, PROTOCOL, BridgeError, readJson } from './common.mjs';

async function request(info, method, params, timeoutMs) {
  const response = await fetch(info.url + '/api', {
    method: 'POST', headers: { authorization: 'Bearer ' + info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(timeoutMs),
  });
  const reply = await response.json();
  if (reply.error) throw new BridgeError(reply.error.code ?? 'bridge/error', reply.error.message);
  return reply.result;
}
async function probe(state) {
  const info = readJson(path.join(state, 'service.json'), null);
  if (!info?.url) return null;
  try {
    const health = await request(info, 'health', {}, 1500);
    if (health.instanceId === info.instanceId) return { ...info, health };
  } catch {}
  return null;
}
function launch(state) {
  fs.mkdirSync(path.join(state, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(state, 'logs', 'service.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'service/service.mjs')], {
    detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, CODEX_BRIDGE_STATE_DIR: state },
  });
  child.unref(); fs.closeSync(log);
}

// Connects to the service, starting it from this runtime when none runs. A
// service of another version is replaced while it has nothing running.
export async function connect({ state = STATE, start = true } = {}) {
  let info = await probe(state);
  if (info && info.health.version !== VERSION && !info.health.active) {
    try { await request(info, 'shutdown', {}, 3000); } catch {}
    for (let i = 0; i < 30 && await probe(state); i++) await new Promise(resolve => setTimeout(resolve, 100));
    info = null;
  }
  if (!info) {
    if (!start) throw new BridgeError('bridge/offline', 'The Codex bridge service is not running');
    launch(state);
    for (let i = 0; i < 80 && !info; i++) { await new Promise(resolve => setTimeout(resolve, 100)); info = await probe(state); }
    if (!info) throw new BridgeError('bridge/offline', 'The Codex bridge service did not start; see ' + path.join(state, 'logs', 'service.log'));
  }
  if (info.health.protocol !== PROTOCOL) throw new BridgeError('bridge/protocol', `Codex bridge protocol ${info.health.protocol} running; this client speaks ${PROTOCOL}`);
  return {
    version: info.health.version,
    // Long polls (wait, events) get their own time on top of the server's.
    call: (method, params = {}) => request(info, method, params, ['wait', 'events'].includes(method) ? 60000 : 30000),
  };
}
