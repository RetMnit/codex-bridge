# Codex Bridge

A small local service that lets any agent hand work to OpenAI Codex: start Codex turns (through `codex app-server`), resume earlier threads with their original settings, add a message to a running turn, watch progress, wait for answers and cancel. Runs are hidden; a thread opens in the Codex app only on request, since the app then keeps it locked against resumes until it quits. Each caller sees only its own jobs.

## Install

Needs Windows, Node.js 22+, and the Codex desktop app (its bundled CLI is found automatically) or `codex` on `PATH` (override with `CODEX_BRIDGE_CODEX`).

```bash
git clone https://github.com/RetMnit/codex-bridge.git
cd codex-bridge
node setup.mjs
```

This copies the runtime to `~/.codex-bridge/runtime/<version>` and starts the service. Run it again after updating the checkout.

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
