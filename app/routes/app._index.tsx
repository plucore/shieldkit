/**
 * app/routes/app._index.tsx
 *
 * ShieldKit — GMC Compliance Command Center
 *
 *  1. ONBOARDING (latestScan === null)
 *     Logo + vertical 4-step wizard (welcome → enable JSON-LD → why it
 *     matters → run scan) + full-width "Run Free Scan" CTA.
 *
 *  2. DASHBOARD (latestScan !== null)
 *     Score banner -> KPI metric cards (4-up) -> 12-point audit checklist
 *     with full fix instructions exposed.
 *
 *  ASIDE (both states)
 *     Security Status card + About ShieldKit card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { getActiveSubscriptionByChargeId } from "../lib/billing/partner-api.server";
import { hasPaidAccess } from "../lib/billing/plans";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import {
  generatePolicy,
  type PolicyType,
} from "../lib/policy-generator.server";
import { validateGeneratedPolicy } from "../lib/policy-validator.server";
import {
  AI_MONTHLY_CAP,
  checkAndConsumeAiCredit,
  windowResetIso,
} from "../lib/ai-usage.server";
import { wrapAdminClient, getShopInfo } from "../lib/shopify-api.server";
import { verifyJsonLdForMerchant } from "../lib/json-ld-verifier.server";
import { getJsonLdThemeEditorUrl } from "../lib/json-ld-deep-link";
import { boundary } from "@shopify/shopify-app-react-router/server";
import styles from "../styles.css?url";

import type { Merchant, Scan, CheckResult, ApiScanResponse } from "../lib/types";
import { sortChecks } from "../lib/scan-helpers";
import { useWebComponentClick } from "../hooks/useWebComponentClick";

import ScoreBanner from "../components/ScoreBanner";
import KpiCards from "../components/KpiCards";
import ScoreTrend from "../components/ScoreTrend";
import ScanProgressIndicator from "../components/ScanProgressIndicator";
import UpgradeCard from "../components/UpgradeCard";
import PolicyGenerationCard from "../components/PolicyGenerationCard";
import AuditChecklist from "../components/AuditChecklist";
import SecurityStatusAside from "../components/SecurityStatusAside";
import AIVisibilityCard from "../components/AIVisibilityCard";

// ─── Asset preloading ─────────────────────────────────────────────────────────

export const links: LinksFunction = () => [
  { rel: "preload", href: "/logo-main.webp", as: "image", type: "image/webp" },
  { rel: "stylesheet", href: styles },
];

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const { data: merchantRow } = await supabase
    .from("merchants")
    .select(
      "id, shopify_domain, primary_domain, scans_remaining, tier, billing_cycle, " +
      "shopify_subscription_id, json_ld_enabled, json_ld_enable_clicked_at, " +
      "json_ld_verified_at, generated_policies, policy_regen_used, review_prompted",
    )
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  const merchant = merchantRow as Merchant | null;

  // ── Billing self-heal: moved off the critical render path (Fix 6) ────────
  // Previously this loader synchronously called Partner API on every
  // paid-merchant dashboard render, blocking page paint on an external
  // GraphQL roundtrip (300ms–3.5s with backoff). The work is identical
  // but now runs in a post-mount useEffect via the `selfHealBilling`
  // action defined below, so the dashboard paints from cached DB state
  // immediately and reconciles in the background.
  //
  // The action returns { healed, newTier? }; on healed=true the component
  // calls revalidator.revalidate() to pull the new tier into the loader.
  //
  // /app/billing/confirm still self-heals inline because that path is
  // already user-facing post-approval and the 1–2s wait is the right UX.

  // Shopify app client_id, used by the JSON-LD theme-editor deep link.
  // Read here in the loader (server-side) and threaded through to the
  // component because Vite does not expose process.env to the browser —
  // the helper used to read it itself and threw on the dashboard.
  const shopifyApiKey = process.env.SHOPIFY_API_KEY ?? "";

  if (!merchant) {
    return {
      shopDomain,
      shopifyApiKey,
      merchant:          null as Merchant | null,
      latestScan:        null as Scan | null,
      previousScan:      null as Scan | null,
      lastAutomatedScan: null as Scan | null,
      checkResults:      [] as CheckResult[],
      newAutoIssueCount: 0,
      trendScans:        [] as Scan[],
      aiVisibility:      null as null | { thisWeekHits: number; priorWeekHits: number; topCrawlers: string[] },
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

  // Fetch last automated scan — only meaningful for tiers with weekly
  // monitoring (monitoring, recovery, grandfathered pro). Free + shield
  // have no automated scans to compare against.
  let lastAutomatedScan: Scan | null = null;
  if (hasPaidAccess(merchant.tier)) {
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
  if (lastAutomatedScan && hasPaidAccess(merchant.tier)) {
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

  // Phase 7 — pull last 30 days of scans for the dashboard score trend.
  let trendScans: Scan[] = [];
  {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: trendRows } = await supabase
      .from("scans")
      .select(
        "id, scan_type, compliance_score, total_checks, passed_checks, " +
        "critical_count, warning_count, info_count, created_at"
      )
      .eq("merchant_id", merchant.id)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: true });
    trendScans = (trendRows ?? []) as Scan[];
  }

  // AI visibility — a Monitoring feature. Available to monitoring,
  // recovery, and grandfathered pro (Shield Max).
  let aiVisibility: { thisWeekHits: number; priorWeekHits: number; topCrawlers: string[] } | null = null;
  if (hasPaidAccess(merchant.tier)) {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const [{ count: thisWeek }, { count: priorWeek }, { data: recentRows }] =
      await Promise.all([
        supabase
          .from("llms_txt_requests")
          .select("id", { count: "exact", head: true })
          .eq("shop_domain", shopDomain)
          .gte("created_at", sevenDaysAgo),
        supabase
          .from("llms_txt_requests")
          .select("id", { count: "exact", head: true })
          .eq("shop_domain", shopDomain)
          .gte("created_at", fourteenDaysAgo)
          .lt("created_at", sevenDaysAgo),
        supabase
          .from("llms_txt_requests")
          .select("crawler_name")
          .eq("shop_domain", shopDomain)
          .gte("created_at", sevenDaysAgo),
      ]);

    const counts: Record<string, number> = {};
    for (const r of (recentRows ?? []) as Array<{ crawler_name: string | null }>) {
      const name = r.crawler_name ?? "other";
      counts[name] = (counts[name] ?? 0) + 1;
    }
    const topCrawlers = Object.entries(counts)
      .filter(([n]) => n !== "other")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n]) => n);

    aiVisibility = {
      thisWeekHits: thisWeek ?? 0,
      priorWeekHits: priorWeek ?? 0,
      topCrawlers,
    };
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
    shopifyApiKey,
    merchant,
    latestScan,
    previousScan,
    lastAutomatedScan,
    checkResults,
    newAutoIssueCount,
    trendScans,
    aiVisibility,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const actionType = formData.get("action");

  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // ── Generate Policy action (paid only) ────────────────────────────────────
  if (actionType === "generatePolicy") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id, tier, generated_policies, policy_regen_used")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (!merchant || !hasPaidAccess(merchant.tier)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "A paid plan is required for AI policy generation.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
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

    // Per-type regen cap (UX nudge — 2/type total).
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

    // Monthly AI cap (12/window, shared across policies + appeal letters).
    // Consumed BEFORE we hit Anthropic so a cap-reached request never
    // costs a model call. The internal validator retry below does NOT
    // consume a second credit — see comment by the retry.
    const credit = await checkAndConsumeAiCredit(merchant.id);
    if (!credit.allowed) {
      const resetIso = windowResetIso(credit.resetAt);
      const resetDate = resetIso
        ? new Date(resetIso).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "soon";
      return new Response(
        JSON.stringify({
          success: false,
          error: "ai_cap_reached",
          message: `You've used all ${AI_MONTHLY_CAP} AI generations this month. Your limit resets on ${resetDate}.`,
          remaining: 0,
          reset_at: resetIso,
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
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

      // First-pass generation.
      let policy = await generatePolicy(policyType, shopInfo);
      let validation = validateGeneratedPolicy(policyType, policy.body);

      // If the model missed required content signals, retry ONCE with an
      // appended instruction listing what to include. The retry does NOT
      // consume a second AI credit — from the merchant's perspective the
      // two model calls are one generation.
      if (!validation.valid) {
        const extra = `Your previous output was missing or violated these signals: ${validation.missing.join(", ")}. Re-generate the policy and make sure each is present and unambiguous.`;
        try {
          const retryPolicy = await generatePolicy(policyType, shopInfo, extra);
          const retryValidation = validateGeneratedPolicy(policyType, retryPolicy.body);
          if (retryValidation.valid || retryValidation.missing.length < validation.missing.length) {
            policy = retryPolicy;
            validation = retryValidation;
          }
        } catch (_) {
          // Retry threw — keep the first-pass policy. The soft-warning
          // path below still fires.
        }
      }

      // Save the (best-of-two) policy text.
      const updatedPolicies = { ...generatedPolicies, [policyType]: policy.body };
      const updatePayload: Record<string, unknown> = {
        generated_policies: updatedPolicies,
      };
      if (alreadyGenerated) {
        updatePayload.policy_regen_used = { ...regenUsed, [policyType]: true };
      }
      await supabase
        .from("merchants")
        .update(updatePayload)
        .eq("id", merchant.id);

      // If still invalid after the retry, return the policy with a soft
      // warning so the merchant knows to review it before saving.
      const warning = validation.valid
        ? null
        : `Review this policy — it may be missing: ${validation.missing.join(", ")}.`;

      return new Response(
        JSON.stringify({
          success: true,
          policy,
          warning,
          generated_policies: updatedPolicies,
          policy_regen_used: alreadyGenerated
            ? { ...regenUsed, [policyType]: true }
            : regenUsed,
          ai_remaining: credit.remaining,
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
  // Sets clicked_at only — the verifier (cron or verifyJsonLdNow) flips
  // json_ld_enabled true once the storefront actually renders the block.
  // This was previously flipping enabled=true on click, which hid the
  // "block never saved" failure mode and inflated activation numbers.
  if (actionType === "enableJsonLd") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (merchant) {
      await supabase
        .from("merchants")
        .update({
          json_ld_enable_clicked_at: new Date().toISOString(),
          // Explicitly reset attempts so a re-click after a failed run gives
          // the verifier a fresh 5-attempt budget.
          json_ld_verification_attempts: 0,
        })
        .eq("id", merchant.id);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Self-heal billing action (Fix 6) ──────────────────────────────────────
  // Fires once on dashboard mount via useEffect when tier !== 'free'. Same
  // contract as the old inline loader block: reconcile against Partner API,
  // never demote on uncertainty, only act on status=active.
  if (actionType === "selfHealBilling") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select(
        "id, tier, billing_cycle, scans_remaining, shopify_subscription_id",
      )
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (!merchant || !merchant.shopify_subscription_id) {
      return new Response(
        JSON.stringify({ success: true, healed: false, reason: "no_subscription" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const sub = await getActiveSubscriptionByChargeId(
        merchant.shopify_subscription_id as string,
      );

      if (sub.status === "unknown") {
        console.warn(
          `[self-heal] partner-api status=unknown for ${shopDomain} reason=${sub.reason ?? ""} — leaving DB untouched`,
        );
        return new Response(
          JSON.stringify({ success: true, healed: false, reason: "unknown" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (sub.status === "active" && sub.tier && sub.tier !== "free") {
        const drift =
          merchant.tier !== sub.tier ||
          (merchant as { billing_cycle?: string }).billing_cycle !== sub.cycle ||
          merchant.shopify_subscription_id !== sub.subscriptionGid ||
          merchant.scans_remaining !== null;

        if (drift) {
          await supabase
            .from("merchants")
            .update({
              tier: sub.tier,
              billing_cycle: sub.cycle,
              shopify_subscription_id: sub.subscriptionGid,
              subscription_started_at:
                sub.activatedAt ?? new Date().toISOString(),
              scans_remaining: null,
            })
            .eq("id", merchant.id);

          return new Response(
            JSON.stringify({
              success: true,
              healed: true,
              newTier: sub.tier,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Terminal statuses (cancelled / declined / expired / frozen) are
      // NOT acted on here — that's the reconcile-subscriptions cron's job.
      // Dashboards must never demote.
      return new Response(
        JSON.stringify({ success: true, healed: false, reason: sub.status }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      console.error(
        `[self-heal] partner-api threw for ${shopDomain}:`,
        err instanceof Error ? err.message : err,
      );
      return new Response(
        JSON.stringify({ success: true, healed: false, reason: "error" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // ── Verify JSON-LD now action ─────────────────────────────────────────────
  // Inline verifier run for the "Verify now" button in the pending state.
  // Gives the merchant immediate feedback rather than waiting up to 2h for
  // the cron. Reuses the same code path so behaviour is identical.
  if (actionType === "verifyJsonLdNow") {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id, shopify_domain, primary_domain")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (!merchant) {
      return new Response(
        JSON.stringify({ success: false, message: "Merchant not found." }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await verifyJsonLdForMerchant(
      merchant.id,
      merchant.shopify_domain as string,
      (merchant.primary_domain as string | null) ?? null,
    );

    return new Response(
      JSON.stringify({
        success: true,
        verified: result.verified,
        reason: result.reason,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
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

  // ── Quota enforcement (atomic decrement) ──────────────────────────────────
  const scansRemaining: number | null = merchant.scans_remaining;

  if (scansRemaining !== null) {
    // Atomic decrement — returns the new value, or no rows if already exhausted.
    const { data: rpcResult, error: rpcError } = await supabase
      .rpc("decrement_scan_quota", { p_merchant_id: merchant.id });

    if (rpcError) {
      // RPC not deployed yet — fall back to non-atomic check
      if (scansRemaining <= 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error_code: "scan_limit_reached",
            message: "You've used your free scan. Upgrade to Monitoring for unlimited on-demand scans plus AI-written policies, appeal letters, and AI search visibility.",
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
    } else if (!rpcResult || (Array.isArray(rpcResult) && rpcResult.length === 0)) {
      return new Response(
        JSON.stringify({
          success: false,
          error_code: "scan_limit_reached",
          message: "You've used your free scan. Upgrade to Monitoring for unlimited on-demand scans plus AI-written policies, appeal letters, and AI search visibility.",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  let scanResult: Awaited<ReturnType<typeof runComplianceScan>>;
  try {
    scanResult = await runComplianceScan(merchant.id, shopDomain, "manual");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Compensating refund: the quota was already decremented above. If the
    // scan failed before a row landed in the `scans` table, the merchant
    // would otherwise burn their one free scan on an internal error.
    // Skipped for unlimited (paid) merchants where scans_remaining is NULL.
    if (scansRemaining !== null) {
      const { error: refundErr } = await supabase
        .from("merchants")
        .update({ scans_remaining: (scansRemaining ?? 0) + 1 })
        .eq("id", merchant.id)
        .not("scans_remaining", "is", null);
      if (refundErr) {
        console.error(
          `[runScan] scan failed AND quota refund failed for ${shopDomain}: scan=${message}, refund=${refundErr.message}`,
        );
      } else {
        console.warn(
          `[runScan] scan failed for ${shopDomain}, refunded 1 scan to quota: ${message}`,
        );
      }
    } else {
      console.error(`[runScan] scan failed for ${shopDomain}: ${message}`);
    }

    return new Response(
      JSON.stringify({
        success: false,
        message:
          "We hit an error running your scan. Your scan quota has been restored — please try again. If this keeps happening, contact support.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
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
    shopifyApiKey,
    merchant,
    latestScan,
    previousScan,
    lastAutomatedScan,
    checkResults,
    newAutoIssueCount,
    trendScans,
    aiVisibility,
  } = useLoaderData<typeof loader>();

  const fetcher        = useFetcher<ApiScanResponse>();
  const policyFetcher  = useFetcher<ApiScanResponse>();
  const jsonLdFetcher  = useFetcher();
  const verifyJsonLdFetcher = useFetcher<{
    success: boolean;
    verified?: boolean;
    reason?: string;
  }>();
  const selfHealFetcher = useFetcher<{
    success: boolean;
    healed: boolean;
    newTier?: string;
    reason?: string;
  }>();
  const reviewFetcher  = useFetcher();
  const revalidator    = useRevalidator();
  const navigate      = useNavigate();
  const shopify       = useAppBridge();

  const navigateToUpgrade = useCallback(
    () => navigate("/app/upgrade"),
    [navigate],
  );
  const navigateToPlanSwitcher = useCallback(
    () => navigate("/app/plan-switcher"),
    [navigate],
  );

  // tier-aware helpers — v3 has free, monitoring, recovery, plus the
  // grandfathered shield + pro tiers preserved for the 2 live Shield Max
  // customers. Feature access goes through hasPaidAccess; tier-string
  // comparisons here are only for upgrade
  // CTA placement (which tier the merchant is on, not which features they
  // can use).
  const tier = merchant?.tier ?? "free";
  const isPaid = hasPaidAccess(tier);
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

  // Fire selfHealBilling once on mount for paid merchants (Fix 6). The
  // useRef guard prevents re-firing on re-renders or revalidations.
  // Skipped for free tier — they have no shopify_subscription_id and the
  // action would no-op anyway.
  const selfHealFiredRef = useRef(false);
  useEffect(() => {
    if (selfHealFiredRef.current) return;
    if (!merchant || merchant.tier === "free") return;
    selfHealFiredRef.current = true;
    selfHealFetcher.submit(
      { action: "selfHealBilling" },
      { method: "POST" },
    );
  }, [merchant, selfHealFetcher]);

  // When self-heal reports drift was fixed, revalidate so the dashboard
  // re-renders with the new tier / scans_remaining values.
  useEffect(() => {
    if (selfHealFetcher.state !== "idle" || !selfHealFetcher.data) return;
    if (selfHealFetcher.data.healed) {
      revalidator.revalidate();
    }
  }, [selfHealFetcher.state, selfHealFetcher.data, revalidator]);

  // Handle "Verify now" response — refresh loader on positive so the card
  // flips to "Active ✓". Negative responses display the inline hint.
  useEffect(() => {
    if (verifyJsonLdFetcher.state !== "idle" || !verifyJsonLdFetcher.data) return;
    if (verifyJsonLdFetcher.data.verified) {
      shopify.toast.show("JSON-LD verified");
      revalidator.revalidate();
    }
  }, [verifyJsonLdFetcher.state, verifyJsonLdFetcher.data, shopify, revalidator]);

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

  const score         = latestScan?.compliance_score != null ? Math.round(latestScan.compliance_score) : null;
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
    !isPaid &&
    merchant?.scans_remaining !== null &&
    merchant?.scans_remaining !== undefined &&
    merchant.scans_remaining <= 0;

  // ── Top-level navigation for the JSON-LD theme editor link ──────────────
  // Wrapping <s-button> in an <a target="_top"> doesn't work — the button
  // intercepts the click before it reaches the anchor.
  const manageJsonLdHref = getJsonLdThemeEditorUrl(
    shopDomain,
    "product-schema",
    shopifyApiKey,
  );
  const openJsonLdManager = useCallback(() => {
    window.open(manageJsonLdHref, "_top");
  }, [manageJsonLdHref]);

  // ── Web component click refs (native DOM events for <s-button>) ───────────
  const rescanRef        = useWebComponentClick<HTMLElement>(runScan);
  const managePlanRef    = useWebComponentClick<HTMLElement>(navigateToPlanSwitcher);
  const upgradeRef2      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const upgradeRef3      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const upgradeRef4      = useWebComponentClick<HTMLElement>(navigateToUpgrade);
  const manageJsonLdRef  = useWebComponentClick<HTMLElement>(openJsonLdManager);
  const onboardingScanRef = useWebComponentClick<HTMLElement>(runScan);

  return (
    <s-page heading="ShieldKit — Compliance Command Center">

      {/* ── Primary action (dashboard state only) ────────────────────────── */}
      {!showOnboarding && merchant && (
        isPaid || (merchant.scans_remaining !== null && merchant.scans_remaining > 0) ? (
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
            ref={managePlanRef}
          >
            Manage plan
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
                Upgrade
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
          You're on the Free plan. Upgrade for unlimited scans and AI search
          visibility — catch issues before Google does.
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
              src="/logo-main.webp"
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
            {/* 4-step wizard. Step 2 = Enable JSON-LD (Fix 5 — surface
                structured-data before the merchant ever scans, so the
                activation rate can climb above the pre-fix 38%). The CTA
                in step 2 wires to the same enableJsonLd action as the
                aside card, so the verifier picks the click up identically. */}
            {[
              {
                num: 1,
                bg: "var(--p-color-bg-surface-info, #e8f6fe)",
                title: "Welcome to ShieldKit",
                text: "ShieldKit runs a full 12-point audit of your Shopify store against every requirement that causes Google Merchant Center account suspensions — and shows you exactly how to fix each one.",
              },
              {
                num: 2,
                bg: "var(--p-color-bg-surface-success, #f1f8f5)",
                title: "Enable Free Structured Data",
                text: "Adds Google-required Product schema to every product page. Free, runs forever, no scan required.",
                isJsonLdStep: true,
              },
              {
                num: 3,
                bg: "var(--p-color-bg-surface-warning, #fff5ea)",
                title: "Why GMC Compliance Matters",
                text: "Google frequently suspends Shopify stores for vague policy violations like \"Misrepresentation\", instantly cutting off your Google Shopping traffic. Worse, Google only gives you a limited number of appeals before a permanent ban. You must fix all trust signals before requesting a review.",
              },
              {
                num: 4,
                bg: "var(--p-color-bg-surface-info, #e8f6fe)",
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
                <div style={{ flex: 1 }}>
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

                  {step.isJsonLdStep && (
                    <div style={{ marginTop: "14px" }}>
                      {merchant?.json_ld_verified_at ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            fontSize: "14px",
                            fontWeight: 600,
                            color: "#1a9e5c",
                          }}
                        >
                          <s-icon
                            type="check-circle-filled"
                            tone="success"
                            size="base"
                          />
                          Enabled ✓
                        </div>
                      ) : merchant?.json_ld_enable_clicked_at ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            fontSize: "14px",
                            fontWeight: 600,
                            color: "#e8820c",
                          }}
                        >
                          <s-icon type="clock" tone="caution" size="base" />
                          Pending verification — we&rsquo;ll confirm within an hour
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            jsonLdFetcher.submit(
                              { action: "enableJsonLd" },
                              { method: "POST" },
                            );
                            window.open(
                              getJsonLdThemeEditorUrl(shopDomain, "product-schema", shopifyApiKey),
                              "_top",
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
                          Enable JSON-LD on my theme
                        </button>
                      )}
                    </div>
                  )}
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

          {/* ── Score trend (last 30 days) ── */}
          <ScoreTrend scans={trendScans} currentScore={score} />

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

          {/* ── Inline upgrade banner (free only) ─────────────────────────
             v4 removed the Monitoring→Recovery upsell banner — there's
             only one paid tier now, so a paid merchant has nothing to
             upsell to. */}
          {tier === "free" && sortedChecks.length > 0 && (
            <s-section>
              <s-banner tone="info">
                Upgrade for unlimited on-demand scans and AI-written policies
                — fix issues before Google flags them.
                <s-button slot="actions" ref={upgradeRef4}>
                  See plans
                </s-button>
              </s-banner>
            </s-section>
          )}

          {/* ── 12-point audit checklist ── */}
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

      {/* Upgrade CTA — hidden once the merchant has full recovery access.
          Monitoring merchants still see an upsell toward Recovery. */}
      {merchant && !isPaid && !showOnboarding && (
        <UpgradeCard tier={tier} onUpgrade={navigateToUpgrade} sidebar />
      )}

      {/* Policy Generation card — AI policy rewrites are a Recovery feature.
          Available to recovery + grandfathered pro (Shield Max). */}
      {merchant && isPaid && !showOnboarding && (
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

      {/* AI visibility — a Monitoring feature. Available to monitoring,
          recovery, and grandfathered pro. */}
      {merchant && isPaid && aiVisibility && !showOnboarding && (
        <s-section slot="aside">
          <AIVisibilityCard
            thisWeekHits={aiVisibility.thisWeekHits}
            priorWeekHits={aiVisibility.priorWeekHits}
            topCrawlers={aiVisibility.topCrawlers}
          />
        </s-section>
      )}

      {/* Free JSON-LD Extension — three-state UI driven by clicked_at /
          verified_at columns (Fix 3 — 2026-05-27 audit). Was previously
          flipping enabled=true on click, which inflated the activation
          number and hid the "block never saved" failure mode. */}
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
          {merchant?.json_ld_verified_at ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <s-icon type="check-circle-filled" tone="success" size="base" />
                <span style={{ fontSize: "14px", fontWeight: 600, color: "#1a9e5c" }}>
                  JSON-LD Active ✓
                </span>
              </div>
              <s-paragraph>
                Product structured data is being added to your product pages.
              </s-paragraph>
              <s-button ref={manageJsonLdRef}>Manage</s-button>
            </>
          ) : merchant?.json_ld_enable_clicked_at ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <s-icon type="clock" tone="caution" size="base" />
                <span style={{ fontSize: "14px", fontWeight: 600, color: "#e8820c" }}>
                  Verification pending
                </span>
              </div>
              <s-paragraph>
                We'll check your storefront within an hour. If the block was
                saved in your theme editor, this will flip to Active.
              </s-paragraph>
              <button
                type="button"
                disabled={
                  verifyJsonLdFetcher.state !== "idle"
                }
                onClick={() =>
                  verifyJsonLdFetcher.submit(
                    { action: "verifyJsonLdNow" },
                    { method: "POST" },
                  )
                }
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "#fff",
                  background: "#0f172a",
                  border: "none",
                  borderRadius: "8px",
                  padding: "8px 16px",
                  cursor: verifyJsonLdFetcher.state !== "idle" ? "wait" : "pointer",
                  opacity: verifyJsonLdFetcher.state !== "idle" ? 0.7 : 1,
                }}
              >
                {verifyJsonLdFetcher.state !== "idle" ? "Verifying…" : "Verify now"}
              </button>
              {verifyJsonLdFetcher.state === "idle" &&
                verifyJsonLdFetcher.data &&
                "verified" in verifyJsonLdFetcher.data &&
                !verifyJsonLdFetcher.data.verified && (
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#e51c00",
                    }}
                  >
                    Couldn't find the block on your storefront yet. Open your
                    theme editor again, drop in &quot;Product Schema (JSON-LD)&quot;
                    on your product template, and click Save.
                  </div>
                )}
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
                    getJsonLdThemeEditorUrl(shopDomain, "product-schema", shopifyApiKey),
                    "_top",
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
