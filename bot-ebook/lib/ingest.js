/**
 * 通用采集：把 PDF / 网页 / markdown / txt 变成「书 = 若干章」。
 *
 * 机械层只负责「把原始文字拿到手」和「分块」；真正的清洗 / 分章 / 还原表格公式
 * 交给模型（`llm.stream`）完成。这里都是纯函数，模型调用以注入的 `stream` 形式传入，
 * 便于单测（测试里塞一个假 stream，不用真调模型）。
 */

/**
 * 把一段长文按上限切块，块边界尽量落在空行/换行处，不丢内容。
 * @param {string} text 原文
 * @param {number} limit 单块字符上限
 * @returns {string[]}
 */
export function chunkText(text, limit = 12000) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  if (source.length <= limit) return source ? [source] : [];
  const chunks = [];
  let remaining = source;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= limit * 0.5) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

/**
 * markdown / 纯文本 → 章节。只有一级标题（`# `）分章，`##` 及更深视为章内小节。
 * 没有一级标题就整篇一章。
 * @param {string} text
 * @param {string} fallbackTitle 无标题时的章节名
 * @returns {{ title: string, body: string }[]}
 */
export function splitMarkdownChapters(text, fallbackTitle = '正文') {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const chapters = [];
  let current = null;
  const flush = () => {
    if (current && current.body.trim()) chapters.push(current);
    current = null;
  };
  for (const line of source.split('\n')) {
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    } else if (line.trim()) {
      current = { title: fallbackTitle, body: `${line}\n` };
    }
  }
  flush();
  return chapters.length ? chapters : [{ title: fallbackTitle, body: source }];
}

const PLAIN_HEADING_RE = /^(?:#\s+(.+?)\s*#*|第[零一二三四五六七八九十百千万两0-9]{1,8}[章节回部卷篇](?:[\s：:·、.-].*)?|Chapter\s+[0-9IVXLCM]+(?:[\s:：.-].*)?)$/i;

/**
 * 纯文本（.txt）→ 章节：按常见中英文章节标题切分；若全文无章节标题，则按阅读长度切块或整篇成章。
 * @param {string} text
 * @param {string} fallbackTitle
 * @returns {{ title: string, body: string }[]}
 */
export function splitPlainChapters(text, fallbackTitle = '正文') {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const chapters = [];
  let current = null;
  const flush = () => {
    if (current && current.body.trim()) {
      chapters.push({ title: current.title, body: current.body.trim() });
    }
    current = null;
  };
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const match = trimmed.length <= 60 ? PLAIN_HEADING_RE.exec(trimmed) : null;
    if (match) {
      flush();
      const title = (match[1] || trimmed).trim();
      current = { title, body: `# ${title}\n\n` };
    } else if (current) {
      current.body += `${line}\n`;
    } else if (trimmed) {
      current = { title: fallbackTitle, body: `${line}\n` };
    }
  }
  flush();
  if (chapters.length > 1) return chapters;
  if (source.length > 30000) {
    return chunkText(source, 20000).map((part, idx) => ({
      title: `${fallbackTitle}（${idx + 1}）`,
      body: part,
    }));
  }
  return chapters.length ? chapters : [{ title: fallbackTitle, body: source }];
}

/**
 * 网页正文抽取：去掉脚本/样式/导航/页眉页脚，优先取 <article>/<main>，再把块级
 * 标签换行、标题转成 markdown 前缀。这只是「拿原始文字」，最终整理交给模型。
 * @param {string} html
 * @returns {string}
 */
export function extractWebBody(html) {
  const doc = String(html || '');
  const stripped = doc
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const container = /<article[\s\S]*?<\/article>/i.exec(stripped)
    || /<main[\s\S]*?<\/main>/i.exec(stripped)
    || [null, stripped];
  const body = container[1] ?? stripped;
  const text = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, inner) =>
      `\n\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<\/(p|div|li|tr|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/**
 * 生成「原始文字 → markdown」的转换提示词。
 * @param {string} rawChunk 一块原始文字
 * @param {{ index?: number, total?: number, title?: string, source?: string }} meta
 * @returns {string}
 */
export function buildConversionPrompt(rawChunk, meta = {}) {
  const { index = 0, total = 1, title = '', source = '' } = meta;
  return [
    `你把下面这段${source ? `来自「${source}」的` : ''}原始文字整理成结构化 markdown。`,
    title ? `整本书的书名是《${title}》。` : '',
    '要求：',
    '1. 用 # / ## / ### 分标题层级，让人一眼看出章节结构；',
    '2. 保留并还原表格（用 markdown 表格）；数学公式按原样保留；',
    '3. 去掉页眉、页脚、页码、分栏错位和重复空行；',
    '4. 不要加任何解释、前言或结语，只输出整理后的 markdown 正文；',
    `5. 这是全书的第 ${index + 1}/${total} 块；如果这段明显是某章的一部分，保留原文的标题层级即可，不要臆造新的章节。`,
    '',
    '原始文字：',
    rawChunk,
  ].filter(line => line !== '').join('\n');
}

/**
 * 把若干块原始文字逐块交给模型转成 markdown，拼起来再按一级标题拆章。
 * @param {string[]} chunks 原始文字块
 * @param {{ stream: (prompt: string) => Promise<string>, meta?: object }} deps
 *   stream 是注入的模型调用（host 侧用 llm.stream 适配而来）
 * @returns {Promise<{ book: object, chapters: { title: string, body: string }[] }>}
 */
export async function convertToBook(chunks, { stream, meta = {}, onProgress, concurrency = 3 }) {
  const total = chunks.length;
  const parts = new Array(total);
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, total || 1));
  let nextIndex = 0;
  let done = 0;

  async function worker() {
    while (nextIndex < total) {
      const index = nextIndex;
      nextIndex += 1;
      const prompt = buildConversionPrompt(chunks[index], { ...meta, index, total });
      parts[index] = await stream(prompt);
      done += 1;
      onProgress?.({ done, total });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const chapters = splitMarkdownChapters(parts.join('\n\n'));
  return {
    book: {
      id: meta.id || '',
      title: meta.title || '',
      author: meta.author || '',
      source: meta.source || '',
      description: meta.description || '',
    },
    chapters,
  };
}
