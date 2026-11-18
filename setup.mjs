// Installs this checkout as the machine's Codex bridge runtime:
// ~/.codex-bridge/runtime/<version>/, named by install.json. Callers load
// lib/client.mjs from there, so a checkout can move or change without breaking them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, STATE, VERSION, atomic, readJson } from './lib/common.mjs';
import { findCodex, standalonePath } from './lib/codex.mjs';

const targetArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (process.platform !== 'win32' || !targetArch) throw new Error('Codex Bridge needs Windows x64 or ARM64');
if (process.argv.length > 3) throw new Error('Usage: node setup.mjs [official-app-server-package.tar.zst]');
const command = (exe, args, timeout = 15000) => execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout }).trim();
const codexVersion = /^codex(?:-cli)? (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(command(findCodex(), ['--version']))?.[1];
if (!codexVersion) throw new Error('Could not identify the installed Codex CLI version');

const runtime = path.resolve(STATE, 'runtime');
fs.mkdirSync(runtime, { recursive: true });
if (fs.realpathSync(runtime).toLowerCase() !== runtime.toLowerCase()) throw new Error('Unexpected Bridge runtime directory');
const installFile = path.join(STATE, 'install.json');
const previous = readJson(installFile, {});
const versionRoot = path.join(runtime, VERSION);
const target = fs.existsSync(versionRoot) ? `${versionRoot}-${randomUUID()}` : versionRoot;
const staging = `${target}.staging-${randomUUID()}`;
function removeRuntime(folder) {
  if (!fs.existsSync(folder)) return;
  if (path.dirname(folder) !== runtime || fs.realpathSync(folder).toLowerCase() !== folder.toLowerCase()) throw new Error('Unexpected runtime cleanup path');
  fs.rmSync(folder, { recursive: true, force: true });
}

async function prepareStandalone() {
  const standalone = path.join(staging, 'app-server');
  const archiveName = `codex-app-server-package-${targetArch}-pc-windows-msvc.tar.zst`;
  const tag = `rust-v${codexVersion}`;
  const fetchedArchive = path.join(staging, archiveName);
  const archive = process.argv[2] ? path.resolve(process.argv[2]) : fetchedArchive;
  const curl = ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '10'];
  const release = JSON.parse(command('curl.exe', [...curl, `https://api.github.com/repos/openai/codex/releases/tags/${tag}`]));
  const asset = release.assets?.find(item => item.name === archiveName);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset?.digest ?? '')) throw new Error(`No verifiable Windows app-server package for Codex ${codexVersion}`);
  if (archive === fetchedArchive) {
    console.error(`Downloading OpenAI app-server ${codexVersion} for Windows ${targetArch}`);
    const url = `https://github.com/openai/codex/releases/download/${tag}/${archiveName}`;
    command('curl.exe', [...curl, '--retry', '2', '--max-time', '70', '--output', archive, url], 220000);
  }
  const sha = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) sha.update(chunk);
  if (`sha256:${sha.digest('hex')}` !== asset.digest.toLowerCase()) throw new Error('App-server package failed the release SHA-256 check');
  fs.mkdirSync(standalone);
  command('tar.exe', ['-xf', archive, '-C', standalone], 60000);
  const exe = standalonePath(staging);
  if (command(exe, ['--version']) !== `codex-app-server ${codexVersion}` || !command(exe, ['--help']).includes('--session-source')) {
    throw new Error('Installed app-server must match Codex and support --session-source');
  }
  if (archive === fetchedArchive) fs.unlinkSync(archive);
}

try {
  for (const entry of ['lib', 'service', 'docs', 'package.json', 'README.md']) {
    if (fs.existsSync(path.join(ROOT, entry))) fs.cpSync(path.join(ROOT, entry), path.join(staging, entry), { recursive: true });
  }
  await prepareStandalone();
  fs.renameSync(staging, target);
  atomic(installFile, { version: VERSION, root: target, codexVersion, installedAt: new Date().toISOString() });
} finally { removeRuntime(staging); }

// Keep this runtime and the one before it; a running service may still use that.
const keep = new Set([path.basename(target), previous.root && path.basename(previous.root)]);
for (const name of fs.readdirSync(runtime)) {
  if (!keep.has(name) && /^\d+\.\d+\.\d+(?:-[0-9a-f-]{36})?$/i.test(name)) removeRuntime(path.join(runtime, name));
}

// A running service of the same version still runs the old copy: stop it while idle.
const { connect } = await import(pathToFileURL(path.join(target, 'lib/client.mjs')).href);
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
console.log(JSON.stringify({ installed: target, version: bridge.version, codexVersion, restarted }));
