/**
 * app/components/AuditChecklist.tsx
 *
 * 10-point GMC compliance audit checklist with expandable details,
 * resolution guides, and AI policy generation for Pro users.
 */

import type { Merchant, CheckResult } from "../lib/types";
import {
  checkStatusIcon,
  checkBadgeTone,
  checkBadgeText,
  checkBorderColor,
  checkRowBg,
} from "../lib/scan-helpers";

interface AuditChecklistProps {
  sortedChecks: CheckResult[];
  totalChecks: number;
  truePassedCount: number;
  allExpanded: boolean;
  onToggleExpand: () => void;
  merchant: Merchant | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyFetcher: any;
  isGeneratingPolicy: boolean;
}

export default function AuditChecklist({
  sortedChecks,
  totalChecks,
  truePassedCount,
  allExpanded,
  onToggleExpand,
  merchant,
  policyFetcher,
  isGeneratingPolicy,
}: AuditChecklistProps) {
  if (sortedChecks.length === 0) return null;

  return (
    <s-section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
        }}
      >
        <div
          style={{
            fontSize: "20px",
            fontWeight: 800,
            color: "#0f172a",
          }}
        >
          10-Point GMC Compliance Audit — {truePassedCount} / {totalChecks} passed
        </div>
        <button
          onClick={onToggleExpand}
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#0f172a",
            background: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            padding: "5px 12px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {allExpanded ? "Collapse All" : "Expand All"}
        </button>
      </div>

      <div>
        {sortedChecks.map((check) => {
          const icon = checkStatusIcon(check);
          const displayTitle =
            check.title ??
            check.check_name
              .replace(/_/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
          const hasDetail = !!check.description || !check.passed;
          const isFailed = !check.passed;
          const isCritical = isFailed && check.severity === "critical";

          return (
            <details
              key={`${allExpanded ? "exp" : "col"}-${check.id}`}
              style={{
                borderLeft: `4px solid ${checkBorderColor(check)}`,
                borderBottom:
                  "1px solid var(--p-color-border-subdued, #e1e3e5)",
                background: checkRowBg(check),
                padding: isCritical ? "14px 14px" : "12px 14px",
                marginBottom: "4px",
                borderRadius: "0 4px 4px 0",
                ...(isCritical
                  ? { boxShadow: "inset 0 0 0 1px rgba(229, 28, 0, 0.15)" }
                  : {}),
              }}
              open={allExpanded}
            >
              <summary
                style={{
                  listStyle: "none",
                  WebkitAppearance: "none",
                  cursor: hasDetail ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <s-icon type={icon.type} tone={icon.tone} size="base" />

                <span
                  style={{
                    flex: 1,
                    fontWeight: isFailed ? 600 : 400,
                    fontSize: "14px",
                    color: "var(--p-color-text, #303030)",
                  }}
                >
                  {displayTitle}
                </span>

                <s-badge tone={checkBadgeTone(check)}>
                  {checkBadgeText(check)}
                </s-badge>

                {hasDetail && (
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--p-color-text-subdued, #6d7175)",
                      userSelect: "none",
                    }}
                  >
                    ▾
                  </span>
                )}
              </summary>

              {hasDetail && (
                <div
                  style={{
                    marginTop: "10px",
                    paddingLeft: "30px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  {check.description && (
                    <s-paragraph>{check.description}</s-paragraph>
                  )}

                  {!check.passed && (
                    <div
                      style={{
                        background: "#f6f6f7",
                        border: "1px solid #e1e3e5",
                        borderRadius: "6px",
                        padding: "10px 14px",
                        fontSize: "13px",
                        lineHeight: 1.6,
                      }}
                    >
                      <strong
                        style={{
                          display: "block",
                          marginBottom: "4px",
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          color: "#6d7175",
                        }}
                      >
                        Resolution Guide
                      </strong>
                      {check.fix_instruction
                        ? check.fix_instruction
                        : "Detailed remediation copy coming soon — check back after your next scan."}

                      {/* AI Policy Generation — Pro only, for policy-related checks */}
                      {merchant?.tier === "pro" &&
                        ["refund_return_policy", "shipping_policy", "privacy_and_terms"].includes(check.check_name) && (
                        <div style={{ marginTop: "10px" }}>
                          <button
                            type="button"
                            disabled={isGeneratingPolicy}
                            onClick={() => {
                              const policyType =
                                check.check_name === "refund_return_policy" ? "refund"
                                : check.check_name === "shipping_policy" ? "shipping"
                                : check.check_name === "privacy_and_terms" ? "privacy"
                                : "terms";
                              policyFetcher.submit(
                                { action: "generatePolicy", policyType },
                                { method: "POST" },
                              );
                            }}
                            style={{
                              fontSize: "13px",
                              fontWeight: 600,
                              color: "#0f172a",
                              background: "#f1f5f9",
                              border: "1px solid #cbd5e1",
                              borderRadius: "8px",
                              padding: "8px 16px",
                              cursor: isGeneratingPolicy ? "wait" : "pointer",
                              opacity: isGeneratingPolicy ? 0.7 : 1,
                            }}
                          >
                            {isGeneratingPolicy ? "Generating…" : "Generate Policy with AI"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </details>
          );
        })}
      </div>
    </s-section>
  );
}
