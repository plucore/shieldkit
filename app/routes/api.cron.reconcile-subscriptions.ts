/**
 * app/routes/api.cron.reconcile-subscriptions.ts
 *
 * POST /api/cron/reconcile-subscriptions
 *
 * Triggered by Vercel Cron daily at 04:00 UTC.
 *
 * Why this exists: Post April 28, 2026 the APP_SUBSCRIPTIONS_UPDATE webhook
 * is gone and `billing.check()` no longer returns subscription state for
 * managed-pricing apps. If a merchant cancels their plan via Shopify's
 * hosted billing page and never reopens the embedded app, the dashboard
 * self-heal loader (app._index.tsx) never runs — so the DB keeps showing
 * them as a paid tier and they get paid features for free.
 *
 * This job closes that gap. For every active paid merchant we query the
 * Partner API for the current subscription status. If Shopify says the
 * subscription is in a terminal state (cancelled / expired / frozen /
 * declined) we demote the merchant to free, mirroring exactly what the
 * APP_SUBSCRIPTIONS_UPDATE webhook used to do on the same statuses.
 *
 * CRITICAL FAIL-SAFE: if the Partner API call fails or returns
 * `status: "unknown"` (network error, GraphQL error, no matching events,
 * unrecognised plan name, etc.) we MUST NOT demote. Skip and log. Demoting
 * on uncertainty would yank features from a paying customer because of a
 * transient network blip. Same principle as the dashboard self-heal loader.
 *
 * Scaling note: this currently runs a single-pass loop. Each Partner API
 * call costs ~300ms–1s nominal (up to ~3.5s in the worst-case 3-retry
 * exponential-backoff path). With ~50 paid merchants that's well under
 * Vercel Hobby's 60s function ceiling. When the paid base outgrows what
 * fits in ~50s of Partner API calls (rough ceiling ~80–100 merchants),
 * follow the enqueue/drain pattern from api.cron.weekly-scan.ts +
 * api.cron.process-scan-triggers.ts: enqueue one trigger row per merchant
 * here, drain in a separate route polled by GitHub Actions.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { PAID_TIERS } from "../lib/billing/plans";
import { getActiveSubscriptionByChargeId } from "../lib/billing/partner-api.server";
import {
  ensureProductWebhooks,
  removeProductWebhooks,
} from "../lib/webhooks/product-webhooks.server";
import { sentry } from "../lib/sentry.server";

const TERMINAL_STATUSES = new Set([
  "cancelled",
  "expired",
  "frozen",
  "declined",
]);

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    {
      error: "method_not_allowed",
      message: "Use POST /api/cron/reconcile-subscriptions.",
    },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  // ── 1. Verify CRON_SECRET ───────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron/reconcile-subscriptions] CRON_SECRET env var is not set",
    );
    return json(
      { error: "server_config_error", message: "CRON_SECRET not configured." },
      500,
    );
  }

  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token !== cronSecret) {
    return json(
      { error: "unauthorized", message: "Invalid or missing authorization." },
      401,
    );
  }

  // ── 2. Fetch active paid merchants with a stored subscription gid ───────────
  // No subscription gid → nothing to look up. Free tier rows are excluded by
  // the PAID_TIERS filter.
  const { data: merchants, error: fetchError } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier, shopify_subscription_id")
    .in("tier", PAID_TIERS as readonly string[])
    .is("uninstalled_at", null)
    .not("shopify_subscription_id", "is", null);

  if (fetchError) {
    console.error(
      "[cron/reconcile-subscriptions] Failed to fetch merchants:",
      fetchError.message,
    );
    return json(
      { error: "database_error", message: "Could not fetch merchants." },
      500,
    );
  }

  if (!merchants || merchants.length === 0) {
    return json({ checked: 0, demoted: 0, skipped_unknown: 0 });
  }

  let demoted = 0;
  let skippedUnknown = 0;
  let stillActive = 0;
  const demotedDomains: string[] = [];
  const skippedDomains: string[] = [];

  for (const m of merchants) {
    const subGid = m.shopify_subscription_id as string;
    const sub = await getActiveSubscriptionByChargeId(subGid);

    // FAIL-SAFE: never demote on uncertainty.
    if (sub.status === "unknown") {
      console.warn(
        `[cron/reconcile-subscriptions] skip ${m.shopify_domain} — partner-api status=unknown reason=${sub.reason}`,
      );
      skippedUnknown += 1;
      skippedDomains.push(m.shopify_domain);
      continue;
    }

    if (TERMINAL_STATUSES.has(sub.status)) {
      // Mirror the APP_SUBSCRIPTIONS_UPDATE webhook's terminal-status reset.
      const { error: updateError } = await supabase
        .from("merchants")
        .update({
          tier: "free",
          billing_cycle: null,
          subscription_started_at: null,
          shopify_subscription_id: null,
          scans_remaining: 1,
          scans_reset_at: new Date().toISOString(),
        })
        .eq("id", m.id);

      if (updateError) {
        console.error(
          `[cron/reconcile-subscriptions] failed to demote ${m.shopify_domain}: ${updateError.message}`,
        );
        continue;
      }

      console.log(
        `[cron/reconcile-subscriptions] demoted ${m.shopify_domain} — partner-api status=${sub.status} (was tier=${m.tier})`,
      );

      // Now that they're free, tear down their per-shop products/* webhooks so
      // we stop paying for enrichment deliveries they can no longer use.
      // Best-effort — never let a webhook cleanup failure abort the cron pass.
      try {
        const removal = await removeProductWebhooks(m.shopify_domain);
        if (removal.errors.length) {
          console.warn(
            `[cron/reconcile-subscriptions] removeProductWebhooks errors for ${m.shopify_domain}: ${removal.errors.join("; ")}`,
          );
        }
      } catch (err) {
        sentry.captureException(err, {
          tags: {
            area: "reconcile-subscriptions",
            branch: "remove_product_webhooks",
          },
          extra: { shop: m.shopify_domain },
        });
      }

      demoted += 1;
      demotedDomains.push(m.shopify_domain);
      continue;
    }

    // status === "active" | "pending" — DB and Shopify agree (or merchant
    // is in a pre-approval pending state). Leave the row alone.
    stillActive += 1;

    // Self-heal backstop: re-assert the per-shop products/* subscriptions for
    // confirmed-active paid merchants. Idempotent and cheap (only paid
    // merchants are iterated here), this repairs any subscription that a
    // missed upgrade-path call left unprovisioned, within 24h. Best-effort.
    if (sub.status === "active") {
      try {
        const ensure = await ensureProductWebhooks(m.shopify_domain);
        if (ensure.errors.length) {
          console.warn(
            `[cron/reconcile-subscriptions] ensureProductWebhooks errors for ${m.shopify_domain}: ${ensure.errors.join("; ")}`,
          );
        }
      } catch (err) {
        sentry.captureException(err, {
          tags: {
            area: "reconcile-subscriptions",
            branch: "ensure_product_webhooks",
          },
          extra: { shop: m.shopify_domain },
        });
      }
    }
  }

  return json({
    checked: merchants.length,
    demoted,
    skipped_unknown: skippedUnknown,
    still_active: stillActive,
    demoted_domains: demotedDomains,
    skipped_domains: skippedDomains,
  });
}
