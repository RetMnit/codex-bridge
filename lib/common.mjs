import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const PROTOCOL = 2;
// The user profile, not %LOCALAPPDATA%: packaged apps (the Claude and Codex desktop apps)
// see a private copy of AppData, so a service state there is invisible to other apps.
export const STATE = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), '.codex-bridge');

export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const terminal = status => TERMINAL.has(status);
export const now = () => new Date().toISOString();
export const summary = (text, length = 80) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? flat.slice(0, length - 1) + '…' : flat;
};
export const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (fallback !== undefined && error.code === 'ENOENT') return fallback; throw error; }
};
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
// A caller names itself (`agent-hub`, `dsh`, ...) and sees only its own jobs.
export function clientOf(params) {
  const id = params?.client;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(id)) throw new BridgeError('bridge/client', 'client must be a short lowercase caller name');
  return id;
}
