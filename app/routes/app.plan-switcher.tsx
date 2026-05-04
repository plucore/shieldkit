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
 * Switch flow:
 *   1. Cancel current Shopify subscription via billing.cancel()
 *   2. Re-create the new one via billing.request() (throws redirect to approval)
 *   Shopify handles proration on the new charge automatically.
 *
 * Cancel flow:
 *   1. billing.cancel() the current subscription
 *   2. UPDATE merchants set tier='free', scans_remaining=1, scans_reset_at=now(),
 *      and clear all paid-plan billing fields.
 *
 * pro_legacy merchants: they have no Shopify subscription to cancel and the
 * tier is grandfathered. We show a read-only banner and forward upgrade links
 * to /app/upgrade (which itself shows the legacy banner).
 */

import { useCallback } from "react";
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
  PLANS,
  PAID_PLAN_NAMES,
  PLAN_FEATURES,
  planKeyByName,
  type PaidPlanKey,
  type PaidPlanName,
  type PlanKey,
  type PlanName,
} from "../lib/billing/plans";

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
    isLegacy: merchant?.tier === "pro_legacy",
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

const PAID_KEYS: PaidPlanKey[] = [
  "shield_monthly",
  "shield_annual",
  "pro_monthly",
  "pro_annual",
];

function priceLabel(planKey: PlanKey) {
  const p: any = PLANS[planKey];
  if (p.monthly) return `$${p.monthly}/month`;
  if (p.annual) return `$${p.annual}/year`;
  return "Free";
}

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
  const { tier, billingCycle, activePlanName, isLegacy } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const errorMsg = errorMessage(searchParams.get("error"));

  const currentKey = activePlanName ? planKeyByName(activePlanName) : null;

  // ── Legacy grandfather case ─────────────────────────────────────────────
  if (isLegacy) {
    return (
      <s-page heading="Your plan">
        <s-section>
          <s-banner tone="success">
            You're on a perpetual Pro plan — every Pro feature, no recurring charge.
            There's nothing to switch or cancel here.
          </s-banner>
        </s-section>
        <s-section heading="What's coming next">
          <s-paragraph>
            Beacon, our sister app for AI search visibility, launches soon. You'll
            get early access. We'll email when it's ready.
          </s-paragraph>
          <s-link href="/app">Return to dashboard</s-link>
        </s-section>
      </s-page>
    );
  }

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
      </s-section>

      {/* ── 4 plan cards (mobile-friendly: auto-fit grid down to 260px) ──── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "16px",
        }}
      >
        {PAID_KEYS.map((key) => (
          <PlanCard
            key={key}
            planKey={key}
            isCurrent={currentKey === key}
            hasActivePaid={!!activePlanName}
          />
        ))}
      </div>

      {/* ── Cancel subscription (only if on a paid plan) ─────────────────── */}
      {activePlanName && <CancelSection />}
    </s-page>
  );
}

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

function PlanCard({
  planKey,
  isCurrent,
  hasActivePaid,
}: {
  planKey: PaidPlanKey;
  isCurrent: boolean;
  hasActivePaid: boolean;
}) {
  const plan = PLANS[planKey];
  const features = PLAN_FEATURES[planKey];
  const switchFetcher = useFetcher();
  const onSwitch = useCallback(() => {
    console.log(`[plan-switcher] switch clicked plan="${plan.name}"`);
    switchFetcher.submit(
      { intent: "switch", plan: plan.name },
      { method: "post", action: "/app/plan-switcher" },
    );
  }, [switchFetcher, plan.name]);
  const switchRef = useWebComponentClick<HTMLElement>(onSwitch);

  return (
    <s-section heading={plan.name}>
      <s-paragraph>
        <strong style={{ fontSize: "20px" }}>{priceLabel(planKey)}</strong>
        {isCurrent && (
          <>
            {" "}
            <s-badge tone="success">Current plan</s-badge>
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
          {hasActivePaid ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
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
