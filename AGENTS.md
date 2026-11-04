# Codex Bridge — shared Codex task service

- `lib/codex.mjs`: everything about the Codex CLI and app files (finding the CLI, models, projects, threads, `codex exec` arguments and events). `service/service.mjs`: the job service. `lib/client.mjs`: what callers import from the installed runtime. `docs/protocol.md` is the contract; change it together with the code and keep `PROTOCOL` in `lib/common.mjs` for breaking changes only.
- Callers are agents (Claude's Agent Hub now; a DSH adapter can follow). Nothing caller-specific belongs here: no per-session settings, panes or wake-ups. Each caller passes its own `client` name and namespaces nothing else.
- Resumes must keep the thread's last folder, model, effort and sandbox (`threadContext`); `codex exec resume` would fall back to `config.toml`. Runs use `approval_policy="never"`.
- Runs are always hidden; nothing opens the Codex app by itself. A loaded thread keeps the app's writer lock until the app quits, so an automatic open would cost every later resume. `open` is for when the user asks to look, and never for a running thread (the app reports it open elsewhere and stays stuck). `resume` checks the lock (`threadLocked`) and refuses with `codex/thread-open` instead of starting a run that would fail.
- Run output goes to files, not pipes, so jobs survive a service restart. Never kill a running job to upgrade: `shutdown` is refused while jobs run.
- Tests use `tests/fake-codex.mjs`; never call a real model from tests. `npm test`, then `node setup.mjs` to install the runtime callers load.
- Release through Git tags once published; do not move tags or force push. No user-specific absolute paths in sources.
