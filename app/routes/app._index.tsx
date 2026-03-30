/**
 * app/routes/app._index.tsx
 *
 * ShieldKit — GMC Compliance Command Center
 *
 * Free lead-generation model — unlimited scans, full audit results.
 *
 *  ① ONBOARDING (latestScan === null)
 *     Logo + vertical 3-step wizard + full-width "Run Free Scan" CTA.
 *
 *  ② DASHBOARD (latestScan !== null)
 *     Score banner → KPI metric cards (4-up) → 10-point audit checklist
 *     with full fix instructions exposed.
 *
 *  ASIDE (both states)
 *     Security Status card + Expert GMC Support consultation CTA.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import { sendWelcomeEmail } from "../utils/email.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import styles from "../styles.css?url";

// ─── Asset preloading ─────────────────────────────────────────────────────────

export const links: LinksFunction = () => [
  { rel: "preload", href: "/logo-main.png", as: "image" },
  { rel: "stylesheet", href: styles },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info" | "error";

interface Merchant {
  id: string;
  shopify_domain: string;
  scans_remaining: number | null;
  tier: string;
}

interface Scan {
  id: string;
  compliance_score: number | null;
  total_checks: number | null;
  passed_checks: number | null;
  critical_count: number | null;
  warning_count: number | null;
  info_count: number | null;
  created_at: string;
}

interface CheckResult {
  id: string;
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string | null;
  description: string | null;
  fix_instruction: string | null;
}

interface ApiScanResponse {
  success?: boolean;
  error?: string;
  message?: string;
  scanId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreTone(score: number): "success" | "warning" | "critical" {
  if (score >= 80) return "success";
  if (score >= 50) return "warning";
  return "critical";
}

function scoreHeading(score: number, criticalCount: number): string {
  if (score >= 80)
    return `Compliance Score: ${score}% — Your store is in great shape!`;
  if (score >= 50)
    return `Compliance Score: ${score}% — ${criticalCount} critical issue${criticalCount === 1 ? "" : "s"} need attention`;
  return `Compliance Score: ${score}% — Immediate action required`;
}

type ComponentTone =
  | "critical" | "warning" | "info"
  | "success"  | "caution" | "neutral" | "auto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkStatusIcon(check: CheckResult): { type: any; tone: ComponentTone } {
  if (check.passed && check.severity === "info")
    return { type: "info-filled", tone: "info" };
  if (check.passed)
    return { type: "check-circle-filled", tone: "success" };
  switch (check.severity) {
    case "critical": return { type: "x-circle-filled",       tone: "critical" };
    case "warning":  return { type: "alert-triangle-filled", tone: "caution"  };
    case "error":    return { type: "question-circle",       tone: "caution"  };
    default:         return { type: "info-filled",           tone: "info"     };
  }
}

function checkBadgeTone(check: CheckResult): ComponentTone {
  if (check.passed && check.severity === "info") return "info";
  if (check.passed) return "success";
  const map: Record<Severity, ComponentTone> = {
    critical: "critical",
    warning:  "warning",
    info:     "neutral",
    error:    "caution",
  };
  return map[check.severity] ?? "neutral";
}

function checkBadgeText(check: CheckResult): string {
  if (check.passed && check.severity === "info") return "Skipped";
  if (check.passed) return "Passed";
  const map: Record<Severity, string> = {
    critical: "Critical",
    warning:  "Warning",
    info:     "Info",
    error:    "Error",
  };
  return map[check.severity] ?? check.severity;
}

function checkBorderColor(check: CheckResult): string {
  if (check.passed && check.severity === "info")
    return "var(--p-color-border-info, #98c6cd)";
  if (check.passed) return "var(--p-color-border-success, #1a9e5c)";
  switch (check.severity) {
    case "critical": return "var(--p-color-border-critical, #e51c00)";
    case "warning":  return "var(--p-color-border-caution,  #e8820c)";
    case "error":    return "var(--p-color-border-caution,  #e8820c)";
    default:         return "var(--p-color-border-subdued,  #c9cccf)";
  }
}

function checkRowBg(check: CheckResult): string {
  if (check.passed) return "transparent";
  switch (check.severity) {
    case "critical": return "var(--p-color-bg-critical-subdued, #fff4f4)";
    case "warning":  return "var(--p-color-bg-caution-subdued,  #fff5ea)";
    default:         return "transparent";
  }
}

const SEV_RANK: Record<string, number> = {
  critical: 0, error: 1, warning: 2, info: 3,
};

function sortChecks(checks: CheckResult[]): CheckResult[] {
  return [...checks].sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? 1 : -1;
    return (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4);
  });
}

function threatLabel(score: number): string {
  const t = 100 - score;
  if (t < 20) return "Minimal";
  if (t < 40) return "Low";
  if (t < 60) return "Elevated";
  if (t < 80) return "High";
  return "Critical";
}

function threatColor(score: number): string {
  const t = 100 - score;
  if (t < 20) return "#1a9e5c";
  if (t < 40) return "#6aad81";
  if (t < 60) return "#e8820c";
  if (t < 80) return "#d82c0d";
  return "#c00000";
}

function threatBarGradient(score: number): string {
  const t = 100 - score;
  if (t < 20) return "#1a9e5c, #2db57a";
  if (t < 40) return "#6aad81, #a5d6b0";
  if (t < 60) return "#e8820c, #f4a444";
  if (t < 80) return "#d82c0d, #e85a40";
  return "#c00000, #e51c00";
}

function scoreStatus(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 50) return "Fair";
  return "Critical";
}

// ─── Button colour override (Security Blue) ───────────────────────────────────

const BTN_BLUE: React.CSSProperties = {
  "--p-color-bg-fill-brand":          "#0f172a",
  "--p-color-bg-fill-brand-hover":    "#1e293b",
  "--p-color-bg-fill-brand-active":   "#0a1120",
  "--p-color-bg-fill-brand-selected": "#0f172a",
} as React.CSSProperties;

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // Lead capture and welcome email are handled in the action (runScan),
  // which fires only on deliberate user intent and uses the leads table
  // as the deduplication signal so the email is sent exactly once.

  const { data: merchantRow } = await supabase
    .from("merchants")
    .select("id, shopify_domain, scans_remaining, tier")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  const merchant = merchantRow as Merchant | null;

  if (!merchant) {
    return {
      merchant:     null as Merchant | null,
      latestScan:   null as Scan | null,
      checkResults: [] as CheckResult[],
    };
  }

  const { data: scanRow } = await supabase
    .from("scans")
    .select(
      "id, compliance_score, total_checks, passed_checks, " +
      "critical_count, warning_count, info_count, created_at"
    )
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const latestScan = scanRow as Scan | null;

  let checkResults: CheckResult[] = [];
  if (latestScan) {
    const { data: violationRows } = await supabase
      .from("violations")
      .select(
        "id, check_name, passed, severity, title, description, fix_instruction"
      )
      .eq("scan_id", latestScan.id)
      .order("created_at", { ascending: true });
    checkResults = (violationRows ?? []) as CheckResult[];
  }

  return { merchant, latestScan, checkResults };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType !== "runScan") {
    return new Response(
      JSON.stringify({ success: false, message: "Unknown action" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // `admin` is captured in the closure below for the GraphQL email lookup.
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const { data: merchant, error: merchantError } = await supabase
    .from("merchants")
    .select("id, shopify_domain, scans_remaining, tier")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  if (merchantError || !merchant) {
    return new Response(
      JSON.stringify({
        success: false,
        message: merchant
          ? "Database error — please try again."
          : "Merchant not found. Please reinstall the app.",
      }),
      { status: merchantError ? 500 : 404, headers: { "Content-Type": "application/json" } }
    );
  }

  let scanResult: Awaited<ReturnType<typeof runComplianceScan>>;
  try {
    scanResult = await runComplianceScan(merchant.id, shopDomain, "manual");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Fire-and-forget: welcome email on first scan only ─────────────────────
  // Checks the `leads` table for this shop_domain. If no row exists yet this
  // is the merchant's first scan → insert the lead and send the welcome email.
  // All of this is intentionally NOT awaited so it never delays the response.
  // Any failure is caught silently so it can never break the scan flow.
  const sendFirstScanEmail = async () => {
    try {
      const { data: existingLead } = await supabase
        .from("leads")
        .select("shop_domain")
        .eq("shop_domain", shopDomain)
        .maybeSingle();

      if (existingLead) return; // already welcomed — do nothing

      // Fetch the store owner's email and shop name in one GraphQL round-trip
      const emailResp = await admin.graphql(
        `query { shop { email name } }`
      );
      const emailData = await emailResp.json();
      const shopEmail: string | null =
        (emailData?.data?.shop?.email as string | null) ?? null;
      const shopName: string =
        (emailData?.data?.shop?.name as string | null) ?? shopDomain;

      if (!shopEmail) return;

      // Persist the lead first so a retry never double-sends
      await supabase
        .from("leads")
        .upsert(
          { shop_domain: shopDomain, email: shopEmail },
          { onConflict: "shop_domain" }
        );

      await sendWelcomeEmail(shopEmail, shopName);
    } catch (_) {
      // silent — email failure must never surface to the merchant
    }
  };

  sendFirstScanEmail(); // intentionally not awaited

  return new Response(
    JSON.stringify({
      success: true,
      scanId: scanResult.scan.id,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Index() {
  const { merchant, latestScan, checkResults } =
    useLoaderData<typeof loader>();

  const fetcher     = useFetcher<ApiScanResponse>();
  const revalidator = useRevalidator();
  const shopify     = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const [toastId, setToastId]         = useState<string | null>(null);
  const [allExpanded, setAllExpanded] = useState(false);

  // Billing cancellation banner — shown once when redirected from billing flow.
  const [showBillingBanner, setShowBillingBanner] = useState(
    () => searchParams.get("billing") === "cancelled",
  );
  const dismissBillingBanner = useCallback(() => {
    setShowBillingBanner(false);
    setSearchParams((prev) => { prev.delete("billing"); return prev; }, { replace: true });
  }, [setSearchParams]);

  const isScanning =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const scanError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.success
      ? (fetcher.data.message ?? "Scan failed — please try again.")
      : null;

  // Deduplicated toast — only fires once per unique scanId
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.scanId &&
      fetcher.data.scanId !== toastId
    ) {
      shopify.toast.show("Compliance checked");
      setToastId(fetcher.data.scanId);
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, shopify, revalidator, toastId]);

  const runScan = () =>
    fetcher.submit({ action: "runScan" }, { method: "POST" });

  const showOnboarding = latestScan === null;

  const score         = latestScan?.compliance_score ?? null;
  const sortedChecks  = sortChecks(checkResults);
  const criticalCount = latestScan?.critical_count ?? 0;
  const warningCount  = latestScan?.warning_count  ?? 0;
  const totalChecks   = latestScan?.total_checks   ?? 0;

  const truePassedCount = checkResults.filter(
    (c) => c.passed && c.severity !== "info"
  ).length;
  const skippedCount = checkResults.filter(
    (c) => c.passed && c.severity === "info"
  ).length;

  return (
    <s-page heading="ShieldKit — Compliance Command Center">

      {/* ── Primary action (dashboard state only) ────────────────────────── */}
      {!showOnboarding && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={runScan}
          {...(isScanning ? { loading: "" } : {})}
        >
          {isScanning ? "Scanning…" : "Re-run Scan"}
        </s-button>
      )}

      {/* ── Scan error feedback ───────────────────────────────────────────── */}
      {scanError && (
        <s-banner
          heading="Scan failed"
          tone="critical"
          {...{ dismissible: true }}
        >
          {scanError}
        </s-banner>
      )}

      {/* ── Billing cancellation banner ──────────────────────────────────── */}
      {showBillingBanner && (
        <s-banner
          tone="warning"
          onDismiss={dismissBillingBanner}
        >
          You're on the Free plan. Upgrade to Pro to unlock scan history,
          automated monitoring, and one-click fixes.
          {/* @ts-ignore — s-button supports `url` at runtime */}
          <s-button slot="actions" url="/app/upgrade?plan=Pro">
            View upgrade options
          </s-button>
        </s-banner>
      )}

      {/* ════════════════ ONBOARDING WIZARD (first-time users) ════════════ */}
      {showOnboarding && (
        <s-section>

          <div style={{ textAlign: "center", padding: "28px 0 8px" }}>
            <img
              src="/logo-main.png"
              alt="ShieldKit Logo"
              loading="eager"
              fetchpriority="high"
              width={320}
              height={80}
              style={{
                maxWidth: "320px",
                height: "auto",
                display: "block",
                margin: "0 auto",
              }}
            />
          </div>

          <div style={{ textAlign: "center", padding: "12px 0 0" }}>
            <div
              style={{
                fontSize: "22px",
                fontWeight: 800,
                color: "#0f172a",
                letterSpacing: "-0.02em",
              }}
            >
              Your GMC Compliance Dashboard
            </div>
            <div
              style={{
                marginTop: "6px",
                fontSize: "15px",
                color: "var(--p-color-text-subdued, #6d7175)",
                lineHeight: 1.5,
              }}
            >
              Protect your Google Shopping revenue in under 60 seconds.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              margin: "28px 0 24px",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: "24px",
                padding: "24px",
                background: "var(--p-color-bg-surface-info, #e8f6fe)",
                borderRadius: "12px",
                border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "50%",
                  background: "#0f172a",
                  color: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "22px",
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                1
              </div>
              <div>
                <div
                  style={{
                    fontSize: "17px",
                    fontWeight: 700,
                    color: "var(--p-color-text, #303030)",
                    marginBottom: "10px",
                  }}
                >
                  Welcome to ShieldKit
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    color: "var(--p-color-text, #303030)",
                    lineHeight: 1.65,
                  }}
                >
                  ShieldKit runs a full 10-point audit of your Shopify store
                  against every requirement that causes Google Merchant Center
                  account suspensions — and shows you exactly how to fix each one.
                </p>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: "24px",
                padding: "24px",
                background: "var(--p-color-bg-surface-warning, #fff5ea)",
                borderRadius: "12px",
                border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "50%",
                  background: "#0f172a",
                  color: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "22px",
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                2
              </div>
              <div>
                <div
                  style={{
                    fontSize: "17px",
                    fontWeight: 700,
                    color: "var(--p-color-text, #303030)",
                    marginBottom: "10px",
                  }}
                >
                  Why GMC Compliance Matters
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    color: "var(--p-color-text, #303030)",
                    lineHeight: 1.65,
                  }}
                >
                  Google frequently suspends Shopify stores for vague policy
                  violations like "Misrepresentation", instantly cutting off your
                  Google Shopping traffic. Worse, Google only gives you a limited
                  number of appeals before a permanent ban. You must fix all trust
                  signals before requesting a review.
                </p>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: "24px",
                padding: "24px",
                background: "var(--p-color-bg-surface-success, #f1f8f5)",
                borderRadius: "12px",
                border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "50%",
                  background: "#0f172a",
                  color: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "22px",
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                3
              </div>
              <div>
                <div
                  style={{
                    fontSize: "17px",
                    fontWeight: 700,
                    color: "var(--p-color-text, #303030)",
                    marginBottom: "10px",
                  }}
                >
                  Run Your Free Compliance Scan
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    color: "var(--p-color-text, #303030)",
                    lineHeight: 1.65,
                  }}
                >
                  Get a complete compliance audit in under 60 seconds. ShieldKit
                  identifies exactly which issues to fix to protect your Google
                  Shopping revenue before Google flags your store.
                </p>
              </div>
            </div>
          </div>

          {/* ── Big primary CTA ── */}
          <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
            <fetcher.Form method="post">
              <input type="hidden" name="action" value="runScan" />
              {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
              {/* @ts-ignore — s-button supports `submit` at runtime */}
              <s-button
                variant="primary"
                submit=""
                onClick={runScan}
                {...(isScanning ? { loading: "" } : {})}
              >
                {isScanning
                  ? "Scanning your store…"
                  : "Run My Free Compliance Scan →"}
              </s-button>
            </fetcher.Form>
          </div>

        </s-section>
      )}

      {/* ════════════════ DASHBOARD (returning users) ════════════════════ */}
      {!showOnboarding && (
        <div style={{ visibility: "visible", opacity: 1 }}>

          {/* ── Score card ── */}
          <s-section>
            <s-card>
              <div style={{ padding: "4px 0" }}>
                <div style={{ textAlign: "center", marginBottom: "20px" }}>
                  <span
                    style={{
                      background: "#f1f5f9",
                      padding: "8px 20px",
                      borderRadius: "20px",
                      display: "inline-block",
                      fontSize: "16px",
                      fontWeight: 600,
                      color: "#0f172a",
                      wordBreak: "break-all",
                    }}
                  >
                    {merchant?.shopify_domain}
                  </span>
                </div>

                <div style={{ textAlign: "center", marginBottom: "24px" }}>
                  <div
                    style={{
                      fontSize: "64px",
                      fontWeight: 800,
                      lineHeight: 1,
                      fontVariantNumeric: "tabular-nums",
                      color:
                        score === null
                          ? "var(--p-color-text, #303030)"
                          : score >= 80
                          ? "#1a9e5c"
                          : score >= 50
                          ? "#e8820c"
                          : "#e51c00",
                    }}
                  >
                    {score !== null ? `${score}%` : "—"}
                  </div>
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "14px",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "var(--p-color-text-subdued, #6d7175)",
                    }}
                  >
                    Compliance Score
                  </div>
                </div>

                {score !== null && (
                  <div
                    style={{
                      height: "10px",
                      background: "var(--p-color-bg-surface-secondary, #f1f2f3)",
                      borderRadius: "5px",
                      overflow: "hidden",
                      marginBottom: "14px",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${score}%`,
                        background:
                          score >= 80
                            ? "#1a9e5c"
                            : score >= 50
                            ? "#e8820c"
                            : "#e51c00",
                        borderRadius: "5px",
                        transition: "width 0.4s ease",
                      }}
                    />
                  </div>
                )}

                <div>
                  {isScanning ? (
                    <s-badge tone="info">Running all 10 compliance checks…</s-badge>
                  ) : (
                    latestScan && (
                      <s-badge tone="neutral">
                        Last scanned {fmtDate(latestScan.created_at)}
                      </s-badge>
                    )
                  )}
                </div>
              </div>
            </s-card>
          </s-section>

          {/* ── KPI metric cards ── */}
          <s-section>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: "16px",
              }}
            >
              <s-card padding="0">
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
                    background:
                      truePassedCount >= 8
                        ? "#f1f8f5"
                        : truePassedCount >= 5
                        ? "#fff5ea"
                        : "#fff4f4",
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
                    {truePassedCount}
                    <span
                      style={{
                        fontSize: "22px",
                        fontWeight: 700,
                        color: "var(--p-color-text, #303030)",
                      }}
                    >
                      /{totalChecks}
                    </span>
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
                    Checks Passed
                  </div>
                </div>
              </s-card>

              <s-card padding="0">
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
                    background: criticalCount > 0 ? "#fff4f4" : "#f1f8f5",
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
                    {criticalCount}
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
                    Critical Threats
                  </div>
                </div>
              </s-card>

              <s-card padding="0">
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
                    background: warningCount > 0 ? "#fff5ea" : "#f1f8f5",
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
                    {warningCount}
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
                    Warnings
                  </div>
                </div>
              </s-card>

              <s-card padding="0">
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
                    background: skippedCount > 0 ? "#f4f6f8" : "transparent",
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
                    {skippedCount}
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
                    Skipped
                  </div>
                </div>
              </s-card>
            </div>
          </s-section>

          {/* ── 10-point audit checklist ── */}
          {sortedChecks.length > 0 && (
            <s-section>

              {/* Email / PDF guide banner */}
              <s-banner
                heading="Check your email!"
                tone="success"
                {...{ dismissible: true }}
              >
                We have sent the ShieldKit GMC Survival Guide to your store
                email address.
              </s-banner>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: "20px",
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
                  onClick={() => setAllExpanded((v) => !v)}
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

                  return (
                    <details
                      key={`${allExpanded ? "exp" : "col"}-${check.id}`}
                      style={{
                        borderLeft: `4px solid ${checkBorderColor(check)}`,
                        borderBottom:
                          "1px solid var(--p-color-border-subdued, #e1e3e5)",
                        background: checkRowBg(check),
                        padding: "12px 14px",
                        marginBottom: "4px",
                        borderRadius: "0 4px 4px 0",
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
                            fontWeight: check.passed ? 400 : 600,
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
                            </div>
                          )}
                        </div>
                      )}
                    </details>
                  );
                })}
              </div>

            </s-section>
          )}

        </div>
      )}

      {/* ═══════════════════════ ASIDE COLUMN ══════════════════════════════ */}

      {/* Security Status */}
      <s-section slot="aside" heading="Security Status">
        {score !== null ? (
          <div style={{ padding: "4px 0" }}>
            <div style={{ textAlign: "center", marginBottom: "12px" }}>
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--p-color-text-subdued, #6d7175)",
                  marginBottom: "6px",
                }}
              >
                Threat Level
              </div>
              <div
                style={{
                  fontSize: "26px",
                  fontWeight: 800,
                  color: threatColor(score),
                  lineHeight: 1.1,
                }}
              >
                {threatLabel(score)}
              </div>
            </div>

            <div
              style={{
                height: "8px",
                background: "var(--p-color-bg-surface-secondary, #f1f2f3)",
                borderRadius: "4px",
                overflow: "hidden",
                marginBottom: "16px",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(4, 100 - score)}%`,
                  background: `linear-gradient(to right, ${threatBarGradient(score)})`,
                  borderRadius: "4px",
                  transition: "width 0.4s ease",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                fontSize: "13px",
              }}
            >
              {criticalCount > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 10px",
                    background: "var(--p-color-bg-critical-subdued, #fff4f4)",
                    borderRadius: "6px",
                    border: "1px solid var(--p-color-border-critical-subdued, #ffd2cc)",
                  }}
                >
                  <s-icon type="x-circle-filled" tone="critical" size="base" />
                  <span>
                    <strong>{criticalCount}</strong> critical issue
                    {criticalCount > 1 ? "s" : ""}
                  </span>
                </div>
              )}
              {warningCount > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 10px",
                    background: "var(--p-color-bg-caution-subdued, #fff5ea)",
                    borderRadius: "6px",
                    border: "1px solid var(--p-color-border-caution-subdued, #ffd79d)",
                  }}
                >
                  <s-icon
                    type="alert-triangle-filled"
                    tone="caution"
                    size="base"
                  />
                  <span>
                    <strong>{warningCount}</strong> warning
                    {warningCount > 1 ? "s" : ""}
                  </span>
                </div>
              )}
              {criticalCount === 0 && warningCount === 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 10px",
                    background: "var(--p-color-bg-success-subdued, #f1f8f5)",
                    borderRadius: "6px",
                    border: "1px solid var(--p-color-border-success-subdued, #95c9a8)",
                  }}
                >
                  <s-icon
                    type="check-circle-filled"
                    tone="success"
                    size="base"
                  />
                  <span>No critical threats detected</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <s-paragraph>
            Run your first scan to see your store's threat level and
            security status.
          </s-paragraph>
        )}
      </s-section>

      {/* About ShieldKit */}
      <s-section slot="aside" heading="About ShieldKit">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <s-paragraph>
            ShieldKit helps Shopify merchants stay compliant with Google
            Merchant Center policies so their stores are never unexpectedly
            suspended from Google Shopping.
          </s-paragraph>
          <s-paragraph>
            Run a scan at any time to get an up-to-date picture of your
            store's compliance health. Each check maps directly to a GMC
            policy requirement, and every failed check includes a plain-English
            resolution guide so you always know exactly what to fix.
          </s-paragraph>
        </div>
      </s-section>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
