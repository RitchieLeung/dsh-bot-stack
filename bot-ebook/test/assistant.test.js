import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistant, extractAnswer } from '../lib/assistant.js';

function make() {
  const created = [];
  const prompted = [];
  const waited = [];
  const agents = {
    create: async (options) => {
      created.push(options);
      return { agent: { id: options.sessionId }, dispose: async () => {} };
    },
  };
  const sessionController = {
    prompt: async (request, signal) => { prompted.push({ request, signal }); return { accepted: true }; },
    wait: async (request, signal) => {
      waited.push({ request, signal });
      return {
        reason: 'idle',
        state: { cursor: 42 },
        output: { records: [{ type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答案内容' }] } } } }] },
      };
    },
  };
  const store = () => ({ getBook: (id) => ({ book: { id, title: '测试书' } }) });
  const model = { provider: 'deepseek-official', model: 'deepseek-flash' };
  return { assistant: createAssistant({ agents, sessionController, model, store, makeId: (id, kind) => `${kind}-${id}` }), created, prompted, waited };
}

test('extractAnswer 从 records 里取出 assistant 文本', () => {
  const answer = extractAnswer([
    { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '问题' }] } } },
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段' }, { type: 'tool_use', name: 'ebook_read' }] } } } },
    { type: 'event', event: { type: 'assistant/attempt', data: { stream: [] } } },
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二段' }] } } } },
  ]);
  assert.match(answer, /第一段/);
  assert.match(answer, /第二段/);
  assert.doesNotMatch(answer, /问题/);
});

test('ensureSession 建 agent 并复用，setup 锚定本书', async () => {
  const { assistant, created } = make();
  const first = await assistant.ensureSession('b1');
  const second = await assistant.ensureSession('b1');
  assert.equal(first, second, '同一本书复用同一会话');
  assert.equal(created.length, 1);
  const options = created[0];
  assert.equal(options.agentOptions.provider, 'deepseek-official');
  assert.equal(options.agentOptions.model, 'deepseek-flash');
  assert.equal(typeof options.setup, 'function');
  // setup 应当往 scoped context 注册了系统指令
  const agentCtx = { systemPrompt: { section: (s) => { sectionCalled = s; } } };
  let sectionCalled = null;
  options.setup(agentCtx);
  assert.ok(sectionCalled, 'setup 应注册系统指令');
  assert.match(sectionCalled.text(), /测试书/);
  assert.match(sectionCalled.text(), /ebook_read/);
});

test('ask 投递问题、wait、返回答案', async () => {
  const { assistant, prompted, waited } = make();
  const result = await assistant.ask('b1', '讲了什么');
  assert.equal(result.answer, '答案内容');
  assert.equal(prompted.length, 1);
  assert.equal(prompted[0].request.content[0].text, '讲了什么');
  assert.ok(prompted[0].signal, 'prompt 必须传 signal（否则 @Remote 会抛 throwIfAborted）');
  assert.ok(waited[0].signal, 'wait 必须传 signal');
  assert.equal(waited[0].request.afterSeq, 0);
  assert.equal(waited[0].request.timeoutMs, 180000);
});
