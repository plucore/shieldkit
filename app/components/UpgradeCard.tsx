/**
 * app/components/UpgradeCard.tsx
 *
 * Upgrade CTA card for free-tier users.
 * Uses useWebComponentClick for native DOM event handling on <s-button>.
 *
 * When `sidebar` is true, renders in the aside slot with a compact layout.
 */

import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface UpgradeCardProps {
  onUpgrade: () => void;
  sidebar?: boolean;
}

export default function UpgradeCard({ onUpgrade, sidebar }: UpgradeCardProps) {
  const upgradeRef = useWebComponentClick<HTMLElement>(onUpgrade);

  const features = [
    "Unlimited compliance re-scans",
    "AI-powered policy generation",
    "Full scan history & tracking",
  ];

  return (
    <s-section {...(sidebar ? { slot: "aside" } : {})}>
      {sidebar && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            Upgrade to Pro
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
              Upgrade to Pro — $29
            </div>
          )}
          <div
            style={{
              fontSize: "14px",
              color: "var(--p-color-text-subdued, #6d7175)",
              marginBottom: sidebar ? "12px" : "16px",
            }}
          >
            {sidebar
              ? "Unlock unlimited re-scans, AI policy generation, and full scan history for just $29."
              : "Keep your Google Merchant Center account safe with continuous monitoring."}
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
              {features.map((feature) => (
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
              {features.map((feature) => (
                <div key={feature} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <s-icon type="check-circle-filled" tone="success" size="small" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          )}
          <s-button variant="primary" ref={upgradeRef}>
            Upgrade to Pro{sidebar ? " — $29" : ""}
          </s-button>
        </div>
      </s-card>
    </s-section>
  );
}
