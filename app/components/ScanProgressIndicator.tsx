/**
 * app/components/ScanProgressIndicator.tsx
 *
 * Animated shimmer progress bar shown while a compliance scan is running.
 */

export default function ScanProgressIndicator() {
  return (
    <s-section>
      <s-card>
        <div style={{ padding: "24px 0", textAlign: "center" }}>
          <div
            style={{
              fontSize: "16px",
              fontWeight: 600,
              color: "#0f172a",
              marginBottom: "16px",
            }}
          >
            Scanning your store…
          </div>
          <div
            style={{
              height: "6px",
              background: "var(--p-color-bg-surface-secondary, #f1f2f3)",
              borderRadius: "3px",
              overflow: "hidden",
              maxWidth: "400px",
              margin: "0 auto 12px",
            }}
          >
            <div
              style={{
                height: "100%",
                width: "100%",
                background: "linear-gradient(90deg, #0f172a 0%, #2563eb 50%, #0f172a 100%)",
                borderRadius: "3px",
                animation: "shieldkit-shimmer 1.5s ease-in-out infinite",
                backgroundSize: "200% 100%",
              }}
            />
          </div>
          <style>{`
            @keyframes shieldkit-shimmer {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
          `}</style>
          <div
            style={{
              fontSize: "13px",
              color: "var(--p-color-text-subdued, #6d7175)",
            }}
          >
            Running 10 compliance checks against your store. This takes 15–30 seconds.
          </div>
        </div>
      </s-card>
    </s-section>
  );
}
