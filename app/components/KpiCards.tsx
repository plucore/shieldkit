/**
 * app/components/KpiCards.tsx
 *
 * Four KPI metric cards: Checks Passed, Critical Threats, Warnings, Skipped.
 */

interface KpiCardsProps {
  truePassedCount: number;
  totalChecks: number;
  criticalCount: number;
  warningCount: number;
  skippedCount: number;
}

export default function KpiCards({
  truePassedCount,
  totalChecks,
  criticalCount,
  warningCount,
  skippedCount,
}: KpiCardsProps) {
  const cards: Array<{
    value: number | string;
    label: string;
    bg: string;
  }> = [
    {
      value: `${truePassedCount}/${totalChecks}`,
      label: "Checks Passed",
      bg: truePassedCount >= 8 ? "#f1f8f5" : truePassedCount >= 5 ? "#fff5ea" : "#fff4f4",
    },
    {
      value: criticalCount,
      label: "Critical Threats",
      bg: criticalCount > 0 ? "#fff4f4" : "#f1f8f5",
    },
    {
      value: warningCount,
      label: "Warnings",
      bg: warningCount > 0 ? "#fff5ea" : "#f1f8f5",
    },
    {
      value: skippedCount,
      label: "Skipped",
      bg: skippedCount > 0 ? "#f4f6f8" : "transparent",
    },
  ];

  return (
    <s-section>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "16px",
        }}
      >
        {cards.map((card) => (
          <s-card key={card.label} padding="0">
            <div
              style={{
                padding: "16px",
                margin: "8px",
                borderRadius: "8px",
                textAlign: "center",
                minHeight: "110px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                background: card.bg,
              }}
            >
              <div
                style={{
                  fontSize: "40px",
                  fontWeight: 800,
                  lineHeight: 1.1,
                  color: "var(--p-color-text, #303030)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {card.value}
              </div>
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "11px",
                  color: "var(--p-color-text, #303030)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {card.label}
              </div>
            </div>
          </s-card>
        ))}
      </div>
    </s-section>
  );
}
