/**
 * app/components/PlanStatusCard.tsx
 *
 * Replaces the v3 UpgradeCard. Single component, two states driven by
 * hasPaidAccess(tier):
 *
 *   Paid state — "Your ShieldKit coverage"
 *     Reassurance card: every paid feature with a green check, no CTA,
 *     no urgency. The JSON-LD row reflects actual state (Active vs Off)
 *     as a display-only status — the enable action lives in the JSON-LD
 *     aside card, not here, so there's exactly one control surface.
 *
 *   Free state — "Fix it now — and stay protected."
 *     Upgrade prompt: free items checked, paid items locked + muted.
 *     One CTA → /app/upgrade. No price is rendered in-app — the live price
 *     is shown on Shopify's hosted managed-pricing page after click-through.
 *
 * Placed at the top of the dashboard aside (above Security Status).
 * Pure component — feature lists come from app/lib/billing/plans.ts so
 * pricing-page copy and dashboard copy stay in lockstep.
 */

import { PAID_FEATURES, FREE_FEATURES } from "../lib/billing/plans";
import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface PlanStatusCardProps {
  isPaid: boolean;
  /**
   * Has the merchant enabled JSON-LD? In the v4 two-state model this flips
   * true the moment they click Enable; the compliance scan's
   * `structured_data_json_ld` check is what tells them whether the block is
   * actually rendering.
   */
  jsonLdEnabled: boolean;
  /** Called when the merchant clicks the upgrade CTA on the free card. */
  onUpgrade: () => void;
}

// Single index points at the JSON-LD entry so we know which row to mark
// "active" vs "off" without string-matching.
const PAID_JSON_LD_INDEX = PAID_FEATURES.findIndex((f) =>
  f.toLowerCase().includes("json-ld product schema"),
);
const FREE_JSON_LD_INDEX = FREE_FEATURES.findIndex((f) =>
  f.toLowerCase().includes("json-ld product schema"),
);

export default function PlanStatusCard({
  isPaid,
  jsonLdEnabled,
  onUpgrade,
}: PlanStatusCardProps) {
  if (isPaid) {
    return <PaidCoverageCard jsonLdEnabled={jsonLdEnabled} />;
  }
  return <FreeUpgradeCard onUpgrade={onUpgrade} />;
}

/* ─── Paid state ──────────────────────────────────────────────────────── */

function PaidCoverageCard({ jsonLdEnabled }: { jsonLdEnabled: boolean }) {
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
            // JSON-LD row is display-only: shows the merchant's current
            // enabled state. The actual enable action lives in the JSON-LD
            // aside card below, not here — having two competing controls
            // confused merchants in user testing.
            if (isJsonLdRow && !jsonLdEnabled) {
              return <FeatureRow key={feature} state="off" text={feature} />;
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
            Unlock everything
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
  state: "checked" | "locked" | "off";
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
      case "off":
        // Display-only "not currently on" indicator — muted, no action.
        return {
          icon: "circle" as const,
          tone: "subdued" as const,
          textColor: "var(--p-color-text-subdued, #6d7175)",
          opacity: 0.75,
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
