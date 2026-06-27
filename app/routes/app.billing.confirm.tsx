/**
 * app/routes/app.billing.confirm.tsx
 * Route: /app/billing/confirm
 *
 * Landing route after Shopify Managed Pricing's hosted approval page. The
 * founder configures this URL as the "Welcome link" in the Partner Dashboard
 * listing UI; Shopify redirects merchants here after they approve (or cancel)
 * a managed-pricing subscription, appending `?charge_id={numeric}`.
 *
 * Path (canonical post-2026-04-28): query the Partner API for the charge's
 * most recent AppSubscriptionEvent, derive tier/cycle from plan name, persist
 * on "active".
 *
 * Status handling:
 *   - active                       → write tier + redirect /app
 *   - cancelled / declined / expired → redirect /app?billing=cancelled
 *   - unknown / pending / frozen / no charge_id → render "confirming…" page
 *                                  with manual Refresh. NEVER redirect to
 *                                  cancelled on uncertainty — that was the
 *                                  pre-fix bug that lost paying merchants.
 *
 * Fail-safe contract: do not demote on uncertainty. If we cannot positively
 * confirm cancellation, keep the merchant on the confirming page so a refresh
 * can resolve it as soon as Shopify's events catch up.
 */

import { redirect, useLoaderData, useNavigate } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  buildAppSubscriptionGid,
  getActiveSubscriptionByChargeId,
} from "../lib/billing/partner-api.server";
import { ensureProductWebhooks } from "../lib/webhooks/product-webhooks.server";
import { sentry } from "../lib/sentry.server";
import { captureEvent } from "../lib/analytics.server";

interface PendingResponse {
  state: "pending";
  reason: string;
  chargeId: string | null;
  shop: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  sentry.addBreadcrumb({
    category: "billing.confirm",
    message: "loader_entered",
    level: "info",
    data: { shop: session.shop },
  });
  console.log(`[billing/confirm] loader entered for shop=${session.shop}`);

  const url = new URL(request.url);
  const chargeIdParam = url.searchParams.get("charge_id");

  // ── No charge_id → confirming page ───────────────────────────────────────
  // Shopify *should* always supply charge_id on the Welcome-link redirect.
  // Missing it means we can't query Partner API; show the pending page so
  // the merchant can refresh once the redirect URL is correctly populated.
  if (!chargeIdParam) {
    sentry.addBreadcrumb({
      category: "billing.confirm",
      message: "partner_api_status=missing_charge_id",
      level: "warning",
      data: { shop: session.shop },
    });
    console.warn(
      `[billing/confirm] no charge_id URL param for ${session.shop}`,
    );
    return pending({
      reason: "missing_charge_id",
      chargeId: null,
      shop: session.shop,
    });
  }

  const chargeGid = buildAppSubscriptionGid(chargeIdParam);

  let sub;
  try {
    sub = await getActiveSubscriptionByChargeId(chargeGid);
  } catch (err) {
    // getActiveSubscriptionByChargeId is documented to never throw, but be
    // defensive — capture & render the pending page rather than crashing.
    sentry.captureException(err, {
      tags: { area: "billing.confirm", branch: "partner_api_threw" },
      extra: { shop: session.shop, chargeId: chargeIdParam },
    });
    console.error(
      `[billing/confirm] partner-api threw for ${session.shop}:`,
      err instanceof Error ? err.message : err,
    );
    return pending({
      reason: "partner_api_error",
      chargeId: chargeIdParam,
      shop: session.shop,
    });
  }

  sentry.addBreadcrumb({
    category: "billing.confirm",
    message: `partner_api_status=${sub.status}`,
    level: sub.status === "active" ? "info" : "warning",
    data: {
      shop: session.shop,
      chargeId: chargeIdParam,
      planName: sub.planName,
      tier: sub.tier,
      cycle: sub.cycle,
      reason: sub.reason ?? null,
    },
  });
  console.log(
    `[billing/confirm] partner-api status=${sub.status} plan="${sub.planName}" tier=${sub.tier} cycle=${sub.cycle} reason=${sub.reason ?? ""}`,
  );

