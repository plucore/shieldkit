/**
 * app/lib/text-normalize.ts
 *
 * House style: no em dashes (—, U+2014) or en dashes (–, U+2013) in user-facing
 * copy. Models ignore the prompt instruction often, so every generated body is
 * post-processed through normalizeDashes before it is saved/returned. Pure and
 * framework-free so both the policy generator and the appeal-letter generator
 * can import it, and so it's unit-testable.
 */

/**
 * Replaces em/en dashes used as punctuation or numeric ranges. Never touches
 * ASCII hyphens (U+002D) or hyphenated words.
 *
 *  - em dash (—) used as punctuation -> comma + space ("a — b" -> "a, b")
 *  - en dash (–) in a numeric/date range -> hyphen ("1–3" -> "1-3")
 *  - any remaining en dash (punctuation) -> comma + space
 */
export function normalizeDashes(input: string): string {
  if (!input) return input;
  return input
    // Numeric/date range first so the digits survive the punctuation pass.
    .replace(/(\d)\s*–\s*(\d)/g, "$1-$2")
    // Em dash as punctuation, collapsing any surrounding whitespace.
    .replace(/\s*—\s*/g, ", ")
    // Any remaining en dash used as punctuation.
    .replace(/\s*–\s*/g, ", ");
}
