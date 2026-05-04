/**
 * app/routes/app.upgrade.tsx
 * Route: /app/upgrade  (picker)
 * Route: /app/upgrade?plan=<PlanName>  (kicks off Shopify billing.request)
 *
 * v2 — recurring billing.
 *
 * Picker UI: 2-card layout (Shield, Shield Pro) with a Monthly | Annual
 * cycle toggle. Default cycle is Monthly. The "Choose" button on each card
 * navigates to /app/upgrade?plan=<concrete plan name> based on the selected
 * cycle, e.g. cycle='annual' on the Shield card → plan="Shield Annual".
 *
 *   - GET /app/upgrade               → renders picker (default monthly)
 *   - GET /app/upgrade?plan=Shield   → loader calls billing.request() and
 *                                      throws a redirect to Shopify's hosted
 *                                      approval page. Return URL points at
 *                                      /app/billing/confirm.
 *   - Already on a paid plan         → forwarded to /app/plan-switcher so they
 *                                      switch instead of double-charging.
 *
 * isTest mirrors NODE_ENV !== 'production' (test charges in dev).
 */

import { useCallback, useState } from "react";
import {
  redirect,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { useWebComponentClick } from "../hooks/useWebComponentClick";
import {
  PAID_PLAN_NAMES,
  TIER_GROUPS,
  TIER_FEATURES,
  annualSavings,
  type PaidPlanName,
  type TierGroupKey,
} from "../lib/billing/plans";

type Cycle = "monthly" | "annual";
const TIER_KEYS: TierGroupKey[] = ["shield", "pro"];

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const planParam = url.searchParams.get("plan");

  const { data: merchant } = await supabase
    .from("merchants")
    .select("tier, billing_cycle")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  // ── A specific paid plan was requested → kick off Shopify billing ───────
  if (planParam) {
    console.log(`[upgrade] loader received plan param="${planParam}" for shop=${session.shop}`);
    if (!(PAID_PLAN_NAMES as readonly string[]).includes(planParam)) {
      console.warn(
        `[upgrade] plan="${planParam}" not in PAID_PLAN_NAMES=${JSON.stringify(PAID_PLAN_NAMES)} — falling through to picker`,
      );
    }
  }
  if (planParam && (PAID_PLAN_NAMES as readonly string[]).includes(planParam)) {
    const plan = planParam as PaidPlanName;

    try {
      const check = await billing.check({
        plans: [...PAID_PLAN_NAMES],
        isTest: process.env.NODE_ENV !== "production",
        returnObject: true,
      });
      console.log(
        `[upgrade] billing.check hasActivePayment=${check.hasActivePayment}`,
        check.hasActivePayment
          ? `activePlan="${check.appSubscriptions?.[0]?.name}"`
          : "",
      );
      if (check.hasActivePayment) {
        const activeName = check.appSubscriptions?.[0]?.name;
        if (activeName === plan) return redirect("/app");
        // Already on a *different* paid plan — must switch, not stack.
        return redirect("/app/plan-switcher?from=upgrade");
      }
    } catch (checkErr) {
      console.warn("[upgrade] billing.check threw (no subscription, expected):", checkErr);
    }

    const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing/confirm`;
    console.log(
      `[upgrade] calling billing.request plan="${plan}" isTest=${process.env.NODE_ENV !== "production"} returnUrl=${returnUrl}`,
    );
    if (!process.env.SHOPIFY_APP_URL) {
      console.error(
        "[upgrade] SHOPIFY_APP_URL is undefined — Shopify will reject the returnUrl. Run via `npm run dev` so the CLI injects the tunnel URL.",
      );
    }
    try {
      await billing.request({
        plan,
        isTest: process.env.NODE_ENV !== "production",
        returnUrl,
      });
      console.error("[upgrade] billing.request returned without throwing redirect — unexpected");
    } catch (err) {
      if (err instanceof Response) {
        console.log(
          `[upgrade] billing.request threw redirect status=${err.status} location=${err.headers.get("location")}`,
        );
        throw err;
      }
      console.error("[upgrade] billing.request() failed:", err);
      return redirect("/app?billing=error");
    }
  }

  // No plan param (or invalid) → render the picker.
  return {
    currentTier: (merchant?.tier ?? "free") as string,
    currentCycle: (merchant?.billing_cycle ?? null) as string | null,
  };
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function UpgradePage() {
  useLoaderData<typeof loader>();
  const [cycle, setCycle] = useState<Cycle>("monthly");

  return (
    <s-page heading="Choose a ShieldKit plan">
      <s-section>
        <s-paragraph>
          Stay compliant with Google Merchant Center and visible in AI search.
          Choose monthly or annual billing — annual saves 16%.
        </s-paragraph>
        <CycleToggle cycle={cycle} onChange={setCycle} />
      </s-section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "16px",
        }}
      >
        {TIER_KEYS.map((key) => (
          <PlanCard key={key} groupKey={key} cycle={cycle} />
        ))}
      </div>

      <s-section>
        <s-paragraph>
          Already subscribed? <s-link href="/app/plan-switcher">Manage your plan</s-link>.
        </s-paragraph>
      </s-section>
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

// ─── Plan card ───────────────────────────────────────────────────────────────

function PlanCard({ groupKey, cycle }: { groupKey: TierGroupKey; cycle: Cycle }) {
  const group = TIER_GROUPS[groupKey];
  const features = TIER_FEATURES[groupKey];
  const planName = cycle === "annual" ? group.annualName : group.monthlyName;
  const price =
    cycle === "annual"
      ? `$${group.annualPrice}/year`
      : `$${group.monthlyPrice}/month`;
  const savings = cycle === "annual" ? annualSavings(groupKey) : 0;

  const navigate = useNavigate();
  const onChoose = useCallback(() => {
    console.log(`[upgrade] PlanCard clicked plan="${planName}"`);
    navigate(`/app/upgrade?plan=${encodeURIComponent(planName)}`);
  }, [navigate, planName]);
  const buttonRef = useWebComponentClick<HTMLElement>(onChoose);

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
      </s-paragraph>
      <ul style={{ paddingLeft: "20px", margin: "12px 0", lineHeight: 1.6 }}>
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <s-button variant="primary" ref={buttonRef}>
        Choose {group.label}
      </s-button>
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
