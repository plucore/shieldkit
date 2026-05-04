/**
 * app/components/UpgradeCard.tsx
 *
 * Tier-aware sidebar/main upgrade CTA.
 *
 * Free merchants see Shield Pro ($14/mo) upsell with its feature highlights.
 * Shield Pro merchants see Shield Max ($39/mo) upsell focused on AI search visibility.
 * Shield Max merchants should not render this card — gate at the call site.
 *
 * Uses useWebComponentClick for native DOM event handling on <s-button>
 * (synthetic React onClick does not fire on Polaris web components).
 */

import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface UpgradeCardProps {
  tier: string; // "free" | "shield" | (other tiers should not render this card)
  onUpgrade: () => void;
  sidebar?: boolean;
}

const COPY: Record<
  "free" | "shield",
  {
    heading: string;
    sidebarBlurb: string;
    mainBlurb: string;
    features: string[];
    cta: string;
    sidebarCta: string;
  }
> = {
  free: {
    heading: "Upgrade to Shield Pro",
    sidebarBlurb:
      "Get unlimited scans, continuous monitoring, and AI policy generation from $14/month.",
    mainBlurb:
      "Continuous compliance monitoring. Stay one step ahead of GMC suspensions.",
    features: [
      "Unlimited compliance scans",
      "Weekly health digest email",
      "GMC re-review appeal letter",
      "AI-powered policy generator",
    ],
    cta: "See plans",
    sidebarCta: "Upgrade — from $14/mo",
  },
  shield: {
    heading: "Upgrade to Shield Max",
    sidebarBlurb:
      "Make your products show up correctly in Google AI Overviews and ChatGPT shopping.",
    mainBlurb:
      "Full Merchant Listings JSON-LD enrichment, llms.txt at root, AI bot controls.",
    features: [
      "Merchant Listings JSON-LD enricher",
      "GTIN / MPN / brand auto-filler",
      "llms.txt at root domain",
      "AI bot allow/block toggle",
    ],
    cta: "Upgrade to Shield Max",
    sidebarCta: "Upgrade to Shield Max — $39/mo",
  },
};

export default function UpgradeCard({ tier, onUpgrade, sidebar }: UpgradeCardProps) {
  const upgradeRef = useWebComponentClick<HTMLElement>(onUpgrade);

  // Defensive: if a non-upgradeable tier slipped through, render nothing.
  const copy = tier === "shield" ? COPY.shield : COPY.free;

  return (
    <s-section {...(sidebar ? { slot: "aside" } : {})}>
      {sidebar && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            {copy.heading}
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
              {copy.heading}
            </div>
          )}
          <div
            style={{
              fontSize: "14px",
              color: "var(--p-color-text-subdued, #6d7175)",
              marginBottom: sidebar ? "12px" : "16px",
            }}
          >
            {sidebar ? copy.sidebarBlurb : copy.mainBlurb}
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
              {copy.features.map((feature) => (
                <div key={feature} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <s-icon type="check-circle-filled" tone="success" size="base" />
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
              {copy.features.map((feature) => (
                <div key={feature} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <s-icon type="check-circle-filled" tone="success" size="small" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          )}
          <s-button variant="primary" ref={upgradeRef}>
            {sidebar ? copy.sidebarCta : copy.cta}
          </s-button>
        </div>
      </s-card>
    </s-section>
  );
}
