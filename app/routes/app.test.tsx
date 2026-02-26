/**
 * TEMPORARY — Day 3 scanner engine verification route.
 * Navigate to /app/test in the embedded app to run a live compliance scan.
 * Delete this file once the engine is confirmed working end-to-end.
 */

import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. Authenticate and get the current shop domain from the session token.
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // 2. Look up the merchant UUID from Supabase using the shop domain.
  const { data: merchant, error: merchantError } = await supabase
    .from("merchants")
    .select("id")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  if (merchantError) {
    throw new Response(
      `Supabase lookup failed: ${merchantError.message}`,
      { status: 500 }
    );
  }

  if (!merchant) {
    throw new Response(
      `No merchant record found for ${shopDomain}. ` +
        `Ensure the app is installed and the afterAuth hook has run.`,
      { status: 404 }
    );
  }

  // 3. Run the full compliance scan.
  const { scan, violations } = await runComplianceScan(
    merchant.id,
    shopDomain,
    "manual"
  );

  // Suppress the unused variable warning — admin is required for authenticate.admin
  // to validate the session token, but the executor is provided by the scanner itself.
  void admin;

  return Response.json({ shopDomain, scan, violations });
};

export default function TestPage() {
  type LoadedData = {
    shopDomain: string;
    scan: {
      id: string;
      compliance_score: number;
      total_checks: number;
      passed_checks: number;
      critical_count: number;
      warning_count: number;
      info_count: number;
      created_at: string;
    };
    violations: Array<{
      check_name: string;
      passed: boolean;
      severity: string;
      title: string;
      description: string;
    }>;
  };

  // useLoaderData infers `never` when the loader has throw branches;
  // cast explicitly to the known shape instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = useLoaderData() as LoadedData;
  const { scan, violations } = data;

  const scoreColor =
    scan.compliance_score >= 80
      ? "#4ade80"
      : scan.compliance_score >= 60
        ? "#facc15"
        : "#f87171";

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace", maxWidth: "900px" }}>
      <h2 style={{ marginBottom: "0.5rem" }}>ShieldKit — Compliance Scan Report</h2>
      <p style={{ color: "#888", marginBottom: "1.5rem", fontSize: "13px" }}>
        Store: <strong>{data.shopDomain}</strong> &nbsp;|&nbsp; Scan ID:{" "}
        <strong>{scan.id}</strong> &nbsp;|&nbsp; Run at:{" "}
        <strong>{new Date(scan.created_at).toLocaleString()}</strong>
      </p>

      {/* Score summary */}
      <div
        style={{
          display: "flex",
          gap: "1rem",
          marginBottom: "1.5rem",
          flexWrap: "wrap",
        }}
      >
        {[
          {
            label: "Compliance Score",
            value: `${scan.compliance_score}%`,
            color: scoreColor,
          },
          {
            label: "Checks Passed",
            value: `${scan.passed_checks} / ${scan.total_checks}`,
            color: "#d4f5d4",
          },
          { label: "Critical", value: scan.critical_count, color: "#f87171" },
          { label: "Warning", value: scan.warning_count, color: "#facc15" },
          { label: "Info", value: scan.info_count, color: "#93c5fd" },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            style={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "8px",
              padding: "0.75rem 1.25rem",
              minWidth: "110px",
            }}
          >
            <div style={{ fontSize: "11px", color: "#888", marginBottom: "4px" }}>
              {label}
            </div>
            <div style={{ fontSize: "22px", fontWeight: "bold", color: String(color) }}>
              {String(value)}
            </div>
          </div>
        ))}
      </div>

      {/* Per-check results */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "2rem" }}>
        {violations.map((v) => {
          const bg = v.passed
            ? "#0f2d1a"
            : v.severity === "critical"
              ? "#2d0f0f"
              : v.severity === "warning"
                ? "#2d270f"
                : "#0f1a2d";
          const badge = v.passed
            ? { label: "PASS", color: "#4ade80" }
            : v.severity === "critical"
              ? { label: "CRITICAL", color: "#f87171" }
              : v.severity === "warning"
                ? { label: "WARNING", color: "#facc15" }
                : { label: "INFO", color: "#93c5fd" };

          return (
            <div
              key={v.check_name}
              style={{
                background: bg,
                border: `1px solid ${badge.color}44`,
                borderRadius: "8px",
                padding: "1rem 1.25rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "4px" }}>
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: "bold",
                    color: badge.color,
                    border: `1px solid ${badge.color}`,
                    borderRadius: "4px",
                    padding: "2px 6px",
                    letterSpacing: "0.05em",
                  }}
                >
                  {badge.label}
                </span>
                <span style={{ fontWeight: "bold", color: "#e5e5e5" }}>
                  {v.title}
                </span>
                <span style={{ color: "#666", fontSize: "11px", marginLeft: "auto" }}>
                  {v.check_name}
                </span>
              </div>
              {!v.passed && (
                <div style={{ color: "#ccc", fontSize: "13px", marginTop: "4px" }}>
                  {v.description}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Full raw JSON for inspection */}
      <details>
        <summary
          style={{ cursor: "pointer", color: "#888", fontSize: "13px", marginBottom: "0.5rem" }}
        >
          Raw JSON output
        </summary>
        <pre
          style={{
            background: "#1a1a1a",
            color: "#d4f5d4",
            padding: "1.5rem",
            borderRadius: "8px",
            overflowX: "auto",
            fontSize: "12px",
            lineHeight: "1.5",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </div>
  );
}
