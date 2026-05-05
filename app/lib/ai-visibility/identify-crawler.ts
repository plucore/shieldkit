/**
 * app/lib/ai-visibility/identify-crawler.ts
 *
 * Phase 7.2 — Pure isomorphic helpers for AI-crawler identification
 * and Week-over-Week math. Lives outside the .server module so the
 * dashboard component (AIVisibilityCard) can import it without
 * triggering React Router's "server-only module referenced by client"
 * build error.
 */

interface CrawlerPattern {
  name: string;
  match: string; // case-insensitive substring
}

// Order matters: more specific patterns first.
const CRAWLER_PATTERNS: CrawlerPattern[] = [
  { name: "GPTBot", match: "gptbot" },
  { name: "ChatGPT-User", match: "chatgpt-user" },
  { name: "OAI-SearchBot", match: "oai-searchbot" },
  { name: "ClaudeBot", match: "claudebot" },
  { name: "anthropic-ai", match: "anthropic-ai" },
  { name: "Google-Extended", match: "google-extended" },
  { name: "Googlebot", match: "googlebot" },
  { name: "Bingbot", match: "bingbot" },
  { name: "PerplexityBot", match: "perplexitybot" },
  { name: "CCBot", match: "ccbot" },
  { name: "Bytespider", match: "bytespider" },
  { name: "Applebot", match: "applebot" },
  { name: "Amazonbot", match: "amazonbot" },
  { name: "FacebookBot", match: "facebookbot" },
  { name: "DuckAssistBot", match: "duckassistbot" },
  { name: "MistralAI-User", match: "mistralai-user" },
  { name: "cohere-ai", match: "cohere-ai" },
  { name: "Diffbot", match: "diffbot" },
  { name: "YouBot", match: "youbot" },
];

export function identifyCrawler(userAgent: string | null | undefined): string {
  if (!userAgent) return "other";
  const lower = userAgent.toLowerCase();
  for (const { name, match } of CRAWLER_PATTERNS) {
    if (lower.includes(match)) return name;
  }
  return "other";
}

// Week-over-Week percent delta. Returns 0 when prior window had 0
// (no baseline).
export function wowDeltaPct(thisWeek: number, priorWeek: number): number {
  if (priorWeek <= 0) return 0;
  return Math.round(((thisWeek - priorWeek) / priorWeek) * 100);
}
