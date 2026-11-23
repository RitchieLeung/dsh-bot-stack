/**
 * Host half of the ebook module.
 *
 * Registers one HTTP route (`/api/bot-ebook`) that the panel talks to, and the
 * model-facing tools that let a Bot read the shelf. The library lives in
 * `~/.dsh/bot/ebook/ebook.sqlite`.
 *
 * 通用采集 + 阅读助手在这里接线：注入 `llm`（模型转换）/ `web`（网页抓取）/
 * `agents` + `sessionController`（助手 agent 会话），组装成 ingest / assistant /
 * models 三块，交给纯函数 handler 路由。
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openEbookStore } from './store.js';
import { createEbookHandler } from './handler.js';
import { chunkText, convertToBook, extractWebBody, splitMarkdownChapters, splitPlainChapters } from './ingest.js';
import { createAssistant } from './assistant.js';
import { extractPdfText } from './pdf.js';
import { extractEpubBook } from './epub.js';

// Cordis 要求先声明才能碰这些服务：少了任一行，冷启动时 entry 直接激活失败。
export const inject = ['connection', 'llm', 'web', 'agents', 'sessionController'];

/** Where the library and its database live; overridable for tests. */
export function ebookPaths(config = {}) {
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), '.dsh');
  return {
    dbPath: config.dbPath || path.join(home, 'bot', 'ebook', 'ebook.sqlite'),
  };
}

/** Cap a chapter for model-facing output; the panel always renders the full text. */
const READ_LIMIT = 12_000;
/** 单块喂给模型的字符上限（避免超上下文）。 */
const CHUNK_LIMIT = 20_000;

function resolveModel(config) {
  const m = config.model;
  if (m && m.provider && m.model) return { provider: m.provider, model: m.model };
  return { provider: 'deepseek-official', model: 'deepseek-flash' };
}

function slug(text) {
  const base = String(text || '').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').slice(0, 60);
  return base || `book-${Date.now().toString(36)}`;
}

function decodeBody(data) {
  if (typeof data !== 'string') return new Uint8Array(0);
  const match = /^data:([^;]*);base64,([\s\S]*)$/s.exec(data);
  const b64 = match ? match[2] : data;
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    return new Uint8Array(bin.length).map((_v, i) => bin.charCodeAt(i));
  } catch {
    return new Uint8Array(0);
  }
}

const decodeText = bytes => new TextDecoder().decode(bytes);

/** 构建电子书检索工具定义：仅挂到电子书阅读助手的专属会话，不再全局注入所有 Bot。 */
export function createEbookTools(store) {
  return [
    {
      name: 'ebook_list',
      description: '列出电子书库里的书（书名、作者、章节数）。给 bookId 时列出这本书的章节目录，读某一章用 ebook_read。',
      parameters: {
        type: 'object',
        properties: {
          bookId: { type: 'string', description: '书的 id；不传则列全部书目' },
        },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) => [{ type: 'text', text: value.length ? value.map(line => line.text).join('\n') : '（书库是空的）' }],
      },
      async execute(args) {
        if (args.bookId) {
          const { chapters } = store().getBook(args.bookId);
          return chapters.map(chapter => ({ idx: chapter.idx, title: chapter.title, groupName: chapter.groupName, chars: chapter.chars, text: `[${chapter.idx}] ${chapter.groupName ? `(${chapter.groupName}) ` : ''}${chapter.title} · ${chapter.chars} 字` }));
        }
        return store().listBooks().map(book => ({
          id: book.id, title: book.title, chapters: book.chapterCount,
          text: `${book.id} · ${book.title}${book.author ? ` — ${book.author}` : ''} · ${book.chapterCount} 章 / ${Math.round(book.chars / 1000)}k 字`,
        }));
      },
    },
    {
      name: 'ebook_read',
      description: '读电子书的一章，返回 markdown 原文（超过 12000 字会截断并提示）。先用 ebook_list 拿 bookId 和章节序号 idx。',
      parameters: {
        type: 'object',
        properties: {
          bookId: { type: 'string', description: '书的 id' },
          idx: { type: 'integer', description: '章节序号（从 0 开始，ebook_list 里有）' },
        },
        required: ['bookId', 'idx'],
      },
      output: {
        schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, truncated: { type: 'boolean' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `# ${value.title}\n\n${value.body}${value.truncated ? '\n\n…（已截断，完整内容请在「电子书」面板里读）' : ''}` }],
      },
      async execute(args) {
        const { chapter } = store().getChapter(args.bookId, Number(args.idx) || 0);
        const truncated = chapter.body.length > READ_LIMIT;
        return { title: chapter.title, body: truncated ? chapter.body.slice(0, READ_LIMIT) : chapter.body, truncated };
      },
    },
    {
      name: 'ebook_search',
      description: '在电子书库里全文搜索一个词，返回命中的章节和上下文片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜的词' },
          bookId: { type: 'string', description: '只在这本书里搜（可选）' },
          limit: { type: 'integer', description: '最多返回几条，默认 10' },
        },
        required: ['query'],
      },
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) => [{ type: 'text', text: value.length ? value.map(hit => `[${hit.idx}] ${hit.title}\n    ${hit.snippet}`).join('\n') : '（没有命中）' }],
      },
      async execute(args) {
        const result = store().search(args.query, { bookId: args.bookId, limit: Number(args.limit) || 10 });
        return result.hits.map(hit => ({ ...hit, text: `[${hit.idx}] ${hit.title} · ${hit.snippet}` }));
      },
    },
  ];
}

