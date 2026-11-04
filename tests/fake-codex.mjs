// Stands in for `codex exec --json`: reads the prompt from stdin and writes
// the CLI's JSONL events. A prompt containing "fail" fails, "slow" waits,
// "locked" exits the way Codex does when another writer holds the thread.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const resume = args[1] === 'resume';
const thread = resume ? args.at(-2) : randomUUID();
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes('locked')) { process.stdout.write(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }) + '\n'); process.stderr.write(`Error: thread/resume: thread/resume failed: thread ${thread} already has an active writer (code -32600)\n`); process.exit(1); }
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'thread.started', thread_id: thread });
// Like Codex, a new thread records its turn context: config.toml fills what was not passed.
if (!resume && process.env.CODEX_HOME) {
  const setting = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1).replace(/"/g, '');
  const folder = path.join(process.env.CODEX_HOME, 'sessions/2026/11/05');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `rollout-2026-11-05T00-00-00-${thread}.jsonl`), [
    { type: 'session_meta', payload: { id: thread, cwd: process.cwd(), timestamp: new Date().toISOString(), source: 'exec' } },
    { type: 'turn_context', payload: { cwd: process.cwd(), model: setting('model') ?? 'gpt-config', effort: setting('model_reasoning_effort') ?? 'medium', sandbox_policy: { type: setting('sandbox_mode') ?? 'workspace-write' } } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
}
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'echo ' + JSON.stringify(args.filter(arg => arg.includes('='))), status: 'completed', exit_code: 0 } });
if (prompt.includes('slow')) await new Promise(resolve => setTimeout(resolve, 30000));
if (prompt.includes('fail')) { emit({ type: 'turn.failed', error: { message: 'fake failure' } }); process.exit(1); }
emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: (resume ? 'resumed: ' : 'answer: ') + prompt.trim() } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
