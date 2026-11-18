import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemory } from '../lib/classify.js';

test('daily-report wins over experience', () => {
  assert.deepEqual(classifyMemory({ predicate: 'daily-report', facets: ['experience'] }), { category: 'daily-report' });
});

test('experience facet is a journal entry', () => {
  assert.deepEqual(classifyMemory({ predicate: 'release-window', facets: ['experience'] }), { category: 'journal' });
});

test('decision and preference are knowledge subtypes', () => {
  assert.deepEqual(classifyMemory({ predicate: 'model-choice', facets: ['decision'] }), { category: 'knowledge', subtype: 'decision' });
  assert.deepEqual(classifyMemory({ predicate: 'language', facets: ['preference'] }), { category: 'knowledge', subtype: 'preference' });
});

test('a plain fact is knowledge', () => {
  assert.deepEqual(classifyMemory({ predicate: 'role', facets: [] }), { category: 'knowledge' });
});

test('damaged fields never throw and fall back to knowledge', () => {
  for (const bad of [{}, { predicate: 42 }, { facets: 'experience' }, { facets: null }, null, undefined]) {
    assert.doesNotThrow(() => classifyMemory(bad));
    assert.equal(classifyMemory(bad).category, 'knowledge');
  }
});
