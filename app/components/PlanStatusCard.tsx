/**
 * app/components/PlanStatusCard.tsx
 *
 * Replaces the v3 UpgradeCard. Single component, two states driven by
 * hasPaidAccess(tier):
 *
 *   Paid state — "Your ShieldKit coverage"
 *     Reassurance card: every paid feature with a green check, no CTA,
 *     no urgency. The JSON-LD row reflects ACTUAL state (verified vs
 *     not-yet-verified) so it doubles as a status surface.
 *
 *   Free state — "Fix it now — and stay protected."
 *     Upgrade prompt: free items checked, paid items locked + muted.
 *     One CTA → /app/upgrade at $49/mo or $449/yr.
 *
 * Placed at the top of the dashboard aside (above Security Status).
 * Pure component — feature lists come from app/lib/billing/plans.ts so
 * pricing-page copy and dashboard copy stay in lockstep.
 */

import { PAID_FEATURES, FREE_FEATURES, PLANS } from "../lib/billing/plans";
import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface PlanStatusCardProps {
  isPaid: boolean;
  /** Has the JSON-LD theme block been verified live on the storefront? */
  jsonLdVerified: boolean;
  /**
   * Called when the merchant clicks the "Turn on" link inside the
   * JSON-LD row on the paid card. Should open the theme editor enable
   * flow (same path as the aside JSON-LD card uses).
   */
  onEnableJsonLd: () => void;
  /** Called when the merchant clicks the upgrade CTA on the free card. */
  onUpgrade: () => void;
}

// Single index points at the JSON-LD entry so we know which row to mark
// "verified" vs "turn on" without string-matching.
const PAID_JSON_LD_INDEX = PAID_FEATURES.findIndex((f) =>
  f.toLowerCase().includes("json-ld product schema"),
);
const FREE_JSON_LD_INDEX = FREE_FEATURES.findIndex((f) =>
  f.toLowerCase().includes("json-ld product schema"),
);

export default function PlanStatusCard({
  isPaid,
  jsonLdVerified,
  onEnableJsonLd,
  onUpgrade,
}: PlanStatusCardProps) {
  if (isPaid) {
    return (
      <PaidCoverageCard
        jsonLdVerified={jsonLdVerified}
        onEnableJsonLd={onEnableJsonLd}
      />
    );
  }
  return <FreeUpgradeCard onUpgrade={onUpgrade} />;
}

/* ─── Paid state ──────────────────────────────────────────────────────── */

function PaidCoverageCard({
  jsonLdVerified,
  onEnableJsonLd,
}: {
  jsonLdVerified: boolean;
  onEnableJsonLd: () => void;
}) {
  return (
    <s-section slot="aside">
      <div style={{ marginBottom: "12px" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
          Your ShieldKit coverage
        </div>
      </div>
      <s-card>
        <div
          style={{
            padding: "12px 0",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            fontSize: "13px",
            color: "var(--p-color-text, #303030)",
          }}
        >
          {PAID_FEATURES.map((feature, i) => {
            const isJsonLdRow = i === PAID_JSON_LD_INDEX;
            if (isJsonLdRow && !jsonLdVerified) {
              return (
                <FeatureRow
                  key={feature}
                  state="pending"
                  text={feature}
                  trailing={
                    <button
                      type="button"
                      onClick={onEnableJsonLd}
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#e8820c",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        textDecoration: "underline",
                        padding: 0,
                      }}
                    >
                      Turn on
                    </button>
                  }
                />
              );
            }
            return <FeatureRow key={feature} state="checked" text={feature} />;
          })}
        </div>
      </s-card>
    </s-section>
  );
}

/* ─── Free state ──────────────────────────────────────────────────────── */

const HEADING_FREE = "Fix it now — and stay protected.";

function FreeUpgradeCard({ onUpgrade }: { onUpgrade: () => void }) {
  const upgradeRef = useWebComponentClick<HTMLElement>(onUpgrade);
  // Items the free plan ALREADY gets (so they render checked, not locked).
  const freeLowercased = new Set(
    FREE_FEATURES.map((f) => f.toLowerCase()),
  );

  return (
    <s-section slot="aside">
      <div style={{ marginBottom: "12px" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
          {HEADING_FREE}
        </div>
      </div>
      <s-card>
        <div
          style={{
            padding: "12px 0",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            fontSize: "13px",
          }}
        >
          {/* Free-tier items (checked) */}
          {FREE_FEATURES.map((feature) => (
            <FeatureRow key={feature} state="checked" text={feature} />
          ))}
          {/* Paid-only items (locked + muted) */}
          {PAID_FEATURES.filter(
            (f, i) =>
              i !== PAID_JSON_LD_INDEX &&
              !freeLowercased.has(f.toLowerCase()),
          ).map((feature) => (
            <FeatureRow key={feature} state="locked" text={feature} />
          ))}
        </div>
        <div style={{ marginTop: "14px" }}>
          <s-button variant="primary" ref={upgradeRef}>
            Unlock everything — ${PLANS.monitoring_monthly.monthly}/mo or $
            {PLANS.monitoring_annual.annual}/yr
          </s-button>
        </div>
      </s-card>
    </s-section>
  );
}

/* ─── Row primitive ───────────────────────────────────────────────────── */

function FeatureRow({
  state,
  text,
  trailing,
}: {
  state: "checked" | "locked" | "pending";
  text: string;
  trailing?: React.ReactNode;
}) {
  const iconAndColor = (() => {
    switch (state) {
      case "checked":
        return {
          icon: "check-circle-filled" as const,
          tone: "success" as const,
          textColor: "var(--p-color-text, #303030)",
          opacity: 1,
        };
      case "pending":
        return {
          icon: "clock" as const,
          tone: "caution" as const,
          textColor: "var(--p-color-text, #303030)",
          opacity: 1,
        };
      case "locked":
        return {
          icon: "lock" as const,
          tone: "subdued" as const,
          textColor: "var(--p-color-text-subdued, #6d7175)",
          opacity: 0.7,
        };
    }
  })();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        opacity: iconAndColor.opacity,
      }}
    >
      <s-icon
        type={iconAndColor.icon}
        tone={iconAndColor.tone}
        size="small"
      />
      <span style={{ flex: 1, color: iconAndColor.textColor }}>{text}</span>
      {trailing}
    </div>
  );
}