  // ── Active → write tier + redirect dashboard ─────────────────────────────
  if (sub.status === "active" && sub.tier && sub.tier !== "free") {
    const { error } = await supabase
      .from("merchants")
      .update({
        tier: sub.tier,
        billing_cycle: sub.cycle,
        subscription_started_at: sub.activatedAt ?? new Date().toISOString(),
        shopify_subscription_id: sub.subscriptionGid,
        scans_remaining: null,
      })
      .eq("shopify_domain", session.shop);

    if (error) {
      sentry.captureException(error, {
        tags: { area: "billing.confirm", branch: "supabase_update_failed" },
        extra: { shop: session.shop, tier: sub.tier },
      });
      console.error(
        `[billing/confirm] Supabase update FAILED for ${session.shop}: ${error.message}`,
      );
    }

    // Provision the per-shop products/create + products/update subscriptions
    // now that this merchant is paid. products/* is no longer app-level, so
    // this is the moment the enrichment webhooks start flowing. Best-effort:
    // a 1–2s Admin API roundtrip is acceptable on this post-approval path
    // (same tolerance as the inline self-heal), but never block the redirect.
    try {
      const summary = await ensureProductWebhooks(session.shop);
      sentry.addBreadcrumb({
        category: "billing.confirm",
        message: "ensure_product_webhooks",
        level: summary.errors.length ? "warning" : "info",
        data: {
          shop: session.shop,
          created: summary.created,
          existing: summary.existing,
          errors: summary.errors,
        },
      });
    } catch (err) {
      sentry.captureException(err, {
        tags: { area: "billing.confirm", branch: "ensure_product_webhooks" },
        extra: { shop: session.shop },
      });
      console.error(
        `[billing/confirm] ensureProductWebhooks threw for ${session.shop}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Analytics: purchase (funnel exit). Only fired here, on the active/paid
    // branch where the tier is actually written — never on cancelled/pending.
    // captureEvent is self-guarding and never throws, so the redirect to /app
    // is unaffected whether PostHog is configured or down.
    await captureEvent(session.shop, "purchase", {
      tier: sub.tier,
      billing_cycle: sub.cycle,
      shopify_subscription_id: sub.subscriptionGid,
    });

    return redirect("/app");
  }

  // ── Explicit terminal cancellation → cancelled banner ────────────────────
  if (
    sub.status === "cancelled" ||
    sub.status === "declined" ||
    sub.status === "expired"
  ) {
    return redirect("/app?billing=cancelled");
  }

  // ── Anything else (unknown / pending / frozen / active-but-no-tier) ──────
  // Do NOT redirect to cancelled. Show the pending page; let the merchant
  // refresh once events propagate. Frozen is a payment-failure recoverable
  // state, not a cancellation.
  return pending({
    reason: sub.status,
    chargeId: chargeIdParam,
    shop: session.shop,
  });
};

function pending(args: {
  reason: string;
  chargeId: string | null;
  shop: string;
}): PendingResponse {
  return {
    state: "pending",
    reason: args.reason,
    chargeId: args.chargeId,
    shop: args.shop,
  };
}

// ─── Component (only rendered on "pending" loader result) ────────────────────

export default function BillingConfirmPending() {
  const data = useLoaderData<PendingResponse>();
  const navigate = useNavigate();

  // If the loader ever returns a non-pending payload, render nothing —
  // redirect() above prevents that case in practice.
  if (!data || data.state !== "pending") return null;

  return (
    <s-page heading="Confirming your subscription…">
      <s-section>
        <s-card>
          <div style={{ padding: "20px 0", maxWidth: 540 }}>
            <s-paragraph>
              We&rsquo;re confirming your subscription with Shopify. This
              usually takes 30 seconds.
            </s-paragraph>
            <s-paragraph>
              If this page is still here in a minute, click Refresh below.
              We will not downgrade your plan while we&rsquo;re waiting on
              Shopify&rsquo;s confirmation.
            </s-paragraph>

            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => navigate(0)}
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#fff",
                  background: "#0f172a",
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => navigate("/app")}
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#0f172a",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                Back to dashboard
              </button>
            </div>

            <div
              style={{
                marginTop: 16,
                fontSize: 12,
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              Status: {data.reason}
              {data.chargeId ? ` · charge ${data.chargeId}` : ""}
            </div>
          </div>
        </s-card>
      </s-section>
    </s-page>
  );
}
