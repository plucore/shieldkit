/**
 * app/routes/app._index.tsx
 *
 * ShieldKit — GMC Compliance Command Center
 *
 *  ① ONBOARDING (latestScan === null)
 *     Logo + vertical 3-step wizard + full-width "Run Free Scan" CTA.
 *
 *  ② DASHBOARD (latestScan !== null)
 *     Score banner → KPI metric cards (4-up) → 10-point audit checklist
 *     with full fix instructions exposed.
 *
 *  ASIDE (both states)
 *     Security Status card + About ShieldKit card.
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
  useNavigate,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import { sendWelcomeEmail } from "../utils/email.server";
import {
  generatePolicy,
  type PolicyType,
} from "../lib/policy-generator.server";
import { wrapAdminClient, getShopInfo } from "../lib/shopify-api.server";
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
  scan_type: string;
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
  error_code?: string;
  message?: string;
  scanId?: string;
  policy?: {
    type: string;
    title: string;
    body: string;
    disclaimer: string;
  };
  policy_remaining?: number;
  policy_reset_date?: string | null;
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

function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
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

function scoreColor(score: number): string {
  if (score >= 80) return "#1a9e5c";
  if (score >= 50) return "#e8820c";
  return "#e51c00";
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const { data: merchantRow } = await supabase
    .from("merchants")
    .select("id, shopify_domain, scans_remaining, tier")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  const merchant = merchantRow as Merchant | null;

  if (!merchant) {
    return {
      merchant:          null as Merchant | null,
      latestScan:        null as Scan | null,
      previousScan:      null as Scan | null,
      lastAutomatedScan: null as Scan | null,
      checkResults:      [] as CheckResult[],
      newAutoIssueCount: 0,
    };
  }

  // Fetch latest scan (any type)
  const { data: scanRow } = await supabase
    .from("scans")
    .select(
      "id, scan_type, compliance_score, total_checks, passed_checks, " +
      "critical_count, warning_count, info_count, created_at"
    )
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const latestScan = scanRow as Scan | null;

  // Fetch previous scan for trend comparison
  let previousScan: Scan | null = null;
  if (latestScan) {
    const { data: prevRow } = await supabase
      .from("scans")
      .select(
        "id, scan_type, compliance_score, total_checks, passed_checks, " +
        "critical_count, warning_count, info_count, created_at"
      )
      .eq("merchant_id", merchant.id)
      .neq("id", latestScan.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    previousScan = prevRow as Scan | null;
  }

  // Fetch last automated scan (for Pro weekly monitoring display)
  let lastAutomatedScan: Scan | null = null;
  if (merchant.tier === "pro") {
    const { data: autoRow } = await supabase
      .from("scans")
      .select(
        "id, scan_type, compliance_score, total_checks, passed_checks, " +
        "critical_count, warning_count, info_count, created_at"
      )
      .eq("merchant_id", merchant.id)
      .eq("scan_type", "automated")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastAutomatedScan = autoRow as Scan | null;
  }

  // Count new issues from automated scan vs last manual scan
  let newAutoIssueCount = 0;
  if (lastAutomatedScan && merchant.tier === "pro") {
    const { data: lastManualRow } = await supabase
      .from("scans")
      .select("id")
      .eq("merchant_id", merchant.id)
      .eq("scan_type", "manual")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastManualRow && lastAutomatedScan.created_at > (latestScan?.created_at ?? "")) {
      const [{ data: autoViolations }, { data: manualViolations }] = await Promise.all([
        supabase
          .from("violations")
          .select("check_name, passed")
          .eq("scan_id", lastAutomatedScan.id),
        supabase
          .from("violations")
          .select("check_name, passed")
          .eq("scan_id", lastManualRow.id),
      ]);

      const manualFailedSet = new Set(
        (manualViolations ?? [])
          .filter((v: { passed: boolean }) => !v.passed)
          .map((v: { check_name: string }) => v.check_name),
      );

      newAutoIssueCount = (autoViolations ?? [])
        .filter(
          (v: { check_name: string; passed: boolean }) =>
            !v.passed && !manualFailedSet.has(v.check_name),
        ).length;
    }
  }

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

  return {
    merchant,
    latestScan,
    previousScan,
    lastAutomatedScan,
    checkResults,
    newAutoIssueCount,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const actionType = formData.get("action");

  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // ── Generate Policy action (Pro only) ─────────────────────────────────────
  if (actionType === "generatePolicy") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id, tier, policy_gen_count, policy_gen_reset_at")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (!merchant || merchant.tier !== "pro") {
      return new Response(
        JSON.stringify({ success: false, message: "Pro plan required for AI policy generation." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Policy generation rate limiting (20 per 30-day window) ──
    let genCount: number = merchant.policy_gen_count ?? 0;
    const resetAt = merchant.policy_gen_reset_at ? new Date(merchant.policy_gen_reset_at) : null;

    if (!resetAt || new Date() > resetAt) {
      genCount = 0;
      const newResetAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("merchants")
        .update({ policy_gen_count: 0, policy_gen_reset_at: newResetAt })
        .eq("id", merchant.id);
    }

    if (genCount >= 20) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "policy_limit_reached",
          message: `You've used all 20 policy generations this month. Your limit resets on ${resetAt ? resetAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "next month"}.`,
          policy_remaining: 0,
          policy_reset_date: resetAt?.toISOString() ?? null,
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    const policyType = formData.get("policyType") as PolicyType | null;
    if (!policyType || !["refund", "shipping", "privacy", "terms"].includes(policyType)) {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid policy type." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const executor = wrapAdminClient(admin.graphql);
      const shopInfo = await getShopInfo(executor);
      if (!shopInfo) {
        return new Response(
          JSON.stringify({ success: false, message: "Could not fetch shop info." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      const policy = await generatePolicy(policyType, shopInfo);

      const newCount = genCount + 1;
      await supabase
        .from("merchants")
        .update({ policy_gen_count: newCount })
        .eq("id", merchant.id);

      return new Response(
        JSON.stringify({
          success: true,
          policy,
          policy_remaining: 20 - newCount,
          policy_reset_date: resetAt?.toISOString() ?? null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ success: false, message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // ── Run Scan action ───────────────────────────────────────────────────────
  if (actionType !== "runScan") {
    return new Response(
      JSON.stringify({ success: false, message: "Unknown action" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

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

  // ── Quota enforcement ─────────────────────────────────────────────────────
  const scansRemaining: number | null = merchant.scans_remaining;
  if (scansRemaining !== null && scansRemaining <= 0) {
    return new Response(
      JSON.stringify({
        success: false,
        error_code: "scan_limit_reached",
        message: "You've used your free scan. Upgrade to Pro ($39/mo) for unlimited re-scans.",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } }
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

  // ── Decrement quota after successful scan ─────────────────────────────────
  // null = unlimited (Pro tier) — skip decrement entirely
  if (typeof scansRemaining === "number" && scansRemaining > 0) {
    await supabase
      .from("merchants")
      .update({ scans_remaining: Math.max(0, scansRemaining - 1) })
      .eq("id", merchant.id);
  }

  // ── Fire-and-forget: welcome email on first scan only ─────────────────────
  const sendFirstScanEmail = async () => {
    try {
      const { data: existingLead } = await supabase
        .from("leads")
        .select("shop_domain")
        .eq("shop_domain", shopDomain)
        .maybeSingle();

      if (existingLead) return;

      const emailResp = await admin.graphql(
        `query { shop { email name } }`
      );
      const emailData = await emailResp.json();
      const shopEmail: string | null =
        (emailData?.data?.shop?.email as string | null) ?? null;
      const shopName: string =
        (emailData?.data?.shop?.name as string | null) ?? shopDomain;

      if (!shopEmail) return;

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

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Score Banner ─────────────────────────────────────────────────────────────

function ScoreBanner({
  merchant,
  score,
  latestScan,
  lastAutomatedScan,
  newAutoIssueCount,
  isScanning,
}: {
  merchant: Merchant;
  score: number | null;
  latestScan: Scan;
  lastAutomatedScan: Scan | null;
  newAutoIssueCount: number;
  isScanning: boolean;
}) {
  return (
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
              {merchant.shopify_domain}
            </span>
          </div>

          <div style={{ textAlign: "center", marginBottom: "24px" }}>
            <div
              style={{
                fontSize: "64px",
                fontWeight: 800,
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                color: score === null ? "var(--p-color-text, #303030)" : scoreColor(score),
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
                  background: scoreColor(score),
                  borderRadius: "5px",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
            {isScanning ? (
              <s-badge tone="info">Running all 10 compliance checks…</s-badge>
            ) : (
              <s-badge tone="neutral">
                Last scanned {fmtDate(latestScan.created_at)}
              </s-badge>
            )}
          </div>

          {/* Automated scan info for Pro merchants */}
          {merchant.tier === "pro" && lastAutomatedScan && !isScanning && (
            <div
              style={{
                marginTop: "12px",
                textAlign: "center",
                fontSize: "13px",
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              Last automated scan: {fmtDateShort(lastAutomatedScan.created_at)}
            </div>
          )}
        </div>
      </s-card>

      {/* Weekly monitoring detected new issues banner */}
      {merchant.tier === "pro" && newAutoIssueCount > 0 && (
        <div style={{ marginTop: "12px" }}>
          <s-banner tone="warning">
            Your weekly monitoring detected {newAutoIssueCount} new issue
            {newAutoIssueCount > 1 ? "s" : ""} since your last scan.
          </s-banner>
        </div>
      )}
    </s-section>
  );
}

