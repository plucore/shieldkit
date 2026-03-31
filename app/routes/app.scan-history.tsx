/**
 * app/routes/app.scan-history.tsx
 * Route: /app/scan-history
 *
 * Pro-gated scan history page. Shows a table of past compliance scans
 * with score, critical/warning/info counts, and date.
 *
 * Free-tier merchants are redirected to the dashboard with an upgrade prompt.
 */

import { redirect } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScanRow {
  id: string;
  compliance_score: number | null;
  critical_count: number | null;
  warning_count: number | null;
  info_count: number | null;
  created_at: string;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Look up merchant tier
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  if (!merchant || merchant.tier !== "pro") {
    return redirect("/app?upgrade=scan-history");
  }

  // Fetch scan history
  const { data: scans, error } = await supabase
    .from("scans")
    .select(
      "id, compliance_score, critical_count, warning_count, info_count, created_at"
    )
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[scan-history] Failed to fetch scans:", error.message);
  }

  return { scans: (scans ?? []) as ScanRow[] };
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScanHistoryPage() {
  const { scans } = useLoaderData<typeof loader>() as { scans: ScanRow[] };

  return (
    // @ts-ignore — s-page heading prop works at runtime
    <s-page heading="Scan History">
      <s-section>
        {scans.length === 0 ? (
          <s-card>
            <s-paragraph>
              No scans yet. Run your first scan from the dashboard.
            </s-paragraph>
          </s-card>
        ) : (
          <s-card>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "14px",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "2px solid #e2e8f0",
                    textAlign: "left",
                  }}
                >
                  <th style={{ padding: "12px 16px" }}>Date</th>
                  <th style={{ padding: "12px 16px" }}>Score</th>
                  <th style={{ padding: "12px 16px" }}>Critical</th>
                  <th style={{ padding: "12px 16px" }}>Warnings</th>
                  <th style={{ padding: "12px 16px" }}>Info</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((scan) => {
                  const score = scan.compliance_score ?? 0;
                  const scoreColor =
                    score >= 80
                      ? "#1a9e5c"
                      : score >= 50
                        ? "#e8820c"
                        : "#e51c00";
                  const date = new Date(scan.created_at);
                  const formatted = date.toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });

                  return (
                    <tr
                      key={scan.id}
                      style={{ borderBottom: "1px solid #e2e8f0" }}
                    >
                      <td style={{ padding: "12px 16px", color: "#334155" }}>
                        {formatted}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          fontWeight: 700,
                          color: scoreColor,
                        }}
                      >
                        {score.toFixed(0)}%
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          color:
                            (scan.critical_count ?? 0) > 0
                              ? "#e51c00"
                              : "#334155",
                        }}
                      >
                        {scan.critical_count ?? 0}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          color:
                            (scan.warning_count ?? 0) > 0
                              ? "#e8820c"
                              : "#334155",
                        }}
                      >
                        {scan.warning_count ?? 0}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#334155" }}>
                        {scan.info_count ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </s-card>
        )}
      </s-section>
    </s-page>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return <div>Something went wrong loading scan history.</div>;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
