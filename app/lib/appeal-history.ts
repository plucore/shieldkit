/**
 * app/lib/appeal-history.ts
 *
 * Pure helpers for the appeal-letter history list. Kept out of the route module
 * so the per-day title/ordinal logic is unit-testable.
 */

export interface SavedLetter {
  id: string;
  suspensionReason: string | null;
  letter: string;
  createdAt: string;
}

/**
 * Titles each history entry "Appeal letter, YYYY-MM-DD", with a "-N" suffix
 * (generation order within that day) when a day has more than one. Separators
 * are commas and plain hyphens only, never em/en dashes.
 *
 * `entries` is expected newest-first (the loader order), so within a day the
 * oldest (generated first) is last; the ordinal in generation order is
 * therefore `length - index`.
 */
export function buildHistoryTitles(
  entries: SavedLetter[],
): Record<string, string> {
  const byDay: Record<string, SavedLetter[]> = {};
  for (const e of entries) {
    const day = e.createdAt.slice(0, 10);
    (byDay[day] ??= []).push(e);
  }
  const titles: Record<string, string> = {};
  for (const day of Object.keys(byDay)) {
    const list = byDay[day];
    for (const e of list) {
      const base = `Appeal letter, ${day}`;
      titles[e.id] =
        list.length > 1 ? `${base}-${list.length - list.indexOf(e)}` : base;
    }
  }
  return titles;
}
