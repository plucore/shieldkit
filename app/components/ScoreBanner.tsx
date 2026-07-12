/**
 * app/components/ScoreBanner.tsx
 *
 * Large compliance score display with progress bar, scan timestamp,
 * and automated scan info for Pro merchants.
 */

import type { Merchant, Scan } from "../lib/types";
import { fmtDate, fmtDateShort, scoreColor } from "../lib/scan-helpers";
import { hasPaidAccess } from "../lib/billing/plans";

interface ScoreBannerProps {
  merchant: Merchant;
  score: number | null;
  latestScan: Scan;
  lastAutomatedScan: Scan | null;
  newAutoIssueCount: number;
  isScanning: boolean;
}

export default function ScoreBanner({
  merchant,
  score,
  latestScan,
  lastAutomatedScan,
  newAutoIssueCount,
  isScanning,
}: ScoreBannerProps) {
  return (
    <s-section>
      <s-card>
        <div style={{ padding: "4px 0" }}>
          <div style={{ textAlign: "center", marginBottom: "20px" }}>
            <span
              style={{
                background: "#f1f5f9",
                padding: "8px 20px",
                borderRadius: "20px",
                display: "inline-block",
                fontSize: "16px",
                fontWeight: 600,
                color: "#0f172a",
                wordBreak: "break-all",
              }}
            >
              {merchant.shopify_domain}
            </span>
          </div>

          <div style={{ textAlign: "center", marginBottom: "24px" }}>
            <div
              style={{
                fontSize: "64px",
                fontWeight: 800,
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                color: score === null ? "var(--p-color-text, #303030)" : scoreColor(score),
              }}
            >
              {score !== null ? `${score}%` : ", "}
            </div>
            <div
              style={{
                marginTop: "6px",
                fontSize: "14px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              Compliance Score
            </div>
          </div>

          {score !== null && (
            <div
              style={{
                height: "10px",
                background: "var(--p-color-bg-surface-secondary, #f1f2f3)",
                borderRadius: "5px",
                overflow: "hidden",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${score}%`,
                  background: scoreColor(score),
                  borderRadius: "5px",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
            {isScanning ? (
              <s-badge tone="info">Running all 12 compliance checks…</s-badge>
            ) : (
              <s-badge tone="neutral">
                Last scanned {fmtDate(latestScan.created_at)}
              </s-badge>
            )}
          </div>

          {/* v4 §8 — ongoing-value reassurance line for paid merchants whose
              latest scan is clean (score ≥ 80, no critical AND no warning
              issues). Reframes the "fixed" moment as continuous protection
              rather than a done job, reduces the post-fix cancellation reflex.
              Warnings must be zero too: several checks are now WARNING (not
              CRITICAL), so gating on critical_count alone would assert "clean"
              while real warnings remain (mirrors SecurityStatusAside). */}
          {hasPaidAccess(merchant.tier) &&
            !isScanning &&
            score !== null &&
            score >= 80 &&
            (latestScan.critical_count ?? 0) === 0 &&
            (latestScan.warning_count ?? 0) === 0 && (
              <div
                style={{
                  marginTop: "12px",
                  textAlign: "center",
                  fontSize: "13px",
                  color: "var(--p-color-text-subdued, #6d7175)",
                  lineHeight: 1.5,
                  maxWidth: "560px",
                  marginLeft: "auto",
                  marginRight: "auto",
                }}
              >
                Your store looks clean. ShieldKit keeps your Google listings
                and AI-search visibility working, and lets you re-scan any
                time you change something.
              </div>
            )}

          {/* Automated scan info for paid merchants (legacy — kept for any
              still-present automated scan rows from pre-v4 weekly crons). */}
          {hasPaidAccess(merchant.tier) && lastAutomatedScan && !isScanning && (
            <div
              style={{
                marginTop: "12px",
                textAlign: "center",
                fontSize: "13px",
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              Last automated scan: {fmtDateShort(lastAutomatedScan.created_at)}
            </div>
          )}
        </div>
      </s-card>

      {/* Automated monitoring detected new issues banner */}
      {hasPaidAccess(merchant.tier) && newAutoIssueCount > 0 && (
        <div style={{ marginTop: "12px" }}>
          <s-banner tone="warning">
            Your automated monitoring detected {newAutoIssueCount} new issue
            {newAutoIssueCount > 1 ? "s" : ""} since your last scan.
          </s-banner>
        </div>
      )}
    </s-section>
  );
}
