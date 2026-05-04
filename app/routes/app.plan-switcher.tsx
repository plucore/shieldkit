/**
 * app/routes/app.plan-switcher.tsx
 * Route: /app/plan-switcher
 *
 * Mandatory for Shopify App Store review:
 *   - Merchants must be able to view their current plan
 *   - Switch plans without contacting support
 *   - Cancel their subscription without contacting support
 *   - Page accessible from the main nav (see app/routes/app.tsx NavMenu)
 *
 * Layout: 2-card (Shield, Shield Pro) with a Monthly | Annual cycle toggle.
 * The toggle defaults to the merchant's current cycle if they have one.
 * Each card derives its concrete plan name from the toggle state — switching
 * cycles re-targets the "Switch to" button at the same tier's other variant.
 *
 * Switch flow:
 *   1. Cancel current Shopify subscription via billing.cancel()
 *   2. Re-create the new one via billing.request() (throws redirect to approval)
 *   Shopify handles proration on the new charge automatically.
 *
 * Cancel flow:
 *   1. billing.cancel() the current subscription
 *   2. UPDATE merchants set tier='free', scans_remaining=1, scans_reset_at=now(),
 *      and clear all paid-plan billing fields.
 */

import { useCallback, useState } from "react";
import {
  redirect,
  useFetcher,
  useLoaderData,
  useRouteError,
  useSearchParams,
} from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { useWebComponentClick } from "../hooks/useWebComponentClick";
import {
  PAID_PLAN_NAMES,
  TIER_GROUPS,
  TIER_FEATURES,
  PLAN_NAME_TO_GROUP,
  annualSavings,
  type PaidPlanName,
  type PlanName,
  type TierGroupKey,
} from "../lib/billing/plans";

type Cycle = "monthly" | "annual";
const TIER_KEYS: TierGroupKey[] = ["shield", "pro"];

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const { data: merchant } = await supabase
    .from("merchants")
    .select("tier, billing_cycle, shopify_subscription_id, scans_remaining")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  // Live check against Shopify so the displayed plan reflects reality even if
  // our DB row drifted between webhook and confirm-loader paths.
  let activePlanName: PlanName | null = null;
  let activeSubscriptionId: string | null = null;
  try {
    const check = await billing.check({
      plans: [...PAID_PLAN_NAMES],
      isTest: process.env.NODE_ENV !== "production",
      returnObject: true,
    });
    if (check.hasActivePayment) {
      const sub = check.appSubscriptions?.[0];
      activePlanName = (sub?.name ?? null) as PlanName | null;
      activeSubscriptionId = (sub as any)?.id ?? null;
    }
  } catch {
    // No subscription — leave nulls.
  }

  return {
    tier: (merchant?.tier ?? "free") as string,
    billingCycle: (merchant?.billing_cycle ?? null) as string | null,
    activePlanName,
    activeSubscriptionId,
  };
};

