/**
 * app/components/UpgradeCard.tsx
 *
 * Sidebar/main upgrade CTA shown to any merchant without Recovery access
 * (free / shield / monitoring / unknown). Recovery-tier merchants and
 * grandfathered Shield Max (tier='pro') do NOT render this card — gate at
 * the call site via hasRecoveryAccess.
 *
 * Uses useWebComponentClick for native DOM event handling on <s-button>
 * (synthetic React onClick does not fire on Polaris web components).
 */

import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface UpgradeCardProps {
  tier: string; // retained for call-site debugging / future per-tier nuance
  onUpgrade: () => void;
  sidebar?: boolean;
}

const HEADING = "Suspended or at risk? Get the full fix.";
const BODY =
  "Recovery gives you AI-written policies, a GMC appeal letter, and product data fixes — everything you need to get reinstated and stay that way.";
const FEATURES = [
  "AI-written policies",
  "GMC re-review appeal letter",
  "Product data fixes (GTIN/MPN/brand)",
  "Unlimited on-demand scans",
];
const CTA_FULL = "See Recovery";
const CTA_SIDEBAR = "See Recovery";

export default function UpgradeCard({ onUpgrade, sidebar }: UpgradeCardProps) {
  const upgradeRef = useWebComponentClick<HTMLElement>(onUpgrade);

  return (
    <s-section {...(sidebar ? { slot: "aside" } : {})}>
      {sidebar && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            {HEADING}
          </div>
        </div>
      )}
      <s-card>
        <div style={{ padding: sidebar ? "12px 0" : "20px 0" }}>
          {!sidebar && (
            <div
              style={{
                fontSize: "20px",
                fontWeight: 800,
                color: "#0f172a",
                marginBottom: "8px",
              }}
            >
              {HEADING}
            </div>
          )}
          <div
            style={{
              fontSize: "14px",
              color: "var(--p-color-text-subdued, #6d7175)",
              marginBottom: sidebar ? "12px" : "16px",
            }}
          >
            {BODY}
          </div>
          {!sidebar && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
                marginBottom: "20px",
                fontSize: "14px",
                color: "var(--p-color-text, #303030)",
              }}
            >
              {FEATURES.map((feature) => (
                <div
                  key={feature}
                  style={{ display: "flex", gap: "6px", alignItems: "center" }}
                >
                  <s-icon
                    type="check-circle-filled"
                    tone="success"
                    size="base"
                  />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          )}
          {sidebar && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                marginBottom: "12px",
                fontSize: "13px",
                color: "var(--p-color-text, #303030)",
              }}
            >
              {FEATURES.map((feature) => (
                <div
                  key={feature}
                  style={{ display: "flex", gap: "6px", alignItems: "center" }}
                >
                  <s-icon
                    type="check-circle-filled"
                    tone="success"
                    size="small"
                  />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          )}
          <s-button variant="primary" ref={upgradeRef}>
            {sidebar ? CTA_SIDEBAR : CTA_FULL}
          </s-button>
        </div>
      </s-card>
    </s-section>
  );
}
