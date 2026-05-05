/**
 * app/components/AIVisibilityCard.tsx
 *
 * Phase 7.2 — Dashboard aside card showing llms.txt crawler hits over
 * the last 7 days vs the prior 7 days, plus the top 3 crawlers by name.
 *
 * Only rendered for Shield Max merchants (tier='pro'). The parent gate
 * lives in app/routes/app._index.tsx — this component assumes its props
 * are already filtered.
 */

import { wowDeltaPct } from "../lib/ai-visibility/identify-crawler";

interface AIVisibilityCardProps {
  thisWeekHits: number;
  priorWeekHits: number;
  topCrawlers: string[]; // up to 3, name only
}

export default function AIVisibilityCard({
  thisWeekHits,
  priorWeekHits,
  topCrawlers,
}: AIVisibilityCardProps) {
  const isEmpty = thisWeekHits === 0 && priorWeekHits === 0;
  const wow = wowDeltaPct(thisWeekHits, priorWeekHits);

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
          AI visibility
        </div>
        {isEmpty ? (
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              color: "var(--p-color-text-subdued, #6d7175)",
              lineHeight: 1.45,
            }}
          >
            Your llms.txt has not been crawled yet. AI engines typically
            discover new content within 7-30 days of publishing.
          </p>
        ) : (
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              color: "var(--p-color-text, #0F172A)",
              lineHeight: 1.45,
            }}
          >
            <strong>{thisWeekHits}</strong> crawler hit
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
                  {wow}% WoW)
                </span>
              </>
            ) : null}
            {topCrawlers.length > 0 && (
              <>
                .{" "}
                <span
                  style={{ color: "var(--p-color-text-subdued, #6d7175)" }}
                >
                  Top: {topCrawlers.join(", ")}.
                </span>
              </>
            )}
          </p>
        )}
      </div>
    </s-card>
  );
}
