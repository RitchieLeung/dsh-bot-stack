/**
 * 纯 Node EPUB 解析（零外部依赖，仅用 node:zlib 解压 ZIP）。
 *
 * 读取 META-INF/container.xml → .opf 的书名/作者/manifest/spine，按阅读顺序
 * 抽出每一章的 XHTML 正文并转为 markdown。
 */

import { inflateRawSync } from 'node:zlib';
import { extractWebBody } from './ingest.js';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/**
 * 读取 ZIP 归档里的所有文件（支持 Stored=0 与 Deflate=8）。
 * @param {Uint8Array} input
 * @returns {Map<string, Buffer>}
 */
export function unzipEntries(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length < 22) throw Object.assign(new Error('EPUB 文件损坏或为空'), { code: 'INVALID_EPUB' });

  // 从末尾向前找 End of Central Directory (EOCD)
  const minOffset = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw Object.assign(new Error('无法识别的 EPUB（缺少 ZIP 目录）'), { code: 'INVALID_EPUB' });

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buf.length) {
    throw Object.assign(new Error('EPUB 目录偏移越界'), { code: 'INVALID_EPUB' });
  }

  const files = new Map();
  let cursor = centralOffset;
  for (let idx = 0; idx < totalEntries && cursor + 46 <= buf.length; idx += 1) {
    if (buf.readUInt32LE(cursor) !== SIG_CEN) break;
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOC) continue;
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    try {
      if (method === 0) files.set(name, Buffer.from(compressed));
      else if (method === 8) files.set(name, inflateRawSync(compressed));
    } catch {
      // 跳过损坏的单条资源，避免整本失败
    }
  }
  return files;
}

function resolveRelative(baseDir, href) {
  const cleanHref = decodeURIComponent(String(href || '').split('#')[0].split('?')[0]);
  const combined = baseDir ? `${baseDir}/${cleanHref}` : cleanHref;
  const parts = [];
  for (const seg of combined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function attrOf(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? '') : '';
}

function extractChapterTitle(html, markdown, fallback) {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown);
  if (heading && heading[1].trim()) return heading[1].trim().slice(0, 120);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleTag) {
    const clean = decodeXmlEntities(titleTag[1].replace(/<[^>]+>/g, ''));
    if (clean && !/^unknown$/i.test(clean)) return clean.slice(0, 120);
  }
  return fallback;
}

/**
 * 解析 EPUB 字节流，返回书名、作者与按阅读顺序排列的章节列表。
 * @param {Uint8Array} data
 * @param {{ fallbackTitle?: string }} [options]
 * @returns {{ title: string, author: string, chapters: { title: string, body: string }[] }}
 */
export function extractEpubBook(data, options = {}) {
  const files = unzipEntries(data);
  const fallbackTitle = options.fallbackTitle || '未命名';

  let opfPath = '';
  const containerBuf = files.get('META-INF/container.xml');
  if (containerBuf) {
    const xml = containerBuf.toString('utf8');
    const rootfile = /<rootfile\b[^>]*>/i.exec(xml);
    if (rootfile) opfPath = attrOf(rootfile[0], 'full-path');
  }
  if (!opfPath) {
    for (const key of files.keys()) {
      if (key.toLowerCase().endsWith('.opf')) {
        opfPath = key;
        break;
      }
    }
  }

  let title = '';
  let author = '';
  const orderedPaths = [];

  if (opfPath && files.has(opfPath)) {
    const opfXml = files.get(opfPath).toString('utf8');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

    const titleMatch = /<(?:dc:)?title\b[^>]*>([\s\S]*?)<\/(?:dc:)?title>/i.exec(opfXml);
    if (titleMatch) title = decodeXmlEntities(titleMatch[1].replace(/<[^>]+>/g, ''));

    const authorMatch = /<(?:dc:)?creator\b[^>]*>([\s\S]*?)<\/(?:dc:)?creator>/i.exec(opfXml);
    if (authorMatch) author = decodeXmlEntities(authorMatch[1].replace(/<[^>]+>/g, ''));

    const manifest = new Map();
    for (const m of opfXml.matchAll(/<item\b[^>]*>/gi)) {
      const id = attrOf(m[0], 'id');
      const href = attrOf(m[0], 'href');
      const mediaType = attrOf(m[0], 'media-type');
      if (id && href) manifest.set(id, { href: resolveRelative(opfDir, href), mediaType });
    }

    for (const m of opfXml.matchAll(/<itemref\b[^>]*>/gi)) {
      const idref = attrOf(m[0], 'idref');
      const item = manifest.get(idref);
      if (!item) continue;
      if (!item.mediaType || /html|xml/i.test(item.mediaType)) {
        orderedPaths.push(item.href);
      }
    }
  }

  if (orderedPaths.length === 0) {
    for (const key of [...files.keys()].sort()) {
      if (/\.(xhtml|html|htm)$/i.test(key) && !/toc\./i.test(key)) {
        orderedPaths.push(key);
      }
    }
  }

  const chapters = [];
  for (const filePath of orderedPaths) {
    const buf = files.get(filePath);
    if (!buf) continue;
    const html = buf.toString('utf8');
    const body = extractWebBody(html);
    if (!body || body.trim().length < 2) continue;
    const chTitle = extractChapterTitle(html, body, `第 ${chapters.length + 1} 章`);
    chapters.push({ title: chTitle, body });
  }

  if (chapters.length === 0) {
    throw Object.assign(new Error('EPUB 中未提取到可读文本章节'), { code: 'EMPTY_EXTRACT' });
  }

  return {
    title: title || fallbackTitle,
    author,
    chapters,
  };
}
