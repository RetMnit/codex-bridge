# Codex Bridge

A local service that lets agents delegate background work to Codex. Callers can start or resume a session, steer and cancel turns, read results, and delete threads they started. New sessions live in the bridge's own Codex profile and callers view them through their own task UI.

## Install

Needs Windows, Node.js 22+, and the Codex desktop app (its bundled CLI is found automatically) or `codex` on `PATH` (override with `CODEX_BRIDGE_CODEX`).

```bash
git clone https://github.com/RetMnit/codex-bridge.git
cd codex-bridge
node setup.mjs
```

This copies the runtime to `~/.codex-bridge/runtime/<version>` and starts the service. Run it again after updating the checkout.

New background sessions use `~/.codex-bridge/worker` as their Codex home and SQLite directory. If `CODEX_BRIDGE_STATE_DIR` is set, `worker` lives under that directory. Set up a model provider in the worker's `config.toml`, or log in once for that profile. For example, with the default state directory in PowerShell:

```powershell
$previousCodexHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-bridge\worker'
    codex login
} finally {
    $env:CODEX_HOME = $previousCodexHome
}
```

Existing sessions stay in their original store and can still be resumed by ID. Finish any jobs in the old bridge before upgrading, then reload callers that cached its installed client.

## Use

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const state = path.join(os.homedir(), '.codex-bridge');
const { root } = JSON.parse(fs.readFileSync(path.join(state, 'install.json'), 'utf8'));
const { connect } = await import(pathToFileURL(path.join(root, 'lib/client.mjs')).href);

const bridge = await connect();
const job = await bridge.call('start', { client: 'my-agent', requestId: 'task-1', prompt: 'Summarize README.md', workspace: 'D:\\Project' });
const { jobs } = await bridge.call('wait', { client: 'my-agent', jobIds: [job.jobId] });
console.log(jobs[0].result);
```

Methods, parameters and the job shape are in [docs/protocol.md](docs/protocol.md).

## Test

```bash
npm test
```

Tests run a fake Codex; no model is called.
