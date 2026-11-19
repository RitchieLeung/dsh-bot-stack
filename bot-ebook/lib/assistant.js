/**
 * 阅读助手：为每本书创建/复用一个真正的 agent 子会话（不是裸 LLM），
 * 用 systemPrompt 锚定本书、模型用配置的 deepseek-flash，通过 sessionController
 * 投递问题并读回回答。服务访问全部注入，便于单测。
 */

function defaultId(bookId, kind = 'session') {
  const safe = String(bookId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `ebook-assistant-${kind}-${safe}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 从 wait() 返回的 records 里，把最新的 assistant 文本拼出来（防御式）。 */
export function extractAnswer(records) {
  const list = Array.isArray(records) ? records : [];
  const parts = [];
  for (const record of list) {
    const event = record?.event;
    const type = event?.type;
    if (!type || !/assistant\/message|assistant\/attempt/.test(type)) continue;
    // 会话事件的正文在 `data.message.content`（wire 形式：{ type, seq, time, data }）。
    const blocks = event.data?.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

export function createAssistant({ agents, sessionController, model, store, cwd, makeId = defaultId }) {
  const sessions = new Map(); // bookId -> sessionId
  const cursors = new Map(); // bookId -> last seen seq

  async function ensureSession(bookId) {
    const existing = sessions.get(bookId);
    if (existing) return existing;
    const book = store().getBook(bookId);
    const sessionId = makeId(bookId, 'session');
    await agents.create({
      sessionId,
      meta: cwd ? { cwd } : {},
      agentOptions: { provider: model.provider, model: model.model },
      setup: (agentCtx) => {
        agentCtx.systemPrompt.section({
          name: 'ebook-assistant',
          order: 9000,
          text: () => `你是电子书《${book.book.title}》的阅读助手。回答用户关于这本书的问题时，先用 ebook_list / ebook_read / ebook_search 检索原文，再基于原文回答，不要编造书里没有的内容。引用原文出处时用「§N」形式，N 就是 ebook_read / ebook_search 返回的那个 idx（从 0 开始的章节序号），方便用户点引用跳回原章。只回答关于这本书的内容。`,
        });
      },
    });
    sessions.set(bookId, sessionId);
    cursors.set(bookId, 0);
    return sessionId;
  }

  async function ask(bookId, question) {
    const sessionId = await ensureSession(bookId);
    const afterSeq = cursors.get(bookId) || 0;
    // prompt / wait 都是 @Remote 方法，第二个参数 signal 必传（缺了会抛 throwIfAborted）。
    const controller = new AbortController();
    const signal = controller.signal;
    await sessionController.prompt({
      requestId: makeId(bookId, 'req'),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: question }],
    }, signal);
    const result = await sessionController.wait({ sessionId, afterSeq, timeoutMs: 180000 }, signal);
    if (result?.state?.cursor) cursors.set(bookId, result.state.cursor);
    const answer = extractAnswer(result?.output?.records);
    return {
      answer: answer || '（助手没有给出回答）',
      reason: result?.reason,
      sessionId,
    };
  }

  return { ensureSession, ask };
}
