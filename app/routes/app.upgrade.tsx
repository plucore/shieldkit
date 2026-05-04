/**
 * app/routes/app.upgrade.tsx
 * Route: /app/upgrade  (picker)
 * Route: /app/upgrade?plan=<PlanName>  (kicks off Shopify billing.request)
 *
 * v2 — recurring billing.
 *
 * Behavior:
 *   - GET /app/upgrade               → renders 4-plan picker
 *   - GET /app/upgrade?plan=Shield   → loader calls billing.request() and
 *                                      throws a redirect to Shopify's hosted
 *                                      approval page. Return URL points at
 *                                      /app/billing/confirm.
 *   - Already on a paid plan         → forwarded to /app/plan-switcher so they
 *                                      switch instead of double-charging.
 *
 * isTest mirrors NODE_ENV !== 'production' (test charges in dev).
 */

import { useCallback } from "react";
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
  PLANS,
  PAID_PLAN_NAMES,
  PLAN_FEATURES,
  type PaidPlanName,
  type PaidPlanKey,
} from "../lib/billing/plans";

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
      // billing.request always throws a Response — this line is unreachable.
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

  // No plan param (or invalid) → render the 4-plan picker.
  return {
    mode: "pick" as const,
    currentTier: (merchant?.tier ?? "free") as string,
    currentCycle: (merchant?.billing_cycle ?? null) as string | null,
  };
};

// ─── Component ────────────────────────────────────────────────────────────────

const PAID_KEYS: PaidPlanKey[] = [
  "shield_monthly",
  "shield_annual",
  "pro_monthly",
  "pro_annual",
];

function priceLabel(planKey: PaidPlanKey) {
  const p = PLANS[planKey];
  if ("monthly" in p && (p as any).monthly) return `$${(p as any).monthly}/month`;
  if ("annual" in p && (p as any).annual) return `$${(p as any).annual}/year`;
  return "";
}

export default function UpgradePage() {
  useLoaderData<typeof loader>();

  return (
    <s-page heading="Choose a ShieldKit plan">
      <s-section>
        <s-paragraph>
          Stay compliant with Google Merchant Center and visible in AI search.
          Annual plans save 16%. All paid plans include unlimited scans and
          continuous weekly monitoring.
        </s-paragraph>
      </s-section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "16px",
        }}
      >
        {PAID_KEYS.map((key) => (
          <PlanCard key={key} planKey={key} />
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

function PlanCard({ planKey }: { planKey: PaidPlanKey }) {
  const plan = PLANS[planKey];
  const features = PLAN_FEATURES[planKey];
  const navigate = useNavigate();
  const onChoose = useCallback(() => {
    console.log(`[upgrade] PlanCard clicked plan="${plan.name}"`);
    navigate(`/app/upgrade?plan=${encodeURIComponent(plan.name)}`);
  }, [navigate, plan.name]);
  const buttonRef = useWebComponentClick<HTMLElement>(onChoose);

  return (
    <s-section heading={plan.name}>
      <s-paragraph>
        <strong style={{ fontSize: "20px" }}>{priceLabel(planKey)}</strong>
      </s-paragraph>
      <ul style={{ paddingLeft: "20px", margin: "12px 0", lineHeight: 1.6 }}>
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <s-button variant="primary" ref={buttonRef}>
        Choose {plan.name}
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