// ─── KPI Cards ────────────────────────────────────────────────────────────────

function KpiCards({
  truePassedCount,
  totalChecks,
  criticalCount,
  warningCount,
  skippedCount,
}: {
  truePassedCount: number;
  totalChecks: number;
  criticalCount: number;
  warningCount: number;
  skippedCount: number;
}) {
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

// ─── Scanning Progress Indicator ──────────────────────────────────────────────

function ScanProgressIndicator() {
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

// ─── Upgrade CTA Card (for free users who've used their scan) ─────────────────

function UpgradeCard({ onUpgrade }: { onUpgrade: () => void }) {
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
          <s-button variant="primary" onClick={onUpgrade}>
            Upgrade to Pro
          </s-button>
        </div>
      </s-card>
    </s-section>
  );
}

// ─── Policy Generator UI ──────────────────────────────────────────────────────

function PolicyGeneratorDisplay({
  generatedPolicy,
  policyRemaining,
  policyLimitMessage,
  onDismiss,
  onDismissLimit,
  onCopy,
}: {
  generatedPolicy: ApiScanResponse["policy"] | null;
  policyRemaining: number | null;
  policyLimitMessage: string | null;
  onDismiss: () => void;
  onDismissLimit: () => void;
  onCopy: (text: string) => void;
}) {
  return (
    <>
      {policyLimitMessage && (
        <s-section>
          <s-banner tone="warning" onDismiss={onDismissLimit}>
            {policyLimitMessage}
          </s-banner>
        </s-section>
      )}

      {generatedPolicy && (
        <s-section>
          <s-card>
            <div style={{ padding: "4px 0" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "12px",
                }}
              >
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 700,
                    color: "#0f172a",
                  }}
                >
                  Generated: {generatedPolicy.title}
                </div>
                <button
                  onClick={() => onCopy(generatedPolicy.body)}
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#0f172a",
                    background: "#f1f5f9",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    padding: "5px 12px",
                    cursor: "pointer",
                  }}
                >
                  Copy to Clipboard
                </button>
              </div>
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "16px",
                  fontSize: "14px",
                  lineHeight: 1.6,
                  maxHeight: "400px",
                  overflowY: "auto",
                }}
                // Policy HTML is generated by our own Anthropic API call — trusted source
                dangerouslySetInnerHTML={{ __html: generatedPolicy.body }}
              />
              <div
                style={{
                  marginTop: "12px",
                  padding: "8px 12px",
                  background: "#fff5ea",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "#92400e",
                  fontWeight: 600,
                }}
              >
                {generatedPolicy.disclaimer}
              </div>
              {policyRemaining != null && (
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "12px",
                    color: "#6d7175",
                  }}
                >
                  {policyRemaining} of 20 generations remaining this month
                </div>
              )}
              <div style={{ marginTop: "8px" }}>
                <button
                  onClick={onDismiss}
                  style={{
                    fontSize: "12px",
                    color: "#6d7175",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </s-card>
        </s-section>
      )}
    </>
  );
}

