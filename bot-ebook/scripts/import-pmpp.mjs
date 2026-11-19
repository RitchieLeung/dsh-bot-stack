#!/usr/bin/env node
/**
 * 把 markdown 书稿导入本机电子书库。
 *
 * 现状只需要一本书：psmarter/PMPP-Learning（PMPP 第四版中文学习笔记，
 * 22 篇正文 + 导读 + 20 章习题解答）。但它不写死在那本书上：
 * 任何「一堆按章节排的 markdown」都能用 `--dir` 指过来导入。
 *
 * 用法：
 *   node scripts/import-pmpp.mjs                     # 从 GitHub 拉最新，导入 PMPP
 *   node scripts/import-pmpp.mjs --dir /path/repo    # 用本地已解压的仓库
 *   node scripts/import-pmpp.mjs --db /tmp/x.sqlite  # 写到别的库（测试用）
 *
 * 导入是「整本替换」：章节按 idx 重建，阅读进度按 idx 夹紧，不会丢位置。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openEbookStore } from '../lib/store.js';

const DEFAULT_REPO = 'psmarter/PMPP-Learning';
const BOOK_ID = 'pmpp-learning';

/** 一、二、…、二十二 这类中文数字 → 阿拉伯数字。 */
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function chineseNumber(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  if (/^\d+$/.test(source)) return Number(source);
  if (source === '十') return 10;
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(source);
  if (tens) return (tens[1] ? CN_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CN_DIGITS[tens[2]] : 0);
  return CN_DIGITS[source] ?? null;
}

/** 去掉文件开头的 YAML frontmatter，返回 { meta, body }。 */
export function splitFrontmatter(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { meta: {}, body: source.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: source.slice(match[0].length).trim() };
}

function argValue(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** 下载仓库 tarball 并解压到临时目录；返回目录路径和清理函数。 */
async function fetchRepo(repo, branch) {
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
  process.stdout.write(`下载 ${url} …\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = mkdtempSync(path.join(tmpdir(), 'ebook-import-'));
  const tarball = path.join(dir, 'repo.tgz');
  writeFileSync(tarball, buffer);
  execFileSync('tar', ['xzf', tarball, '-C', dir, '--strip-components=1']);
  rmSync(tarball, { force: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 从仓库目录里收集章节，按「导读 → 正文 → 习题 → 附录」排序。 */
export function collectChapters(root) {
  const chapters = [];

  const readme = path.join(root, 'README.md');
  if (existsSync(readme)) {
    chapters.push({ order: 900, groupName: '附录', title: '仓库说明', body: splitFrontmatter(readFileSync(readme, 'utf8')).body });
  }

  const blogs = path.join(root, 'Blogs');
  if (existsSync(blogs)) {
    for (const file of readdirSync(blogs).filter(name => name.endsWith('.md'))) {
      const { meta, body } = splitFrontmatter(readFileSync(path.join(blogs, file), 'utf8'));
      const named = /^PMPP-第(.+?)章[：:](.+)$/.exec(file.replace(/\.md$/, ''));
      const title = meta.title && meta.title !== file.replace(/\.md$/, '')
        ? meta.title.replace(/^PMPP-/, '')
        : (named ? `第${named[1]}章：${named[2]}` : file.replace(/\.md$/, ''));
      if (/导读/.test(file)) {
        chapters.push({ order: 0, groupName: '导读', title: '全书导读', body });
        continue;
      }
      const number = named ? chineseNumber(named[1]) : null;
      chapters.push({ order: 100 + (number ?? 99), groupName: '正文', title, body });
    }
  }

  const exercises = path.join(root, 'Exercises');
  if (existsSync(exercises)) {
    for (const entry of readdirSync(exercises, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(exercises, entry.name, 'README.md');
      if (!existsSync(file)) continue;
      const { body } = splitFrontmatter(readFileSync(file, 'utf8'));
      const number = Number((/Chapter(\d+)/.exec(entry.name) || [])[1] || 0);
      const heading = (/^#\s+(.+)$/m.exec(body) || [])[1];
      // Exercises 的标题本身是「第N章：xxx」，加个后缀区分正文。
      chapters.push({
        order: 500 + number,
        groupName: '习题',
        title: heading ? `${heading} · 习题解答` : `第 ${number} 章 习题解答`,
        body,
      });
    }
  }

  if (!chapters.length) throw new Error(`没在 ${root} 里找到 markdown（需要有 Blogs/、Exercises/ 或 README.md）`);
  chapters.sort((a, b) => a.order - b.order);
  return chapters.map(({ groupName, title, body }) => ({ groupName, title, body }));
}

function describeBody(root) {
  const readme = path.join(root, 'README.md');
  if (!existsSync(readme)) return '';
  const body = splitFrontmatter(readFileSync(readme, 'utf8')).body;
  const paragraph = body.split('\n').find(line => line.trim() && !line.startsWith('#') && !line.startsWith('>'));
  return (paragraph || '').trim().slice(0, 400);
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = argValue(argv, 'repo') || DEFAULT_REPO;
  const branch = argValue(argv, 'branch') || 'main';
  const dir = argValue(argv, 'dir');
  const dbPath = argValue(argv, 'db') || process.env.EBOOK_DB || path.join(homedir(), '.dsh', 'bot', 'ebook', 'ebook.sqlite');

  let root = dir;
  let cleanup = () => {};
  if (!root) ({ dir: root, cleanup } = await fetchRepo(repo, branch));

  try {
    const chapters = collectChapters(root);
    const book = {
      id: BOOK_ID,
      title: 'PMPP 大规模并行处理器程序设计（第4版）· 学习笔记',
      author: 'psmarter · smarter.xin',
      source: `https://github.com/${repo}  ·  https://smarter.xin`,
      description: describeBody(root),
    };
    const store = openEbookStore({ dbPath });
    let saved = null;
    try { saved = store.getBook(book.id); } catch { /* first import */ }
    store.replaceBook(book, chapters);
    const after = store.getBook(book.id);
    store.close();
    if (saved?.progress) process.stdout.write(`保留上次阅读位置：第 ${after.progress.idx + 1}/${after.chapterCount} 章\n`);
    const byGroup = {};
    for (const chapter of chapters) byGroup[chapter.groupName] = (byGroup[chapter.groupName] || 0) + 1;
    process.stdout.write(`已导入《${book.title}》→ ${dbPath}\n`);
    process.stdout.write(`  章节 ${chapters.length}：${Object.entries(byGroup).map(([name, count]) => `${name} ${count}`).join(' · ')}\n`);
    process.stdout.write(`  字数 ${(after.chars / 1000).toFixed(0)}k\n`);
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`导入失败：${error.message}\n`);
    process.exit(1);
  });
}
