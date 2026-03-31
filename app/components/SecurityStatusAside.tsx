/**
 * app/components/SecurityStatusAside.tsx
 *
 * Sidebar card showing threat level, trend arrow, and issue summary.
 */

import type { Scan } from "../lib/types";
import { threatLabel, threatColor, threatBarGradient } from "../lib/scan-helpers";

interface SecurityStatusAsideProps {
  score: number | null;
  criticalCount: number;
  warningCount: number;
  previousScan: Scan | null;
}

export default function SecurityStatusAside({
  score,
  criticalCount,
  warningCount,
  previousScan,
}: SecurityStatusAsideProps) {
  // Trend calculation
  let trendArrow = "";
  let trendText = "";
  if (score !== null && previousScan?.compliance_score != null) {
    const prevScore = previousScan.compliance_score;
    if (score > prevScore) {
      trendArrow = "↑";
      trendText = `Improved from ${prevScore}%`;
    } else if (score < prevScore) {
      trendArrow = "↓";
      trendText = `Declined from ${prevScore}%`;
    } else {
      trendArrow = "→";
      trendText = "Unchanged";
    }
  }

  return (
    <s-section slot="aside" heading="Security Status">
      {score !== null ? (
        <div style={{ padding: "4px 0" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--p-color-text-subdued, #6d7175)",
                marginBottom: "6px",
              }}
            >
              Threat Level
            </div>
            <div
              style={{
                fontSize: "26px",
                fontWeight: 800,
                color: threatColor(score),
                lineHeight: 1.1,
              }}
            >
              {threatLabel(score)}
            </div>
            {trendArrow && (
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "13px",
                  color: trendArrow === "↑" ? "#1a9e5c" : trendArrow === "↓" ? "#e51c00" : "#6d7175",
                  fontWeight: 600,
                }}
              >
                {trendArrow} {trendText}
              </div>
            )}
          </div>

          <div
            style={{
              height: "8px",
              background: "var(--p-color-bg-surface-secondary, #f1f2f3)",
              borderRadius: "4px",
              overflow: "hidden",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.max(4, 100 - score)}%`,
                background: `linear-gradient(to right, ${threatBarGradient(score)})`,
                borderRadius: "4px",
                transition: "width 0.4s ease",
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              fontSize: "13px",
            }}
          >
            {criticalCount > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  background: "var(--p-color-bg-critical-subdued, #fff4f4)",
                  borderRadius: "6px",
                  border: "1px solid var(--p-color-border-critical-subdued, #ffd2cc)",
                }}
              >
                <s-icon type="x-circle-filled" tone="critical" size="base" />
                <span>
                  <strong>{criticalCount}</strong> critical issue
                  {criticalCount > 1 ? "s" : ""}
                </span>
              </div>
            )}
            {warningCount > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  background: "var(--p-color-bg-caution-subdued, #fff5ea)",
                  borderRadius: "6px",
                  border: "1px solid var(--p-color-border-caution-subdued, #ffd79d)",
                }}
              >
                <s-icon
                  type="alert-triangle-filled"
                  tone="caution"
                  size="base"
                />
                <span>
                  <strong>{warningCount}</strong> warning
                  {warningCount > 1 ? "s" : ""}
                </span>
              </div>
            )}
            {criticalCount === 0 && warningCount === 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  background: "var(--p-color-bg-success-subdued, #f1f8f5)",
                  borderRadius: "6px",
                  border: "1px solid var(--p-color-border-success-subdued, #95c9a8)",
                }}
              >
                <s-icon
                  type="check-circle-filled"
                  tone="success"
                  size="base"
                />
                <span>No critical threats detected</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <s-paragraph>
          Run your first scan to see your store's threat level and
          security status.
        </s-paragraph>
      )}
    </s-section>
  );
}