// ─── Audit Checklist ──────────────────────────────────────────────────────────

function AuditChecklist({
  sortedChecks,
  totalChecks,
  truePassedCount,
  allExpanded,
  onToggleExpand,
  merchant,
  policyFetcher,
  isGeneratingPolicy,
}: {
  sortedChecks: CheckResult[];
  totalChecks: number;
  truePassedCount: number;
  allExpanded: boolean;
  onToggleExpand: () => void;
  merchant: Merchant | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyFetcher: any;
  isGeneratingPolicy: boolean;
}) {
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
                          <policyFetcher.Form method="post">
                            <input type="hidden" name="action" value="generatePolicy" />
                            <input
                              type="hidden"
                              name="policyType"
                              value={
                                check.check_name === "refund_return_policy" ? "refund"
                                : check.check_name === "shipping_policy" ? "shipping"
                                : check.check_name === "privacy_and_terms" ? "privacy"
                                : "terms"
                              }
                            />
                            {/* @ts-ignore — s-button supports submit at runtime */}
                            <s-button
                              variant="secondary"
                              submit=""
                              {...(isGeneratingPolicy ? { loading: "" } : {})}
                            >
                              {isGeneratingPolicy ? "Generating…" : "Generate Policy with AI"}
                            </s-button>
                          </policyFetcher.Form>
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

// ─── Security Status Sidebar ──────────────────────────────────────────────────

function SecurityStatusAside({
  score,
  criticalCount,
  warningCount,
  previousScan,
}: {
  score: number | null;
  criticalCount: number;
  warningCount: number;
  previousScan: Scan | null;
}) {
  // Trend calculation
  let trendArrow = "";
  let trendText = "";
  if (score !== null && previousScan?.compliance_score != null) {
    const prevScore = previousScan.compliance_score;
    if (score > prevScore) {
      trendArrow = "↑";
      trendText = `Improved from ${prevScore}%`;
    } else if (score < prevScore) {
      trendArrow = "↓";
      trendText = `Declined from ${prevScore}%`;
    } else {
      trendArrow = "→";
      trendText = "Unchanged";
    }
  }

  return (
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
            {trendArrow && (
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "13px",
                  color: trendArrow === "↑" ? "#1a9e5c" : trendArrow === "↓" ? "#e51c00" : "#6d7175",
                  fontWeight: 600,
                }}
              >
                {trendArrow} {trendText}
              </div>
            )}
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
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function Index() {
  const {
    merchant,
    latestScan,
    previousScan,
    lastAutomatedScan,
    checkResults,
    newAutoIssueCount,
  } = useLoaderData<typeof loader>();

  const fetcher       = useFetcher<ApiScanResponse>();
  const policyFetcher = useFetcher<ApiScanResponse>();
  const revalidator   = useRevalidator();
  const navigate      = useNavigate();
  const shopify       = useAppBridge();

  const navigateToUpgrade = useCallback(
    () => navigate("/app/upgrade?plan=Pro"),
    [navigate],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [toastId, setToastId]           = useState<string | null>(null);
  const [allExpanded, setAllExpanded]   = useState(false);
  const [generatedPolicy, setGeneratedPolicy] = useState<ApiScanResponse["policy"] | null>(null);
  const [policyRemaining, setPolicyRemaining] = useState<number | null>(null);
  const [policyLimitMessage, setPolicyLimitMessage] = useState<string | null>(null);

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

  const isGeneratingPolicy =
    policyFetcher.state === "submitting" || policyFetcher.state === "loading";

  const scanError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.success
      ? (fetcher.data.message ?? "Scan failed — please try again.")
      : null;

  const scanLimitReached =
    fetcher.state === "idle" &&
    fetcher.data?.error_code === "scan_limit_reached";

  // Handle policy generation response
  useEffect(() => {
    if (policyFetcher.state !== "idle" || !policyFetcher.data) return;

    if (policyFetcher.data.success && policyFetcher.data.policy) {
      setGeneratedPolicy(policyFetcher.data.policy);
      setPolicyLimitMessage(null);
      if (policyFetcher.data.policy_remaining != null) {
        setPolicyRemaining(policyFetcher.data.policy_remaining);
      }
      shopify.toast.show("Policy generated");
    } else if (policyFetcher.data.error === "policy_limit_reached") {
      setPolicyLimitMessage(policyFetcher.data.message ?? "Policy generation limit reached.");
    }
  }, [policyFetcher.state, policyFetcher.data, shopify]);

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

  const freeUserUsedScan =
    merchant?.tier !== "pro" &&
    merchant?.scans_remaining !== null &&
    merchant?.scans_remaining !== undefined &&
    merchant.scans_remaining <= 0;

  return (
    <s-page heading="ShieldKit — Compliance Command Center">

      {/* ── Primary action (dashboard state only) ────────────────────────── */}
      {!showOnboarding && merchant && (
        merchant.tier === "pro" || (merchant.scans_remaining !== null && merchant.scans_remaining > 0) ? (
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={runScan}
            {...(isScanning ? { loading: "" } : {})}
          >
            {isScanning ? "Scanning…" : "Re-run Scan"}
          </s-button>
        ) : (
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={navigateToUpgrade}
          >
            Upgrade to Pro
          </s-button>
        )
      )}

      {/* ── Scan error feedback ───────────────────────────────────────────── */}
      {scanError && (
        <s-banner
          heading={scanLimitReached ? "Free scan used" : "Scan failed"}
          tone={scanLimitReached ? "warning" : "critical"}
          {...{ dismissible: true }}
        >
          {scanError}
          {scanLimitReached && (
            <>
              {" "}
              <s-button slot="actions" onClick={navigateToUpgrade}>
                Upgrade to Pro
              </s-button>
            </>
          )}
        </s-banner>
      )}

      {/* ── Billing cancellation banner ──────────────────────────────────── */}
      {showBillingBanner && (
        <s-banner
          tone="warning"
          onDismiss={dismissBillingBanner}
        >
          You're on the Free plan. Upgrade to Pro ($39/mo) for unlimited
          re-scans, AI policy generation, and full scan history.
          <s-button slot="actions" onClick={navigateToUpgrade}>
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
            {[
              {
                num: 1,
                bg: "var(--p-color-bg-surface-info, #e8f6fe)",
                title: "Welcome to ShieldKit",
                text: "ShieldKit runs a full 10-point audit of your Shopify store against every requirement that causes Google Merchant Center account suspensions — and shows you exactly how to fix each one.",
              },
              {
                num: 2,
                bg: "var(--p-color-bg-surface-warning, #fff5ea)",
                title: "Why GMC Compliance Matters",
                text: "Google frequently suspends Shopify stores for vague policy violations like \"Misrepresentation\", instantly cutting off your Google Shopping traffic. Worse, Google only gives you a limited number of appeals before a permanent ban. You must fix all trust signals before requesting a review.",
              },
              {
                num: 3,
                bg: "var(--p-color-bg-surface-success, #f1f8f5)",
                title: "Run Your Free Compliance Scan",
                text: "Get a complete compliance audit in under 60 seconds. ShieldKit identifies exactly which issues to fix to protect your Google Shopping revenue before Google flags your store.",
              },
            ].map((step) => (
              <div
                key={step.num}
                style={{
                  display: "flex",
                  gap: "24px",
                  padding: "24px",
                  background: step.bg,
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
                  {step.num}
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
                    {step.title}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "15px",
                      color: "var(--p-color-text, #303030)",
                      lineHeight: 1.65,
                    }}
                  >
                    {step.text}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* ── Big primary CTA ── */}
          <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
            <fetcher.Form method="post">
              <input type="hidden" name="action" value="runScan" />
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
      {!showOnboarding && latestScan && merchant && (
        <div style={{ visibility: "visible", opacity: 1 }}>

          {/* ── Scanning progress indicator ── */}
          {isScanning && <ScanProgressIndicator />}

          {/* ── Score banner ── */}
          <ScoreBanner
            merchant={merchant}
            score={score}
            latestScan={latestScan}
            lastAutomatedScan={lastAutomatedScan}
            newAutoIssueCount={newAutoIssueCount}
            isScanning={isScanning}
          />

          {/* ── KPI metric cards ── */}
          <KpiCards
            truePassedCount={truePassedCount}
            totalChecks={totalChecks}
            criticalCount={criticalCount}
            warningCount={warningCount}
            skippedCount={skippedCount}
          />

          {/* ── Upgrade CTA for free-tier users who have used their scan ── */}
          {freeUserUsedScan && <UpgradeCard onUpgrade={navigateToUpgrade} />}

          {/* ── Inline upgrade banner for free users with remaining scans ── */}
          {merchant.tier !== "pro" && !freeUserUsedScan && sortedChecks.length > 0 && (
            <s-section>
              <s-banner tone="info">
                Upgrade to Pro ($39/mo) for unlimited re-scans, AI policy
                generation, and full scan history.
                <s-button slot="actions" onClick={navigateToUpgrade}>
                  Upgrade to Pro
                </s-button>
              </s-banner>
            </s-section>
          )}

          {/* ── 10-point audit checklist ── */}
          <AuditChecklist
            sortedChecks={sortedChecks}
            totalChecks={totalChecks}
            truePassedCount={truePassedCount}
            allExpanded={allExpanded}
            onToggleExpand={() => setAllExpanded((v) => !v)}
            merchant={merchant}
            policyFetcher={policyFetcher}
            isGeneratingPolicy={isGeneratingPolicy}
          />

          {/* ── Policy generator display ── */}
          <PolicyGeneratorDisplay
            generatedPolicy={generatedPolicy}
            policyRemaining={policyRemaining}
            policyLimitMessage={policyLimitMessage}
            onDismiss={() => setGeneratedPolicy(null)}
            onDismissLimit={() => setPolicyLimitMessage(null)}
            onCopy={(text) => {
              navigator.clipboard.writeText(text);
              shopify.toast.show("Policy copied to clipboard");
            }}
          />

        </div>
      )}

      {/* ═══════════════════════ ASIDE COLUMN ══════════════════════════════ */}

      <SecurityStatusAside
        score={score}
        criticalCount={criticalCount}
        warningCount={warningCount}
        previousScan={previousScan}
      />

      {/* Free JSON-LD Extension */}
      <s-section slot="aside" heading="Free JSON-LD Structured Data">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <s-paragraph>
            Your ShieldKit installation includes a free theme extension that
            adds correct Product JSON-LD structured data to every product page
            — helping you pass compliance check #8 and improve Google Shopping
            visibility.
          </s-paragraph>
          <s-paragraph>
            <strong>Enable it:</strong> Online Store &rarr; Themes &rarr;
            Customize &rarr; Add app block &rarr; ShieldKit Product Schema
            (JSON-LD).
          </s-paragraph>
        </div>
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
