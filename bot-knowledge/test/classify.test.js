import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemory } from '../lib/classify.js';

test('daily-report wins over journal/experience', () => {
  assert.deepEqual(classifyMemory({ predicate: 'daily-report', facets: ['experience'] }), { category: 'daily-report' });
});

test('journal predicate or journal/experience facet is a journal entry', () => {
  assert.deepEqual(classifyMemory({ predicate: 'journal', facets: [] }), { category: 'journal' });
  assert.deepEqual(classifyMemory({ predicate: 'daily-notes', facets: ['journal'] }), { category: 'journal' });
  assert.deepEqual(classifyMemory({ predicate: 'release-window', facets: ['experience'] }), { category: 'journal' });
});

test('only explicit knowledge/blog/article entries are classified as public knowledge', () => {
  assert.deepEqual(classifyMemory({ predicate: 'architecture-note', facets: ['knowledge'] }), { category: 'knowledge' });
  assert.deepEqual(classifyMemory({ predicate: 'knowledge', facets: [] }), { category: 'knowledge' });
  assert.deepEqual(classifyMemory({ predicate: 'blog', facets: [] }), { category: 'knowledge' });
  assert.deepEqual(classifyMemory({ predicate: 'article', facets: [] }), { category: 'knowledge' });
});

test('decision, preference, and plain facts default to private long-term memory', () => {
  assert.deepEqual(classifyMemory({ predicate: 'model-choice', facets: ['decision'] }), { category: 'private', subtype: 'decision' });
  assert.deepEqual(classifyMemory({ predicate: 'language', facets: ['preference'] }), { category: 'private', subtype: 'preference' });
  assert.deepEqual(classifyMemory({ predicate: 'role', facets: [] }), { category: 'private' });
});

test('damaged fields never throw and fall back to private', () => {
  for (const bad of [{}, { predicate: 42 }, { facets: 'experience' }, { facets: null }, null, undefined]) {
    assert.doesNotThrow(() => classifyMemory(bad));
    assert.equal(classifyMemory(bad).category, 'private');
  }
});
