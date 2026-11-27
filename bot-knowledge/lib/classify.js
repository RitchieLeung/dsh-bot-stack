/**
 * Display-only classification of one memory record.
 *
 * This is a presentation convention, not a schema change: nothing here writes
 * to the knowledge database, and an unrecognised or damaged record always
 * falls back to `knowledge` so the panel keeps rendering.
 */

export const REPORT_PREDICATE = 'daily-report';
export const JOURNAL_FACET = 'experience';
export const JOURNAL_PREDICATE = 'journal';
export const KNOWLEDGE_FACET = 'knowledge';
const KNOWLEDGE_PREDICATES = new Set(['knowledge', 'blog', 'article']);

export function classifyMemory(memory) {
  const record = memory && typeof memory === 'object' ? memory : {};
  const predicate = typeof record.predicate === 'string' ? record.predicate : '';
  const facets = Array.isArray(record.facets) ? record.facets.filter(f => typeof f === 'string') : [];

  if (predicate === REPORT_PREDICATE) return { category: 'daily-report' };
  if (predicate === JOURNAL_PREDICATE || facets.includes('journal') || facets.includes(JOURNAL_FACET)) {
    return { category: 'journal' };
  }
  if (KNOWLEDGE_PREDICATES.has(predicate) || facets.includes(KNOWLEDGE_FACET)) {
    return { category: 'knowledge' };
  }
  if (facets.includes('decision')) return { category: 'private', subtype: 'decision' };
  if (facets.includes('preference')) return { category: 'private', subtype: 'preference' };
  return { category: 'private' };
}
