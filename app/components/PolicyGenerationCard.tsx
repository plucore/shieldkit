/**
 * app/components/PolicyGenerationCard.tsx
 *
 * Sidebar card for AI policy generation. Shows one row per failed or
 * previously generated policy type. Pro-only feature.
 */

import { useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import type { PolicyType } from "../lib/policy-generator.server";
import type { GeneratedPolicies, PolicyRegenUsed, CheckResult } from "../lib/types";

const POLICY_CHECK_MAP: Record<string, PolicyType> = {
  refund_return_policy: "refund",
  shipping_policy: "shipping",
  privacy_and_terms: "privacy",
};

const POLICY_LABELS: Record<PolicyType, string> = {
  refund: "Refund Policy",
  shipping: "Shipping Policy",
  privacy: "Privacy Policy",
  terms: "Terms of Service",
};

interface PolicyGenerationCardProps {
  generatedPolicies: GeneratedPolicies;
  policyRegenUsed: PolicyRegenUsed;
  checkResults: CheckResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyFetcher: any;
  generatingPolicyType: string | null;
  onCopy: (text: string) => void;
}

export default function PolicyGenerationCard({
  generatedPolicies,
  policyRegenUsed,
  checkResults,
  policyFetcher,
  generatingPolicyType,
  onCopy,
}: PolicyGenerationCardProps) {
  const [expandedType, setExpandedType] = useState<PolicyType | null>(null);

  // Determine which policy types to show: only failed checks
  const failedPolicyTypes = new Set<PolicyType>();
  for (const check of checkResults) {
    if (!check.passed) {
      if (check.check_name === "privacy_and_terms") {
        // privacy_and_terms can fail for privacy, terms, or both.
        // Parse the title to determine which specific policies are missing.
        const title = check.title ?? "";
        const privacyMissing = /Missing Privacy Policy/i.test(title);
        const termsMissing = /Missing Terms of Service/i.test(title) ||
          /Terms of Service was found/i.test(check.description ?? "");
        if (privacyMissing) failedPolicyTypes.add("privacy");
        if (termsMissing) failedPolicyTypes.add("terms");
        // Fallback: if we can't determine specifics, add both
        if (!privacyMissing && !termsMissing) {
          failedPolicyTypes.add("privacy");
          failedPolicyTypes.add("terms");
        }
      } else if (POLICY_CHECK_MAP[check.check_name]) {
        failedPolicyTypes.add(POLICY_CHECK_MAP[check.check_name]);
      }
    }
  }

  const allTypes: PolicyType[] = ["refund", "shipping", "privacy", "terms"];
  const visibleTypes = allTypes.filter(
    (t) => failedPolicyTypes.has(t)
  );

  if (visibleTypes.length === 0) return null;

  return (
    <s-section slot="aside">
      <div style={{ marginBottom: "12px" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
          Policy Generation
        </div>
      </div>
      <s-card>
        <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
          {visibleTypes.map((type) => {
            const generated = generatedPolicies[type];
            const regenUsed = policyRegenUsed[type];
            const isFailed = failedPolicyTypes.has(type);
            const isExpanded = expandedType === type;

            const remaining = !generated ? 2 : !regenUsed ? 1 : 0;
            const isLoadingThis = generatingPolicyType === type;
            const isAnyLoading = generatingPolicyType !== null;

            return (
              <div key={type}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 0",
                    borderBottom: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    {generated ? (
                      <s-icon type="check-circle-filled" tone="success" size="small" />
                    ) : (
                      <s-icon type="x-circle-filled" tone="critical" size="small" />
                    )}
                    <span
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        color: generated ? "#1a9e5c" : isFailed ? "#e51c00" : "#303030",
                      }}
                    >
                      {POLICY_LABELS[type]}
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    {generated && (
                      <>
                        <button
                          type="button"
                          onClick={() => setExpandedType(isExpanded ? null : type)}
                          style={{
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#0f172a",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}
                        >
                          {isExpanded ? "Hide" : "View"}
                        </button>
                        <button
                          type="button"
                          onClick={() => onCopy(generated)}
                          style={{
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#0f172a",
                            background: "#f1f5f9",
                            border: "1px solid #cbd5e1",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            cursor: "pointer",
                          }}
                        >
                          Copy
                        </button>
                      </>
                    )}

                    {!generated ? (
                      <button
                        type="button"
                        disabled={isAnyLoading}
                        onClick={() => {
                          policyFetcher.submit(
                            { action: "generatePolicy", policyType: type },
                            { method: "POST" },
                          );
                        }}
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#fff",
                          background: "#0f172a",
                          border: "none",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          cursor: isAnyLoading ? "wait" : "pointer",
                          opacity: isLoadingThis ? 0.7 : 1,
                        }}
                      >
                        {isLoadingThis ? "…" : "Generate"}
                      </button>
                    ) : !regenUsed ? (
                      <button
                        type="button"
                        disabled={isAnyLoading}
                        onClick={() => {
                          policyFetcher.submit(
                            { action: "generatePolicy", policyType: type },
                            { method: "POST" },
                          );
                        }}
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#0f172a",
                          background: "#f1f5f9",
                          border: "1px solid #cbd5e1",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          cursor: isAnyLoading ? "wait" : "pointer",
                          opacity: isLoadingThis ? 0.7 : 1,
                        }}
                      >
                        {isLoadingThis ? "…" : "Regenerate"}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div
                  style={{
                    textAlign: "right",
                    fontSize: "11px",
                    color: remaining > 0 ? "#6d7175" : "#e51c00",
                    paddingBottom: "4px",
                  }}
                >
                  {remaining}/2 generations remaining
                </div>

                {/* Expanded policy view — content is generated by our own Anthropic API call (trusted source) */}
                {isExpanded && generated && (
                  <div style={{ padding: "10px 0" }}>
                    <div
                      style={{
                        background: "#f8fafc",
                        border: "1px solid #e2e8f0",
                        borderRadius: "8px",
                        padding: "12px",
                        fontSize: "13px",
                        lineHeight: 1.6,
                        maxHeight: "300px",
                        overflowY: "auto",
                      }}
                      // Sanitized with DOMPurify for defense-in-depth
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(generated) }}
                    />
                    <div style={{ marginTop: "8px", display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => onCopy(generated)}
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#0f172a",
                          background: "#f1f5f9",
                          border: "1px solid #cbd5e1",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          cursor: "pointer",
                        }}
                      >
                        Copy to Clipboard
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div
          style={{
            marginTop: "8px",
            fontSize: "11px",
            color: "var(--p-color-text-subdued, #6d7175)",
            fontStyle: "italic",
          }}
        >
          Review policies before publishing. Not legal advice.
        </div>
      </s-card>
    </s-section>
  );
}
