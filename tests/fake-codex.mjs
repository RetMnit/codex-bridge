// Stands in for `codex app-server`: JSON-RPC over stdio, one message per line.
// A prompt containing "fail" fails its turn and "slow" keeps the turn running until
// it is steered or interrupted. A thread named by a file `held-<id>` in CODEX_HOME
// is refused the way Codex refuses a second writer.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const camel = name => name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
let thread, settings, slow;
const finish = (turn, text) => {
  send({ method: 'item/completed', params: { threadId: thread, item: { id: 'item_1', type: 'agentMessage', text } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } } } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
};
function open(id, params, resumed) {
  if (process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, 'held-' + id))) throw { code: -32600, message: `thread ${id} already has an active writer` };
  thread = id;
  settings = { model: params.model ?? 'gpt-config', sandbox: params.sandbox ?? 'workspace-write', approval: params.approvalPolicy, resumed };
  return { thread: { id }, model: settings.model, reasoningEffort: 'medium', sandbox: { type: camel(settings.sandbox) }, approvalPolicy: params.approvalPolicy };
}
const methods = {
  initialize: () => ({ userAgent: 'fake-codex' }),
  'model/list': () => ({ data: [{ id: 'gpt-fake', displayName: 'Fake', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }, { id: 'gpt-hidden', hidden: true }] }),
  'thread/start': params => open(randomUUID(), params, false),
  'thread/resume': params => open(params.threadId, params, true),
  'turn/start': params => {
    const turn = 'turn_' + randomUUID();
    const prompt = params.input[0].text;
    setImmediate(() => {
      send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } });
      send({ method: 'item/completed', params: { threadId: 'someone-else', item: { id: 'x', type: 'agentMessage', text: 'a sub-agent thread' } } });
      send({ method: 'item/completed', params: { threadId: thread, item: { id: 'item_0', type: 'commandExecution', command: 'echo ' + JSON.stringify({ ...settings, effort: params.effort }), status: 'completed', exitCode: 0 } } });
      if (prompt.includes('fail')) return send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'failed', error: { message: 'fake failure' } } } });
      if (prompt.includes('slow')) { slow = turn; return; }
      finish(turn, (settings.resumed ? 'resumed: ' : 'answer: ') + prompt.trim());
    });
    return { turn: { id: turn } };
  },
  'turn/steer': params => {
    if (!slow || params.expectedTurnId !== slow) throw { code: -32600, message: 'no active turn to steer' };
    const turn = slow; slow = undefined;
    setImmediate(() => finish(turn, 'steered: ' + params.input[0].text));
    return { turnId: turn };
  },
  'turn/interrupt': params => {
    slow = undefined;
    setImmediate(() => send({ method: 'turn/completed', params: { threadId: thread, turn: { id: params.turnId, status: 'interrupted' } } }));
    return {};
  },
};

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  try { send({ id: message.id, result: methods[message.method](message.params ?? {}) }); }
  catch (error) { send({ id: message.id, error: { code: error.code ?? -32601, message: error.message ?? 'unknown method' } }); }
});
lines.on('close', () => process.exit(0));
