# Codex Bridge

A local service that lets agents delegate background work to Codex. Callers can start or resume a session, steer and cancel turns, read results, and delete threads they started. New sessions share the existing Codex profile and are tagged as `appServer`, which keeps them out of Desktop's default recent list.

## Install

Needs Windows, Node.js 22+, and the Codex desktop app (its bundled CLI is found automatically) or `codex` on `PATH` (override with `CODEX_BRIDGE_CODEX`).

```bash
git clone https://github.com/RetMnit/codex-bridge.git
cd codex-bridge
node setup.mjs
```

Setup downloads and verifies the official standalone app-server for the installed Codex version, then installs the Bridge runtime and starts the service. Run setup again after updating Bridge or Codex to keep the app-server version matched. If you already downloaded the matching official Windows `codex-app-server-package-*.tar.zst`, pass its path to `node setup.mjs` to reuse it. Setup still checks its checksum against the GitHub release.

New tasks reuse the existing Codex login and model configuration. Sessions created by Bridge 0.5.0 in `~/.codex-bridge/worker` can still be resumed by ID using their original profile. Finish any jobs in the old bridge before upgrading, then reload callers that cached its installed client.

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
