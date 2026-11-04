// Installs this checkout as the machine's Codex bridge runtime:
// ~/.codex-bridge/runtime/<version>/, named by install.json. Callers load
// lib/client.mjs from there, so a checkout can move or change without breaking them.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, STATE, VERSION, atomic, readJson } from './lib/common.mjs';

const target = path.join(STATE, 'runtime', VERSION);
const staging = target + '.staging';
fs.rmSync(staging, { recursive: true, force: true });
for (const entry of ['lib', 'service', 'docs', 'package.json', 'README.md']) {
  if (fs.existsSync(path.join(ROOT, entry))) fs.cpSync(path.join(ROOT, entry), path.join(staging, entry), { recursive: true });
}
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(staging, target);
const previous = readJson(path.join(STATE, 'install.json'), {});
atomic(path.join(STATE, 'install.json'), { version: VERSION, root: target, installedAt: new Date().toISOString() });

// Keep this runtime and the one before it; a running service may still use that.
const keep = new Set([path.basename(target), previous.root && path.basename(previous.root)]);
for (const name of fs.readdirSync(path.join(STATE, 'runtime'))) if (!keep.has(name)) fs.rmSync(path.join(STATE, 'runtime', name), { recursive: true, force: true });

// A running service of the same version still runs the old copy: stop it while idle.
const { connect } = await import(new URL('file:///' + path.join(target, 'lib/client.mjs').replaceAll('\\', '/')).href);
let restarted = false;
const info = readJson(path.join(STATE, 'service.json'), null);
if (info?.url) {
  try {
    const reply = await (await fetch(info.url + '/api', { method: 'POST', headers: { authorization: 'Bearer ' + info.token, 'content-type': 'application/json' }, body: '{"method":"shutdown"}', signal: AbortSignal.timeout(3000) })).json();
    restarted = !reply.error;
  } catch {}
}
if (restarted) await new Promise(resolve => setTimeout(resolve, 500));
const bridge = await connect();
console.log(JSON.stringify({ installed: target, version: bridge.version, restarted }));
