/**
 * app/routes/app._index.tsx
 *
 * ShieldKit — GMC Compliance Command Center
 *
 *  1. ONBOARDING (latestScan === null)
 *     Logo + vertical 3-step wizard + full-width "Run Free Scan" CTA.
 *
 *  2. DASHBOARD (latestScan !== null)
 *     Score banner -> KPI metric cards (4-up) -> 10-point audit checklist
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
import { authenticate, PLAN_PRO } from "../shopify.server";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import {
  generatePolicy,
  type PolicyType,
} from "../lib/policy-generator.server";
import { wrapAdminClient, getShopInfo } from "../lib/shopify-api.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import styles from "../styles.css?url";

import type { Merchant, Scan, CheckResult, ApiScanResponse } from "../lib/types";
import { sortChecks } from "../lib/scan-helpers";
import { useWebComponentClick } from "../hooks/useWebComponentClick";

import ScoreBanner from "../components/ScoreBanner";
import KpiCards from "../components/KpiCards";
import ScanProgressIndicator from "../components/ScanProgressIndicator";
import UpgradeCard from "../components/UpgradeCard";
import PolicyGenerationCard from "../components/PolicyGenerationCard";
import AuditChecklist from "../components/AuditChecklist";
import SecurityStatusAside from "../components/SecurityStatusAside";

// ─── Asset preloading ─────────────────────────────────────────────────────────

export const links: LinksFunction = () => [
  { rel: "preload", href: "/logo-main.png", as: "image" },
  { rel: "stylesheet", href: styles },
];

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const { data: merchantRow } = await supabase
    .from("merchants")
    .select("id, shopify_domain, scans_remaining, tier, json_ld_enabled, generated_policies, policy_regen_used, review_prompted")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  let merchant = merchantRow as Merchant | null;

  // ── Billing self-heal: if Shopify says paid but Supabase tier is stale ──
  if (merchant && merchant.tier !== "pro") {
    try {
      const billingCheck = await billing.check({
        plans: [PLAN_PRO],
        isTest: process.env.NODE_ENV !== "production",
        returnObject: true,
      });
      if (billingCheck.hasActivePayment) {
        await supabase
          .from("merchants")
          .update({ tier: "pro", scans_remaining: null })
          .eq("id", merchant.id);
        merchant = { ...merchant, tier: "pro", scans_remaining: null };
      }
    } catch (_) {
      // billing.check() throws when no subscription exists — expected for free tier
    }
  }

  if (!merchant) {
    return {
      shopDomain,
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

  // Fetch last automated scan (for Pro automated scan comparison)
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
    shopDomain,
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
      .select("id, tier, generated_policies, policy_regen_used")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (!merchant || merchant.tier !== "pro") {
      return new Response(
        JSON.stringify({ success: false, message: "Pro plan required for AI policy generation." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const policyType = formData.get("policyType") as PolicyType | null;
    if (!policyType || !["refund", "shipping", "privacy", "terms"].includes(policyType)) {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid policy type." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const generatedPolicies: Record<string, string> = merchant.generated_policies ?? {};
    const regenUsed: Record<string, boolean> = merchant.policy_regen_used ?? {};

    const alreadyGenerated = !!generatedPolicies[policyType];
    const alreadyRegenerated = !!regenUsed[policyType];

    // If already generated AND already regenerated, block further generation
    if (alreadyGenerated && alreadyRegenerated) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "regen_exhausted",
          message: "You've already used your one regeneration for this policy type.",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
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

      // Save the generated policy text
      const updatedPolicies = { ...generatedPolicies, [policyType]: policy.body };
      const updatePayload: Record<string, unknown> = {
        generated_policies: updatedPolicies,
      };

      // If this is a regeneration (already had a generated policy), mark regen as used
      if (alreadyGenerated) {
        updatePayload.policy_regen_used = { ...regenUsed, [policyType]: true };
      }

      await supabase
        .from("merchants")
        .update(updatePayload)
        .eq("id", merchant.id);

      return new Response(
        JSON.stringify({
          success: true,
          policy,
          generated_policies: updatedPolicies,
          policy_regen_used: alreadyGenerated
            ? { ...regenUsed, [policyType]: true }
            : regenUsed,
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

  // ── Dismiss review banner action ──────────────────────────────────────────
  if (actionType === "dismissReview") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (merchant) {
      await supabase
        .from("merchants")
        .update({ review_prompted: true })
        .eq("id", merchant.id);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Enable JSON-LD action ──────────────────────────────────────────────────
  if (actionType === "enableJsonLd") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (merchant) {
      await supabase
        .from("merchants")
        .update({ json_ld_enabled: true })
        .eq("id", merchant.id);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
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
        message: "You've used your free scan. Upgrade to Pro ($29 one-time) for unlimited re-scans.",
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

  // ── Collect merchant email for retargeting (fire-and-forget) ──────────────
  const collectEmail = async () => {
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

      if (!shopEmail) return;

      await supabase
        .from("leads")
        .upsert(
          { shop_domain: shopDomain, email: shopEmail },
          { onConflict: "shop_domain" }
        );
    } catch (_) {
      // silent — lead collection failure must never surface to the merchant
    }
  };

  collectEmail(); // intentionally not awaited

  return new Response(
    JSON.stringify({
      success: true,
      scanId: scanResult.scan.id,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function Index() {
  const {
    shopDomain,
    merchant,
    latestScan,
    previousScan,
    lastAutomatedScan,
    checkResults,
    newAutoIssueCount,
  } = useLoaderData<typeof loader>();

  const fetcher        = useFetcher<ApiScanResponse>();
  const policyFetcher  = useFetcher<ApiScanResponse>();
  const jsonLdFetcher  = useFetcher();
  const reviewFetcher  = useFetcher();
  const revalidator    = useRevalidator();
  const navigate      = useNavigate();
  const shopify       = useAppBridge();

  const navigateToUpgrade = useCallback(
    () => navigate("/app/upgrade?plan=Pro"),
    [navigate],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [allExpanded, setAllExpanded]   = useState(false);
  const [localPolicies, setLocalPolicies] = useState(merchant?.generated_policies ?? {});
  const [localRegenUsed, setLocalRegenUsed] = useState(merchant?.policy_regen_used ?? {});

  // Billing cancellation banner — shown once when redirected from billing flow.
  const [showBillingBanner, setShowBillingBanner] = useState(
    () => searchParams.get("billing") === "cancelled",
  );
  const dismissBillingBanner = useCallback(() => {
    setShowBillingBanner(false);
    setSearchParams((prev) => { prev.delete("billing"); return prev; }, { replace: true });
  }, [setSearchParams]);

  // Review request banner — shown after a scan exists, until dismissed server-side.
  const [showReviewBanner, setShowReviewBanner] = useState(
    () => latestScan !== null && !(merchant?.review_prompted ?? true),
  );
  const dismissReviewBanner = useCallback(() => {
    setShowReviewBanner(false);
    reviewFetcher.submit({ action: "dismissReview" }, { method: "POST" });
  }, [reviewFetcher]);

  const isScanning =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const generatingPolicyType: string | null =
    policyFetcher.state === "submitting" || policyFetcher.state === "loading"
      ? (policyFetcher.formData?.get("policyType") as string | null)
      : null;

  const scanError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.success
      ? (fetcher.data.message ?? "Scan failed — please try again.")
      : null;

  const scanLimitReached =
    fetcher.state === "idle" &&
    fetcher.data?.error_code === "scan_limit_reached";

  // Handle policy generation response — update local state optimistically
  useEffect(() => {
    if (policyFetcher.state !== "idle" || !policyFetcher.data) return;

    if (policyFetcher.data.success && policyFetcher.data.generated_policies) {
      setLocalPolicies(policyFetcher.data.generated_policies);
      if (policyFetcher.data.policy_regen_used) {
        setLocalRegenUsed(policyFetcher.data.policy_regen_used);
      }
      shopify.toast.show("Policy generated");
    }
  }, [policyFetcher.state, policyFetcher.data, shopify]);

  // Deduplicated toast — only fires once per unique scanId
  const [toastId, setToastId] = useState<string | null>(null);
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

  const runScan = useCallback(
    () => fetcher.submit({ action: "runScan" }, { method: "POST" }),
    [fetcher],
  );

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

  // ── Web component click refs (native DOM events for <s-button>) ───────────
  const rescanRef        = useWebComponentClick<HTMLElement>(runScan);
  const upgradeRef1      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const upgradeRef2      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const upgradeRef3      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const upgradeRef4      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const onboardingScanRef = useWebComponentClick<HTMLElement>(runScan);

  return (
    <s-page heading="ShieldKit — Compliance Command Center">

      {/* ── Primary action (dashboard state only) ────────────────────────── */}
      {!showOnboarding && merchant && (
        merchant.tier === "pro" || (merchant.scans_remaining !== null && merchant.scans_remaining > 0) ? (
          <s-button
            slot="primary-action"
            variant="primary"
            ref={rescanRef}
            {...(isScanning ? { loading: "" } : {})}
          >
            {isScanning ? "Scanning…" : "Re-Scan My Store"}
          </s-button>
        ) : (
          <s-button
            slot="primary-action"
            variant="primary"
            ref={upgradeRef1}
          >
            Unlock Full Scanner — $29 one-time
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
              <s-button slot="actions" ref={upgradeRef2}>
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
        >
          You're on the Free plan. Upgrade to Pro ($29 one-time) for unlimited
          re-scans and AI policy generation.
          <s-button slot="actions" ref={upgradeRef3}>
            View upgrade options
          </s-button>
          <button
            slot="actions"
            onClick={dismissBillingBanner}
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--p-color-text-subdued, #6d7175)",
              background: "none",
              border: "none",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Dismiss
          </button>
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
                ref={onboardingScanRef}
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

          {/* ── Review request banner ── */}
          {showReviewBanner && !isScanning && (
            <s-section>
              <s-banner tone="info">
                If ShieldKit helped, a quick review helps other merchants discover us.
                <button
                  slot="actions"
                  type="button"
                  onClick={() =>
                    window.open(
                      "https://apps.shopify.com/shieldkit/reviews",
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#fff",
                    background: "#0f172a",
                    border: "none",
                    borderRadius: "6px",
                    padding: "6px 14px",
                    cursor: "pointer",
                  }}
                >
                  Leave a Review
                </button>
                <button
                  slot="actions"
                  type="button"
                  onClick={dismissReviewBanner}
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "var(--p-color-text-subdued, #6d7175)",
                    background: "none",
                    border: "none",
                    padding: "0 0 0 8px",
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Dismiss
                </button>
              </s-banner>
            </s-section>
          )}

          {/* ── Inline upgrade banner for free users ── */}
          {merchant.tier !== "pro" && sortedChecks.length > 0 && (
            <s-section>
              <s-banner tone="info">
                Upgrade to Pro ($29 one-time) for unlimited re-scans and AI policy
                generation.
                <s-button slot="actions" ref={upgradeRef4}>
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
            tier={merchant.tier}
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

      {/* Upgrade CTA for free-tier users (sidebar) */}
      {merchant && merchant.tier !== "pro" && !showOnboarding && (
        <UpgradeCard onUpgrade={navigateToUpgrade} sidebar />
      )}

      {/* Policy Generation card (Pro only, sidebar) */}
      {merchant?.tier === "pro" && !showOnboarding && (
        <PolicyGenerationCard
          generatedPolicies={localPolicies}
          policyRegenUsed={localRegenUsed}
          checkResults={checkResults}
          policyFetcher={policyFetcher}
          generatingPolicyType={generatingPolicyType}
          onCopy={(text) => {
            navigator.clipboard.writeText(text);
            shopify.toast.show("Policy copied to clipboard");
          }}
        />
      )}

      {/* Free JSON-LD Extension */}
      <s-section slot="aside">
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            Free JSON-LD Structured Data
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {merchant?.json_ld_enabled ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <s-icon type="check-circle-filled" tone="success" size="base" />
                <span style={{ fontSize: "14px", fontWeight: 600, color: "#1a9e5c" }}>
                  JSON-LD Active
                </span>
              </div>
              <s-paragraph>
                Product structured data is being added to your product pages.
              </s-paragraph>
              <a
                href={`https://${shopDomain}/admin/themes/current/editor?context=apps&activateAppId=071fc51ee1ef7f358cdaed5f95922498/product-schema`}
                target="_top"
                style={{ textDecoration: "none" }}
              >
                <s-button>Manage</s-button>
              </a>
            </>
          ) : (
            <>
              <s-paragraph>
                Adds correct Product structured data to every product page to help
                Google Shopping index your products.
              </s-paragraph>
              <button
                type="button"
                onClick={() => {
                  jsonLdFetcher.submit(
                    { action: "enableJsonLd" },
                    { method: "POST" },
                  );
                  window.open(
                    `https://${shopDomain}/admin/themes/current/editor?context=apps&activateAppId=071fc51ee1ef7f358cdaed5f95922498/product-schema`,
                    "_top"
                  );
                }}
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "#fff",
                  background: "#0f172a",
                  border: "none",
                  borderRadius: "8px",
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                Enable JSON-LD
              </button>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--p-color-text-subdued, #6d7175)",
                }}
              >
                Opens your theme editor. Click Save to activate.
              </div>
            </>
          )}
        </div>
      </s-section>

      {/* About ShieldKit */}
      <s-section slot="aside">
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            About ShieldKit
          </div>
        </div>
        <s-paragraph>
          ShieldKit scans your store against Google Merchant Center policies
          and shows you exactly what to fix to avoid suspension.
        </s-paragraph>
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
