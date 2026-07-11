/**
 * app/components/AIVisibilityCard.tsx
 *
 * Phase 7.2 — Dashboard aside card showing llms.txt crawler hits over
 * the last 7 days vs the prior 7 days, plus the top 3 crawlers by name.
 *
 * Only rendered for merchants with monitoring access (tier='monitoring',
 * 'recovery', or grandfathered 'pro'). The parent gate lives in
 * app/routes/app._index.tsx via hasPaidAccess — this component
 * assumes its props are already filtered.
 */

import { wowDeltaPct } from "../lib/ai-visibility/identify-crawler";

interface AIVisibilityCardProps {
  thisWeekHits: number;
  priorWeekHits: number;
  topCrawlers: string[]; // up to 3, name only
}

// Map raw AI-engine agent names (as stored in llms_txt_requests.crawler_name,
// produced by identify-crawler) to consumer-recognizable brands. Unknown names
// fall back to the raw string.
const FRIENDLY_BOT: Record<string, string> = {
  GPTBot: "ChatGPT",
  "ChatGPT-User": "ChatGPT",
  "OAI-SearchBot": "ChatGPT",
  ClaudeBot: "Claude",
  "anthropic-ai": "Claude",
  "Google-Extended": "Google AI",
  Googlebot: "Google",
  Bingbot: "Bing",
  PerplexityBot: "Perplexity",
  CCBot: "Common Crawl",
  Bytespider: "TikTok",
  Applebot: "Apple",
  Amazonbot: "Amazon",
  FacebookBot: "Meta",
  DuckAssistBot: "DuckDuckGo",
  "MistralAI-User": "Mistral",
  "cohere-ai": "Cohere",
  YouBot: "You.com",
};

function friendlyBot(name: string): string {
  return FRIENDLY_BOT[name] ?? name;
}

export default function AIVisibilityCard({
  thisWeekHits,
  priorWeekHits,
  topCrawlers,
}: AIVisibilityCardProps) {
  // Hide the card entirely when there's nothing to show — no persistent
  // "not yet" empty state taking up space in the aside.
  if (thisWeekHits === 0 && priorWeekHits === 0) return null;

  const wow = wowDeltaPct(thisWeekHits, priorWeekHits);
  const seenBy = [...new Set(topCrawlers.map(friendlyBot))];

  return (
    <s-card>
      <div style={{ padding: "16px" }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--p-color-text-subdued, #6d7175)",
            marginBottom: "8px",
          }}
        >
          AI search visibility
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "14px",
            color: "var(--p-color-text, #0F172A)",
            lineHeight: 1.45,
          }}
        >
          AI engines read your store <strong>{thisWeekHits}</strong> time
          {thisWeekHits === 1 ? "" : "s"} this week
          {priorWeekHits > 0 ? (
            <>
              {" "}
              <span
                style={{
                  color:
                    wow >= 0
                      ? "var(--p-color-text-success, #1a9e5c)"
                      : "var(--p-color-text-critical, #e51c00)",
                }}
              >
                ({wow >= 0 ? "+" : ""}
                {wow}% vs last week)
              </span>
            </>
          ) : null}
          {seenBy.length > 0 && (
            <>
              .{" "}
              <span style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>
                Seen by: {seenBy.join(", ")}.
              </span>
            </>
          )}
        </p>
      </div>
    </s-card>
  );
}
