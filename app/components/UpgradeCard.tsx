/**
 * app/components/UpgradeCard.tsx
 *
 * Upgrade CTA card shown to free-tier users who have exhausted their scan.
 * Uses useWebComponentClick for native DOM event handling on <s-button>.
 */

import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface UpgradeCardProps {
  onUpgrade: () => void;
}

export default function UpgradeCard({ onUpgrade }: UpgradeCardProps) {
  const upgradeRef = useWebComponentClick<HTMLElement>(onUpgrade);

  return (
    <s-section>
      <s-card>
        <div style={{ padding: "20px 0" }}>
          <div
            style={{
              fontSize: "20px",
              fontWeight: 800,
              color: "#0f172a",
              marginBottom: "8px",
            }}
          >
            Upgrade to Pro — $39/mo
          </div>
          <div
            style={{
              fontSize: "14px",
              color: "var(--p-color-text-subdued, #6d7175)",
              marginBottom: "16px",
            }}
          >
            Keep your Google Merchant Center account safe with continuous monitoring.
          </div>
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
            {[
              "Unlimited compliance re-scans",
              "AI-powered policy generation",
              "Full scan history & tracking",
              "Weekly automated monitoring",
            ].map((feature) => (
              <div key={feature} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <s-icon type="check-circle-filled" tone="success" size="base" />
                <span>{feature}</span>
              </div>
            ))}
          </div>
          <s-button variant="primary" ref={upgradeRef}>
            Upgrade to Pro
          </s-button>
        </div>
      </s-card>
    </s-section>
  );
}