export function apply(ctx, config = {}) {
  const { dbPath } = ebookPaths(config);
  let opened = null;
  const store = () => {
    if (!opened) opened = openEbookStore({ dbPath });
    return opened;
  };
  const model = resolveModel(config);
  const jobs = new Map();
  const JOB_TTL_MS = 30 * 60 * 1000;

  function pruneJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status !== 'running' && now - job.updatedAt > JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
  }

  /** 动态选取可用模型：优先 config.model；否则优先 catalog 里的 deepseek-flash/chat 或首个可用模型。 */
  async function pickModel() {
    if (config.model && config.model.provider && config.model.model) return model;
    try {
      const catalog = await ctx.sessionController.modelCatalog();
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
      const all = [];
      for (const group of groups) {
        const provider = group?.id || group?.provider;
        for (const item of group?.models || []) {
          const id = typeof item === 'string' ? item : item?.id;
          if (provider && id) all.push({ provider, model: id });
        }
      }
      if (all.length > 0) {
        return all.find(m => m.provider === model.provider && m.model === model.model)
          || all.find(m => /flash|mini|haiku|fast/i.test(m.model))
          || all[0];
      }
    } catch { /* fallback to default */ }
    return model;
  }

  /** 模型转换：llm.stream → 拼接成一段文本（host 侧适配 ingest 的 stream 接口）。 */
  async function modelToMarkdown(prompt, signal) {
    const activeModel = await pickModel();
    const chunks = ctx.llm.stream({
      provider: activeModel.provider,
      model: activeModel.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal,
    });
    let text = '';
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') text += chunk.text;
    }
    return text;
  }

  function startJob(runner) {
    pruneJobs();
    const id = `job-${randomUUID().slice(0, 12)}`;
    const job = { id, status: 'running', stage: '正在解析文件…', done: 0, total: 0, preview: null, error: null, updatedAt: Date.now() };
    jobs.set(id, job);
    const update = (patch) => {
      Object.assign(job, patch, { updatedAt: Date.now() });
    };
    Promise.resolve()
      .then(() => runner(update))
      .then((preview) => update({ status: 'done', stage: '解析完成', preview }))
      .catch((err) => update({
        status: 'error',
        stage: '解析失败',
        error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) },
      }));
    return { jobId: id, status: job.status, stage: job.stage, done: 0, total: 0 };
  }

  function importStatus(jobId) {
    pruneJobs();
    const job = jobs.get(jobId);
    if (!job) throw Object.assign(new Error('找不到该导入任务（可能已过期，请重新上传）'), { code: 'NOT_FOUND' });
    return {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      done: job.done,
      total: job.total,
      preview: job.preview,
      error: job.error,
    };
  }

  async function runImportFile(body, update = () => {}) {
    const name = String(body.name || '未命名');
    const title = name.replace(/\.[^.]+$/, '') || '未命名';
    const lower = name.toLowerCase();
    const bytes = decodeBody(body.data);

    // 1. EPUB：直接解包 OPF 书脊，秒级完成，不走模型分块
    if (lower.endsWith('.epub') || body.mime === 'application/epub+zip') {
      update({ stage: '正在解析 EPUB 章节…' });
      const epub = extractEpubBook(bytes, { fallbackTitle: title });
      return {
        book: { id: slug(epub.title || name), title: epub.title || title, author: epub.author || '', source: name, description: '' },
        chapters: epub.chapters,
      };
    }

    // 2. Markdown / TXT：本身已有清晰文本结构，直接切章，秒级完成
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      const rawText = decodeText(bytes);
      if (!rawText.trim()) throw Object.assign(new Error('文件内容为空'), { code: 'EMPTY_EXTRACT' });
      return {
        book: { id: slug(name), title, author: '', source: name, description: '' },
        chapters: splitMarkdownChapters(rawText, title),
      };
    }
    if (lower.endsWith('.txt')) {
      const rawText = decodeText(bytes);
      if (!rawText.trim()) throw Object.assign(new Error('文件内容为空'), { code: 'EMPTY_EXTRACT' });
      return {
        book: { id: slug(name), title, author: '', source: name, description: '' },
        chapters: splitPlainChapters(rawText, title),
      };
    }

    // 3. PDF / HTML：抽取原始文字后交模型并发整理
    let rawText;
    if (lower.endsWith('.pdf') || body.mime === 'application/pdf') {
      update({ stage: '正在提取 PDF 文字…' });
      rawText = await extractPdfText(bytes);
    } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      update({ stage: '正在提取网页正文…' });
      rawText = extractWebBody(decodeText(bytes));
    } else {
      rawText = decodeText(bytes);
    }
    if (!rawText.trim()) {
      throw Object.assign(new Error('没有抽到文字：可能是扫描件 PDF 或空文件'), { code: 'EMPTY_EXTRACT' });
    }
    const chunks = chunkText(rawText, CHUNK_LIMIT);
    update({ stage: `正在用模型整理排版（0/${chunks.length} 块）…`, done: 0, total: chunks.length });
    return convertToBook(chunks, {
      stream: modelToMarkdown,
      meta: { id: slug(name), title, source: name },
      concurrency: 3,
      onProgress: ({ done, total }) => update({ stage: `正在用模型整理排版（${done}/${total} 块）…`, done, total }),
    });
  }

  async function importFile(body) {
    if (body.async) return startJob((update) => runImportFile(body, update));
    const preview = await runImportFile(body);
    return { preview };
  }

  async function runImportUrl(body, update = () => {}) {
    update({ stage: '正在抓取网页内容…' });
    const res = await ctx.web.fetch({ url: body.url });
    const content = res.body?.content || '';
    const rawText = res.body?.kind === 'html' ? extractWebBody(content) : content;
    if (!rawText.trim()) {
      throw Object.assign(new Error('网页没有抓到正文（可能是登录墙或纯脚本页）'), { code: 'EMPTY_EXTRACT' });
    }
    const chunks = chunkText(rawText, CHUNK_LIMIT);
    update({ stage: `正在用模型整理排版（0/${chunks.length} 块）…`, done: 0, total: chunks.length });
    return convertToBook(chunks, {
      stream: modelToMarkdown,
      meta: { id: slug(res.url || body.url), title: '', source: res.url || body.url },
      concurrency: 3,
      onProgress: ({ done, total }) => update({ stage: `正在用模型整理排版（${done}/${total} 块）…`, done, total }),
    });
  }

  async function importUrl(body) {
    if (body.async) return startJob((update) => runImportUrl(body, update));
    const preview = await runImportUrl(body);
    return { preview };
  }

  function commit(preview) {
    const book = preview?.book || {};
    const next = {
      id: book.id || `book-${Date.now().toString(36)}`,
      title: book.title || '未命名',
      author: book.author || '',
      source: book.source || '',
      description: book.description || '',
    };
    return store().replaceBook(next, preview?.chapters || []);
  }

  const ingest = { importFile, importUrl, importStatus, commit };
  const assistant = createAssistant({
    agents: ctx.agents,
    sessionController: ctx.sessionController,
    model,
    store,
    cwd: path.dirname(dbPath),
    tools: createEbookTools(store),
  });
  const models = async () => {
    try { return await ctx.sessionController.modelCatalog(); } catch { return { groups: [] }; }
  };

  const handle = createEbookHandler({ store, ingest, assistant, models });

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bot-ebook',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let result;
      try {
        result = await handle(await request.json());
      } catch (error) {
        result = { ok: false, error: { code: error.code || 'bot-ebook/error', message: error.message } };
      }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    },
  }), 'bot-ebook: HTTP route');
}
