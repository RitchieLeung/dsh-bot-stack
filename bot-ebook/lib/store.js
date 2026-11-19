/**
 * Durable store for the ebook module.
 *
 * A book is a row in `books`; its content is a flat, ordered list of chapters
 * (`chapters.idx`), each holding the chapter's markdown source. Grouping
 * (导读 / 正文 / 习题 …) is just a label on the chapter, so a re-import never
 * needs a schema change. Reading position lives in `progress`, one row per
 * book, so it survives reloads, re-imports and browser changes.
 *
 * Kept free of Cordis so the whole contract is unit-testable against a
 * scratch database.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const now = () => Date.now();

/** Escape LIKE wildcards so a search for `50%` matches a literal `50%`. */
const likeSafe = text => text.replace(/[\\%_]/g, ch => `\\${ch}`);

/** Trim a snippet around the first match, on a word-ish boundary. */
function snippetAround(body, query, radius = 70) {
  const flat = String(body || '').replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export function openEbookStore({ dbPath }) {
  if (!dbPath) throw failure('NO_DB_PATH', '缺少数据库路径');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      author      TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      bookId    TEXT NOT NULL,
      idx       INTEGER NOT NULL,
      groupName TEXT NOT NULL DEFAULT '',
      title     TEXT NOT NULL,
      chars     INTEGER NOT NULL DEFAULT 0,
      body      TEXT NOT NULL,
      UNIQUE (bookId, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters (bookId, idx);
    CREATE TABLE IF NOT EXISTS progress (
      bookId    TEXT PRIMARY KEY,
      idx       INTEGER NOT NULL DEFAULT 0,
      offset    INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );
  `);

  const selectBooks = db.prepare('SELECT * FROM books ORDER BY createdAt ASC, title ASC');
  const selectBook = db.prepare('SELECT * FROM books WHERE id = ?');
  const upsertBookStmt = db.prepare(`
    INSERT INTO books (id, title, author, source, description, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, author = excluded.author, source = excluded.source,
      description = excluded.description, updatedAt = excluded.updatedAt`);
  const deleteChapters = db.prepare('DELETE FROM chapters WHERE bookId = ?');
  const insertChapter = db.prepare(
    'INSERT INTO chapters (bookId, idx, groupName, title, chars, body) VALUES (?, ?, ?, ?, ?, ?)');
  const selectChapters = db.prepare('SELECT id, idx, groupName, title, chars FROM chapters WHERE bookId = ? ORDER BY idx ASC');
  const selectChapter = db.prepare('SELECT * FROM chapters WHERE bookId = ? AND idx = ?');
  const countChapters = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS chars FROM chapters WHERE bookId = ?');
  const selectProgress = db.prepare('SELECT * FROM progress WHERE bookId = ?');
  const upsertProgress = db.prepare(`
    INSERT INTO progress (bookId, idx, offset, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(bookId) DO UPDATE SET idx = excluded.idx, offset = excluded.offset, updatedAt = excluded.updatedAt`);

  const bookFrom = row => (row ? {
    id: row.id,
    title: row.title,
    author: row.author || '',
    source: row.source || '',
    description: row.description || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } : null);

  const progressFrom = row => (row ? { idx: row.idx, offset: row.offset, updatedAt: row.updatedAt } : null);

  function requireBook(id) {
    const row = selectBook.get(String(id || ''));
    if (!row) throw failure('NOT_FOUND', `找不到这本书：${id}`);
    return row;
  }

  /** Books with chapter counts and the saved reading position. */
  function listBooks() {
    return selectBooks.all().map(row => {
      const counts = countChapters.get(row.id);
      return { ...bookFrom(row), chapterCount: counts.n, chars: counts.chars, progress: progressFrom(selectProgress.get(row.id)) };
    });
  }

  /** One book plus its chapter index (no bodies — the reader loads them on demand). */
  function getBook(id) {
    const row = requireBook(id);
    const counts = countChapters.get(row.id);
    return {
      book: bookFrom(row),
      chapters: selectChapters.all(row.id),
      chapterCount: counts.n,
      chars: counts.chars,
      progress: progressFrom(selectProgress.get(row.id)),
    };
  }

  /** One chapter with its markdown body and the neighbours for 上一章/下一章. */
  function getChapter(bookId, idx) {
    const book = requireBook(bookId);
    const row = selectChapter.get(book.id, Number(idx));
    if (!row) throw failure('NOT_FOUND', `找不到章节：${book.id}#${idx}`);
    const list = selectChapters.all(book.id);
    const position = list.findIndex(item => item.idx === row.idx);
    const pick = offset => {
      const target = list[position + offset];
      return target ? { idx: target.idx, title: target.title } : null;
    };
    return {
      book: bookFrom(book),
      chapter: { id: row.id, idx: row.idx, groupName: row.groupName, title: row.title, chars: row.chars, body: row.body },
      prev: pick(-1),
      next: pick(1),
      position: { index: position, total: list.length },
    };
  }

  /**
   * Replace a whole book's chapters in one transaction. `idx` is the array
   * position, so callers control the reading order. The saved position is
   * clamped instead of dropped: re-importing the same book keeps your place.
   */
  function replaceBook(book, chapters) {
    if (!book || typeof book.id !== 'string' || !book.id.trim()) throw failure('INVALID_BOOK', '缺少书 id');
    if (!Array.isArray(chapters) || !chapters.length) throw failure('INVALID_BOOK', '一本书至少要有一章');
    const title = String(book.title || '').trim();
    if (!title) throw failure('INVALID_BOOK', '书名不能为空');
    const at = now();
    db.exec('BEGIN');
    try {
      upsertBookStmt.run(book.id, title, String(book.author || ''), String(book.source || ''), String(book.description || ''), at, at);
      deleteChapters.run(book.id);
      chapters.forEach((chapter, index) => {
        const body = String(chapter.body || '');
        insertChapter.run(book.id, index, String(chapter.groupName || ''), String(chapter.title || `第 ${index + 1} 节`), body.length, body);
      });
      const saved = selectProgress.get(book.id);
      if (saved) {
        const clamped = Math.max(0, Math.min(chapters.length - 1, saved.idx));
        upsertProgress.run(book.id, clamped, saved.offset, at);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return getBook(book.id);
  }

  /** Full-text-ish search: LIKE on title and body, newest books first-ish by chapter order. */
  function search(query, { bookId = null, limit = 20 } = {}) {
    const text = String(query || '').trim();
    if (!text) return { query: '', hits: [], total: 0 };
    const pattern = `%${likeSafe(text)}%`;
    const rows = bookId
      ? db.prepare(`SELECT * FROM chapters WHERE bookId = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY idx ASC`).all(bookId, pattern, pattern)
      : db.prepare(`SELECT * FROM chapters WHERE (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY bookId ASC, idx ASC`).all(pattern, pattern);
    const hits = rows.slice(0, Math.max(1, limit)).map(row => ({
      bookId: row.bookId,
      idx: row.idx,
      title: row.title,
      groupName: row.groupName,
      inTitle: row.title.toLowerCase().includes(text.toLowerCase()),
      snippet: snippetAround(row.body, text),
    }));
    return { query: text, hits, total: rows.length };
  }

  /** Save where the reader is (chapter + scroll offset). */
  function saveProgress(bookId, idx, offset = 0) {
    const book = requireBook(bookId);
    const list = selectChapters.all(book.id);
    if (!list.length) throw failure('NOT_FOUND', '这本书还没有章节');
    const clamped = Math.max(0, Math.min(list.length - 1, Number(idx) || 0));
    upsertProgress.run(book.id, clamped, Math.max(0, Number(offset) || 0), now());
    return progressFrom(selectProgress.get(book.id));
  }

  function deleteBook(id) {
    const row = requireBook(id);
    db.exec('BEGIN');
    try {
      deleteChapters.run(row.id);
      db.prepare('DELETE FROM progress WHERE bookId = ?').run(row.id);
      db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true };
  }

  function stats() {
    const books = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
    const chapters = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS chars FROM chapters').get();
    return { books, chapters: chapters.n, chars: chapters.chars };
  }

  return { listBooks, getBook, getChapter, replaceBook, search, saveProgress, deleteBook, stats, close() { try { db.close(); } catch { /* already closed */ } } };
}