// ─── Action — handles "switch" and "cancel" submissions ──────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const isTest = process.env.NODE_ENV !== "production";

  // Look up active subscription so we can cancel it before any new request.
  let activeSubscriptionId: string | null = null;
  try {
    const check = await billing.check({
      plans: [...PAID_PLAN_NAMES],
      isTest,
      returnObject: true,
    });
    if (check.hasActivePayment) {
      activeSubscriptionId = (check.appSubscriptions?.[0] as any)?.id ?? null;
    }
  } catch {
    // No subscription — nothing to cancel.
  }

  if (intent === "cancel") {
    if (activeSubscriptionId) {
      try {
        await billing.cancel({
          subscriptionId: activeSubscriptionId,
          isTest,
          prorate: true,
        });
      } catch (err) {
        console.error("[plan-switcher] billing.cancel failed:", err);
        return redirect("/app/plan-switcher?error=cancel_failed");
      }
    }

    const { error } = await supabase
      .from("merchants")
      .update({
        tier: "free",
        billing_cycle: null,
        subscription_started_at: null,
        shopify_subscription_id: null,
        scans_remaining: 1,
        scans_reset_at: new Date().toISOString(),
      })
      .eq("shopify_domain", session.shop);

    if (error) {
      console.error("[plan-switcher] Supabase reset to free failed:", error.message);
    }

    return redirect("/app?billing=cancelled");
  }

  if (intent === "switch") {
    const target = form.get("plan");
    if (typeof target !== "string" || !(PAID_PLAN_NAMES as readonly string[]).includes(target)) {
      return redirect("/app/plan-switcher?error=invalid_plan");
    }
    const targetName = target as PaidPlanName;

    if (activeSubscriptionId) {
      try {
        await billing.cancel({
          subscriptionId: activeSubscriptionId,
          isTest,
          prorate: true,
        });
      } catch (err) {
        console.error("[plan-switcher] billing.cancel during switch failed:", err);
        return redirect("/app/plan-switcher?error=switch_failed");
      }
    }

    try {
      await billing.request({
        plan: targetName,
        isTest,
        returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing/confirm`,
      });
    } catch (err) {
      // billing.request() throws a redirect Response on success.
      if (err instanceof Response) throw err;
      console.error("[plan-switcher] billing.request failed:", err);
      return redirect("/app/plan-switcher?error=switch_failed");
    }
  }

  return redirect("/app/plan-switcher");
};

// ─── Component ────────────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  switch_failed:
    "We couldn't switch your plan. Your current subscription is unchanged. Please try again or contact support if the problem persists.",
  cancel_failed:
    "We couldn't cancel your subscription. Your current plan is still active. Please try again or contact support.",
  plan_not_found:
    "That plan doesn't exist. Pick one of the available plans below.",
  invalid_plan:
    "That plan doesn't exist. Pick one of the available plans below.",
};

function errorMessage(key: string | null): string | null {
  if (!key) return null;
  return ERROR_MESSAGES[key] ?? "Something went wrong. Please try again.";
}

export default function PlanSwitcher() {
  const { tier, billingCycle, activePlanName } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const errorMsg = errorMessage(searchParams.get("error"));

  // Default the toggle to the merchant's current cycle if any, else monthly.
  const initialCycle: Cycle = billingCycle === "annual" ? "annual" : "monthly";
  const [cycle, setCycle] = useState<Cycle>(initialCycle);

  return (
    <s-page heading="Manage your plan">
      {errorMsg && (
        <s-banner tone="critical" heading="Action failed">
          {errorMsg}
        </s-banner>
      )}

      {/* ── Current plan summary ─────────────────────────────────────────── */}
      <s-section heading="Current plan">
        <s-paragraph>
          <strong>{activePlanName ?? "Free"}</strong>
          {billingCycle ? ` (${billingCycle})` : ""} — tier: <code>{tier}</code>
        </s-paragraph>
        <s-paragraph>
          {activePlanName
            ? "You can switch plans or cancel at any time below. Shopify will prorate your next charge automatically."
            : "You are on the Free plan. Pick a paid plan below to unlock continuous monitoring, weekly digests, and AI-search visibility."}
        </s-paragraph>
        <CycleToggle cycle={cycle} onChange={setCycle} />
      </s-section>

      {/* ── 2 plan cards ────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "16px",
        }}
      >
        {TIER_KEYS.map((key) => (
          <PlanCard
            key={key}
            groupKey={key}
            cycle={cycle}
            activePlanName={activePlanName}
            hasActivePaid={!!activePlanName}
          />
        ))}
      </div>

      {/* ── Cancel subscription (only if on a paid plan) ─────────────────── */}
      {activePlanName && <CancelSection />}
    </s-page>
  );
}

// ─── Cycle toggle ────────────────────────────────────────────────────────────

function CycleToggle({
  cycle,
  onChange,
}: {
  cycle: Cycle;
  onChange: (next: Cycle) => void;
}) {
  const onMonthly = useCallback(() => onChange("monthly"), [onChange]);
  const onAnnual = useCallback(() => onChange("annual"), [onChange]);
  const monthlyRef = useWebComponentClick<HTMLElement>(onMonthly);
  const annualRef = useWebComponentClick<HTMLElement>(onAnnual);

  return (
    <div
      role="group"
      aria-label="Billing cycle"
      style={{ display: "flex", gap: "8px", marginTop: "12px" }}
    >
      <s-button
        ref={monthlyRef}
        variant={cycle === "monthly" ? "primary" : "secondary"}
      >
        Monthly
      </s-button>
      <s-button
        ref={annualRef}
        variant={cycle === "annual" ? "primary" : "secondary"}
      >
        Annual — save 16%
      </s-button>
    </div>
  );
}

// ─── Cancel section ──────────────────────────────────────────────────────────

function CancelSection() {
  const cancelFetcher = useFetcher();
  const onCancel = useCallback(() => {
    console.log("[plan-switcher] cancel clicked");
    cancelFetcher.submit(
      { intent: "cancel" },
      { method: "post", action: "/app/plan-switcher" },
    );
  }, [cancelFetcher]);
  const cancelRef = useWebComponentClick<HTMLElement>(onCancel);

  return (
    <s-section heading="Cancel subscription">
      <s-paragraph>
        Cancelling returns your account to the Free plan with 1 scan per month.
        Pro features stop immediately. Shopify prorates any unused time on
        your next invoice.
      </s-paragraph>
      <s-button variant="secondary" tone="critical" ref={cancelRef}>
        Cancel subscription
      </s-button>
    </s-section>
  );
}

// ─── Plan card ───────────────────────────────────────────────────────────────

function PlanCard({
  groupKey,
  cycle,
  activePlanName,
  hasActivePaid,
}: {
  groupKey: TierGroupKey;
  cycle: Cycle;
  activePlanName: PlanName | null;
  hasActivePaid: boolean;
}) {
  const group = TIER_GROUPS[groupKey];
  const features = TIER_FEATURES[groupKey];
  const planName = cycle === "annual" ? group.annualName : group.monthlyName;
  const price =
    cycle === "annual"
      ? `$${group.annualPrice}/year`
      : `$${group.monthlyPrice}/month`;
  const savings = cycle === "annual" ? annualSavings(groupKey) : 0;
  const isCurrent = activePlanName === planName;

  // Highlight the merchant's tier even when the toggle is on the other
  // cycle — e.g. they're on Shield Annual but toggled to Monthly: the
  // Shield card still gets a "Your tier" badge so the orientation is clear.
  const isMerchantTier =
    activePlanName !== null && PLAN_NAME_TO_GROUP[activePlanName] === groupKey;

  const switchFetcher = useFetcher();
  const onSwitch = useCallback(() => {
    console.log(`[plan-switcher] switch clicked plan="${planName}"`);
    switchFetcher.submit(
      { intent: "switch", plan: planName },
      { method: "post", action: "/app/plan-switcher" },
    );
  }, [switchFetcher, planName]);
  const switchRef = useWebComponentClick<HTMLElement>(onSwitch);

  return (
    <s-section heading={group.label}>
      <s-paragraph>
        <strong style={{ fontSize: "22px" }}>{price}</strong>
        {savings > 0 && (
          <>
            {" "}
            <s-badge tone="success">Save ${savings}/yr</s-badge>
          </>
        )}
        {isCurrent && (
          <>
            {" "}
            <s-badge tone="success">Current plan</s-badge>
          </>
        )}
        {!isCurrent && isMerchantTier && (
          <>
            {" "}
            <s-badge>Your tier</s-badge>
          </>
        )}
      </s-paragraph>
      <ul style={{ paddingLeft: "20px", margin: "12px 0", lineHeight: 1.6 }}>
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      {!isCurrent && (
        <s-button variant="primary" ref={switchRef}>
          {hasActivePaid ? `Switch to ${planName}` : `Choose ${group.label}`}
        </s-button>
      )}
    </s-section>
  );
}

// ─── Boundaries ───────────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
