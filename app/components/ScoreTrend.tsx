/**
 * app/components/ScoreTrend.tsx
 *
 * Phase 7 quick win 3 — 30-day score trend strip for the dashboard.
 *
 * Renders above the KPI cards. Empty state when fewer than 2 scans exist
 * in the last 30 days; otherwise summarises first→last score, the delta
 * over N days, and the count of issues fixed across that span. Sparkline
 * is inline SVG (no chart library) capped at 30 data points.
 *
 * Issues-fixed count is computed from (total_checks - passed_checks) on
 * the first vs. last scan and clamped to >= 0.
 */

import type { Scan } from "../lib/types";

interface ScoreTrendProps {
  scans: Scan[];
  currentScore: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 30;
const NAVY = "#0F172A";

function failuresOf(scan: Scan): number {
  const total = scan.total_checks ?? 0;
  const passed = scan.passed_checks ?? 0;
  return Math.max(0, total - passed);
}

export function computeTrend(scans: Scan[]) {
  // Filter to last 30 days, ascending by created_at.
  const cutoff = Date.now() - 30 * DAY_MS;
  const recent = scans
    .filter((s) => new Date(s.created_at).getTime() >= cutoff)
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

  if (recent.length < 2) {
    return { hasTrend: false as const, points: recent };
  }

  const points = recent.slice(-MAX_POINTS);
  const first = points[0];
  const last = points[points.length - 1];

  const firstScore = Math.round(first.compliance_score ?? 0);
  const lastScore = Math.round(last.compliance_score ?? 0);
  const delta = lastScore - firstScore;

  const days = Math.max(
    1,
    Math.round(
      (new Date(last.created_at).getTime() -
        new Date(first.created_at).getTime()) /
        DAY_MS,
    ),
  );

  const fixedCount = Math.max(0, failuresOf(first) - failuresOf(last));

  return {
    hasTrend: true as const,
    points,
    firstScore,
    lastScore,
    delta,
    days,
    fixedCount,
  };
}

function Sparkline({ scans }: { scans: Scan[] }) {
  const values = scans.map((s) => Math.round(s.compliance_score ?? 0));
  if (values.length < 2) return null;

  const W = 240;
  const H = 48;
  const PAD = 2;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const range = max - min || 1;
  const stepX = (W - PAD * 2) / (values.length - 1);

  const path = values
    .map((v, i) => {
      const x = PAD + i * stepX;
      const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Compliance score trend"
      style={{ display: "block" }}
    >
      <path
        d={path}
        fill="none"
        stroke={NAVY}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ScoreTrend({ scans, currentScore: _currentScore }: ScoreTrendProps) {
  const trend = computeTrend(scans);

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
          Score trend (last 30 days)
        </div>
        {!trend.hasTrend ? (
          <div
            style={{
              fontSize: "14px",
              color: "var(--p-color-text-subdued, #6d7175)",
            }}
          >
            Run another scan to track your progress over time.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "8px",
                fontSize: "18px",
                fontWeight: 600,
                color: "var(--p-color-text, #0F172A)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <span>
                {trend.firstScore} → {trend.lastScore}
              </span>
              <span
                style={{
                  fontSize: "14px",
                  fontWeight: 500,
                  color:
                    trend.delta >= 0
                      ? "var(--p-color-text-success, #1a9e5c)"
                      : "var(--p-color-text-critical, #e51c00)",
                }}
              >
                ({trend.delta >= 0 ? "+" : ""}
                {trend.delta} in {trend.days} day{trend.days === 1 ? "" : "s"})
              </span>
            </div>
            <Sparkline scans={trend.points} />
            <div
              style={{
                fontSize: "13px",
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              {trend.fixedCount} issue{trend.fixedCount === 1 ? "" : "s"} fixed.
            </div>
          </div>
        )}
      </div>
    </s-card>
  );
}
