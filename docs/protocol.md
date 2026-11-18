# Codex Bridge protocol 2

A local service that runs Codex turns for any agent, through `codex app-server`. One service per Windows user, on `127.0.0.1`.

## Finding and starting it

`~/.codex-bridge` (or `CODEX_BRIDGE_STATE_DIR`) holds the files below. It lives in the user profile, not `%LOCALAPPDATA%`: packaged apps (the Claude and Codex desktop apps) see a private copy of AppData, so state there would be invisible to other callers.

| File | What |
| --- | --- |
| `install.json` | `{ version, root }`: the installed runtime (`node setup.mjs` writes it) |
| `service.json` | `{ url, token, pid, instanceId, version, protocol }` of the running service |
| `jobs.json`, `jobs/<jobId>/` | Job records, and what Codex sent during each run (`events.jsonl`, without streaming deltas) |
| `worker/` | Codex home and SQLite directory for new background sessions, with its own configuration and authentication |

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
| `health` | — | `{ version, protocol, pid, active, instanceId, isolatedStarts }`. `isolatedStarts: true` identifies a service that creates new sessions in the worker store |
| `catalog` | — | `{ models: [{ id, name, efforts, defaultEffort }], permissions, projects: [{ id, name, root }], defaults: { model, effort, permission, project } }`. Models and execution defaults come from the worker profile. Project paths come from the Desktop profile |
| `sessions` | `client?`, `query?`, `workspace?`, `limit?` | `{ sessions: [{ sessionId, createdAt, workspace, source, originator, title, deletable? }] }` from both stores, newest first. `query` matches the first prompt and the folder. With `client`, `deletable` says whether that client may `delete` the thread |
| `start` | `client`, `requestId`, `prompt`, `title?`, `workspace` or `project`, `model?`, `effort?`, `sandbox?` | job |
| `resume` | `client`, `requestId`, `sessionId`, `prompt`, `title?` | Job. The thread keeps its store, folder, model, effort and sandbox. Refused with `codex/thread-open` if another writer holds it |
| `steer` | `client`, `jobId`, `prompt` | job; adds a message to the job's running turn, which Codex reads before its next step. Refused with `bridge/not-running` when the turn has not started yet or has ended (then `resume` the thread) |
| `list` | `client` | `{ cursor, jobs }` |
| `status` | `client`, `jobId` | the whole job, prompt and every recorded action included |
| `wait` | `client`, `jobIds?`, `timeoutMs?` (≤ 50 000) | `{ cursor, reason: ended \| timeout \| no-active-jobs, jobs }`; returns once a listed job (default: the client's running ones) has ended; ended jobs come back whole |
| `events` | `client`, `afterCursor?`, `timeoutMs?` | `{ cursor, jobs }` as soon as anything changed after `afterCursor` |
| `cancel` | `client`, `jobId` | job; Codex is asked to interrupt the turn, so the thread stays resumable |
| `open` | — | Returns `bridge/open` for older clients that still offer this action. Use `status` or the calling agent's task UI to view the run |
| `delete` | `client`, `sessionIds` (1–100) | `{ deleted: [sessionId], errors: [{ sessionId, code, message }] }`; deletes threads through Codex, and the bridge's records of them (see below) |
| `shutdown` | — | stops an idle service (refused while jobs run) |

New threads are stored under `worker/`, separate from the Desktop session library. Pre-upgrade threads stay in their original library. Session lookup checks the worker first, then the original library. The installed client refuses `start` with `bridge/upgrade-pending` if it is still connected to a pre-upgrade service with active jobs.

One process can write to a thread at a time. For sessions in the original library, an open Desktop chat can hold the writer lock after the turn ends. Release it in Desktop or quit Desktop fully before resuming through the bridge. A background thread can also be held by a separate Codex process using the worker profile. The lock check works on Windows. If another writer wins the race, Codex refuses the resume and the bridge reports the conflict.

`sandbox`: `read-only`, `workspace-write` or `danger-full-access`; left out, Codex's `config.toml` decides for a new thread. Runs never ask for approval (`approval_policy="never"`), since nobody can answer one; a request Codex makes anyway is turned down and shown as a warning.

`delete` removes a thread through Codex from its original store. The bridge drops every job record for it. A client may delete a thread it started. Once those records are pruned, it may delete a bridge-created thread (`originator` `codex-bridge`) that no other client has records of. Threads the user started in the Codex app, or only resumed through the bridge, are refused with `bridge/not-owner`. Other per-thread errors include `bridge/busy` while a task runs, `codex/thread-open` while another writer holds the thread, and `codex/thread-forked` while a fork exists. Threads deleted together are ordered so a fork goes first.

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
