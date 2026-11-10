# Codex Bridge protocol 2

A local service that runs Codex turns for any agent, through `codex app-server`. One service per Windows user, on `127.0.0.1`.

## Finding and starting it

`~/.codex-bridge` (or `CODEX_BRIDGE_STATE_DIR`) holds the files below. It lives in the user profile, not `%LOCALAPPDATA%`: packaged apps (the Claude and Codex desktop apps) see a private copy of AppData, so state there would be invisible to other callers.

| File | What |
| --- | --- |
| `install.json` | `{ version, root }`: the installed runtime (`node setup.mjs` writes it) |
| `service.json` | `{ url, token, pid, instanceId, version, protocol }` of the running service |
| `jobs.json`, `jobs/<jobId>/` | Job records, and what Codex sent during each run (`events.jsonl`, without streaming deltas) |

A caller imports `<root>/lib/client.mjs` and calls `connect()`: it reuses a running service, starts one from that runtime when none runs, and replaces an idle service of another version. A caller that cannot run Node posts the same JSON itself:

```http
POST <url>/api
Authorization: Bearer <token>
Content-Type: application/json

{"method": "start", "params": {...}}
```

The reply is `{"result": ...}` or `{"error": {"code", "message"}}`. Requests with an `Origin` header (browsers) are refused.

## Clients

Every job method takes `client`, a short lowercase name of the caller (`agent-hub`, `dsh`, ...). A client sees and controls only its own jobs, and its `requestId`s are its own: starting again with a `requestId` the client already used returns that job instead of running twice.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `health` | — | `{ version, protocol, pid, active, instanceId }` |
| `catalog` | — | `{ models: [{ id, name, efforts, defaultEffort }], permissions, projects: [{ id, name, root }], defaults: { model, effort, permission, project } }`; models are asked from Codex (the Codex app's cache file when it cannot be asked), the rest comes from the app's own files |
| `sessions` | `query?`, `workspace?`, `limit?` | `{ sessions: [{ sessionId, createdAt, workspace, source, title }] }`, newest first |
| `start` | `client`, `requestId`, `prompt`, `title?`, `workspace` or `project`, `model?`, `effort?`, `sandbox?` | job |
| `resume` | `client`, `requestId`, `sessionId`, `prompt`, `title?` | job; the thread keeps the folder, model, effort and sandbox it last ran with. Refused with `codex/thread-open` while the Codex app has the thread loaded (see below) |
| `steer` | `client`, `jobId`, `prompt` | job; adds a message to the job's running turn, which Codex reads before its next step. Refused with `bridge/not-running` when the turn has not started yet or has ended (then `resume` the thread) |
| `list` | `client` | `{ cursor, jobs }` |
| `status` | `client`, `jobId` | the whole job, prompt and every recorded action included |
| `wait` | `client`, `jobIds?`, `timeoutMs?` (≤ 50 000) | `{ cursor, reason: ended \| timeout \| no-active-jobs, jobs }`; returns once a listed job (default: the client's running ones) has ended; ended jobs come back whole |
| `events` | `client`, `afterCursor?`, `timeoutMs?` | `{ cursor, jobs }` as soon as anything changed after `afterCursor` |
| `cancel` | `client`, `jobId` | job; Codex is asked to interrupt the turn, so the thread stays resumable |
| `open` | `client`, `jobId` or `sessionId` | shows an ended run's thread in the Codex app; refused while a run writes it |
| `shutdown` | — | stops an idle service (refused while jobs run) |

Runs are always hidden. Protocol 1's `mode` (`desktop` opened each ended run in the Codex app) is gone, and passing `mode` is refused with `bridge/invalid`.

A thread has one writer at a time: whichever process has it loaded. A run holds its thread only for the length of its turn, so an ended run's thread is free at once. The Codex app, once it has loaded a thread (through `open`, or the user opening it there), keeps the writer lock until the app quits. Switching to another thread or leaving it idle does not release it. Meanwhile `resume` of that thread is refused with `codex/thread-open`: continue it in the Codex app, or quit the app completely and resume again. A run that loses this race to the app fails with the same message. So callers `open` only when the user asks to look, and say what it costs. The lock check works on Windows; elsewhere a held thread is found only when the run fails.

`sandbox`: `read-only`, `workspace-write` or `danger-full-access`; left out, Codex's `config.toml` decides for a new thread. Runs never ask for approval (`approval_policy="never"`), since nobody can answer one; a request Codex makes anyway is turned down and shown as a warning.

A run lives in the service: when the service stops while a job runs, the job ends as `interrupted` and its thread can be resumed. `shutdown` is refused while jobs run, so an upgrade never does this.

## Job

```text
jobId, client, requestId, title, promptSummary, status, createdAt, startedAt?, finishedAt?,
sessionId? (Codex thread), resumeOf?, settings { workspace, model?, effort?, sandbox? },
activity [{ at, kind, text, status?, exitCode? }], plan? [{ text, done }],
result? (final answer), error?, usage? (the thread's token totals so far)
```

`settings` is what the run uses. A new thread gets what the caller passed, and Codex's `config.toml` fills the rest: Codex reports those values when the thread starts. A resume passes all of them, taken from the thread.

`status`: `starting`, `running`, then one of `completed`, `failed`, `cancelled`, `interrupted`. `activity.kind`: `command`, `file`, `tool`, `search`, `message`, `thinking`, `plan`, `steer`, `warning`.

Ended jobs are kept 30 days, at most 500 per client.
