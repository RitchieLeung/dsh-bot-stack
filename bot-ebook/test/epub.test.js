import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEpubBook } from '../lib/epub.js';
import { splitPlainChapters, convertToBook } from '../lib/ingest.js';
import * as host from '../lib/host.js';

/** 构造一个最小合法 ZIP（用于生成测试用 EPUB）。 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content, compress = true } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const body = compress ? deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, body);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function makeSampleEpub() {
  return buildZip([
    { name: 'mimetype', content: 'application/epub+zip', compress: false },
    {
      name: 'META-INF/container.xml',
      content: `<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>`,
    },
    {
      name: 'OEBPS/content.opf',
      content: `<?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>并行计算导论</dc:title>
            <dc:creator>张老师</dc:creator>
          </metadata>
          <manifest>
            <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
            <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine>
            <itemref idref="ch1"/>
            <itemref idref="ch2"/>
          </spine>
        </package>`,
    },
    {
      name: 'OEBPS/Text/ch1.xhtml',
      content: '<html><body><h1>第一章 归约</h1><p>归约是并行算法基石。</p></body></html>',
    },
    {
      name: 'OEBPS/Text/ch2.xhtml',
      content: '<html><body><h1>第二章 前缀和</h1><p>前缀和可高效并行。</p></body></html>',
    },
  ]);
}

test('extractEpubBook parses OPF metadata and spine chapters in order', () => {
  const epubBytes = makeSampleEpub();
  const book = extractEpubBook(epubBytes);
  assert.equal(book.title, '并行计算导论');
  assert.equal(book.author, '张老师');
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].title, '第一章 归约');
  assert.match(book.chapters[0].body, /并行算法基石/);
  assert.equal(book.chapters[1].title, '第二章 前缀和');
  assert.match(book.chapters[1].body, /前缀和可高效并行/);
});

test('splitPlainChapters splits Chinese/English headings without LLM', () => {
  const txt = '第一章 开始\n第一段内容。\n\n第二章 深入\n第二段内容。';
  const chapters = splitPlainChapters(txt, '默认');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章 开始');
  assert.equal(chapters[1].title, '第二章 深入');
});

test('convertToBook runs chunks concurrently while preserving order and reporting progress', async () => {
  const seenProgress = [];
  const preview = await convertToBook(['chunk-0', 'chunk-1', 'chunk-2'], {
    concurrency: 2,
    meta: { id: 'b1', title: '书' },
    onProgress: p => seenProgress.push(p),
    stream: async (prompt) => {
      const idx = /第 (\d+)\/3/.exec(prompt)[1];
      await new Promise(r => setTimeout(r, idx === '1' ? 20 : 5));
      return `# 第${idx}章\n\n内容 ${idx}`;
    },
  });
  assert.deepEqual(preview.chapters.map(c => c.title), ['第1章', '第2章', '第3章']);
  assert.equal(seenProgress.length, 3);
  assert.equal(seenProgress[seenProgress.length - 1].done, 3);
});

test('host import_file supports async job polling and fast-path EPUB without calling LLM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebook-async-'));
  let llmCalls = 0;
  const routes = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    inject() {},
    connection: { fetch: { register(def) { routes.push(def); return () => {}; } } },
    llm: { stream: async function* () { llmCalls += 1; yield { type: 'text-delta', text: '# 章\n\n正文' }; } },
    web: { fetch: async () => ({ body: { kind: 'text', content: '网页内容' }, url: 'https://example.com' }) },
    agents: { create: async () => ({ agent: { id: 'a' }, dispose: async () => {} }) },
    sessionController: { modelCatalog: async () => ({ groups: [{ id: 'p1', models: [{ id: 'm-fast' }] }] }) },
  };
  host.apply(ctx, { dbPath: join(dir, 'ebook.sqlite') });
  const fetch = routes[0].fetch;
  const post = async (body) => (await fetch(new Request('http://localhost/api/bot-ebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))).json();

  const epubData = `data:application/epub+zip;base64,${makeSampleEpub().toString('base64')}`;
  const started = await post({ action: 'import_file', name: 'demo.epub', mime: 'application/epub+zip', data: epubData, async: true });
  assert.equal(started.ok, true);
  assert.ok(started.value.jobId);

  let status;
  for (let i = 0; i < 20; i += 1) {
    status = await post({ action: 'import_status', jobId: started.value.jobId });
    if (status.value.status !== 'running') break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(status.ok, true);
  assert.equal(status.value.status, 'done');
  assert.equal(status.value.preview.book.title, '并行计算导论');
  assert.equal(status.value.preview.chapters.length, 2);
  assert.equal(llmCalls, 0, 'EPUB fast-path should not invoke LLM');
});
