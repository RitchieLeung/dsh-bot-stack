/**
 * Display-only classification of one memory record.
 *
 * This is a presentation convention, not a schema change: nothing here writes
 * to the knowledge database, and an unrecognised or damaged record always
 * falls back to `knowledge` so the panel keeps rendering.
 */

export const REPORT_PREDICATE = 'daily-report';
export const JOURNAL_FACET = 'experience';

export function classifyMemory(memory) {
  const record = memory && typeof memory === 'object' ? memory : {};
  const predicate = typeof record.predicate === 'string' ? record.predicate : '';
  const facets = Array.isArray(record.facets) ? record.facets.filter(f => typeof f === 'string') : [];

  if (predicate === REPORT_PREDICATE) return { category: 'daily-report' };
  if (facets.includes(JOURNAL_FACET)) return { category: 'journal' };
  if (facets.includes('decision')) return { category: 'knowledge', subtype: 'decision' };
  if (facets.includes('preference')) return { category: 'knowledge', subtype: 'preference' };
  return { category: 'knowledge' };
}
