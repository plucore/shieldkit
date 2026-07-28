import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { sentry } from "../lib/sentry.server";
import { captureEvent } from "../lib/analytics.server";
import { recordInstallEvent } from "../lib/install-events.server";

/**
 * app/uninstalled
 *
 * Always returns 200 to Shopify (the webhook contract demands an ACK; Shopify
 * gives up retries fairly quickly when 2xx is returned). Pre-Fix-4, Supabase
 * write failures were logged-and-forgotten, which is the audit's identified
 * root cause for the ~30% of merchant rows that still showed uninstalled_at
 * IS NULL despite being uninstalled on Shopify.
 *
 * Now: on any Supabase write failure we INSERT a row into webhook_failures
 * (best-effort, wrapped in its own try/catch so even this can't break the
 * webhook ACK). The reconciler cron (api.cron.reconcile-installs.ts) walks
 * still-installed merchants daily and back-fills uninstalled_at when the
 * stored access token has been revoked — that's the durable safety net.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against
  // SHOPIFY_API_SECRET. Throws a 401 Response automatically on HMAC failure.
  const { shop, payload } = await authenticate.webhook(request);

  // Churn analytics. This fires BEFORE the DB writes below for a reason: the
  // merchants row this shop owns is hard-deleted by the GDPR shop/redact
  // webhook 48h from now (webhooks.shop.redact.tsx), taking uninstalled_at and
  // every child row with it. PostHog is therefore the only churn record that
  // outlives the merchant, and it must be captured even if the Supabase writes
  // below fail. Read the tier first (best-effort) so the event can be segmented
  // by plan — a free churn and a paid churn are entirely different events.
  // captureEvent is self-guarding: no-ops when POSTHOG_API_KEY is unset, never
  // throws, and bounds its flush, so it can never break the webhook ACK.
  let churnTier: string | null = null;
  try {
    const { data: tierRow } = await supabase
      .from("merchants")
      .select("tier")
      .eq("shopify_domain", shop)
      .maybeSingle();
    churnTier = (tierRow?.tier as string | undefined) ?? null;
  } catch {
    // Tier lookup is decoration on the event, never a reason to lose it.
  }
  await captureEvent(shop, "uninstall", { tier: churnTier });

  // THE durable churn record. Written BEFORE the DB mutations below for the same
  // reason captureEvent is: in 48h shop/redact hard-deletes the merchants row and
  // cascades away everything else, so this row and the PostHog event are all that
  // will remain. No FK, so the cascade cannot reach it.
  await recordInstallEvent({
    shopDomain: shop,
    eventType: "uninstall",
    tier: churnTier,
  });

  // Delete all OAuth sessions for this shop. Safe to run on duplicate delivery.
  const { error: sessionError } = await supabase
    .from("sessions")
    .delete()
    .eq("shop", shop);

  if (sessionError) {
    console.error(
      `[webhooks.app.uninstalled] Failed to delete sessions for ${shop}:`,
      sessionError.message,
    );
    await recordWebhookFailure({
      shop,
      payload,
      errorMessage: `sessions.delete: ${sessionError.message}`,
    });
  }

  // Soft-delete the merchant — preserves billing history and scan data.
  // GDPR shop/redact webhook (48h later) will hard-delete everything.
  const { error: merchantError } = await supabase
    .from("merchants")
    .update({ uninstalled_at: new Date().toISOString() })
    .eq("shopify_domain", shop);

  if (merchantError) {
    console.error(
      `[webhooks.app.uninstalled] Failed to mark merchant uninstalled for ${shop}:`,
      merchantError.message,
    );
    await recordWebhookFailure({
      shop,
      payload,
      errorMessage: `merchants.update: ${merchantError.message}`,
    });
  }

  // Always return 200 to Shopify regardless of DB outcome — Shopify retries
  // are not the right backstop here, the reconciler is.
  return new Response();
};

/**
 * Insert a webhook_failures row capturing a delivery whose side-effects
 * failed. Best-effort: if THIS insert fails too, we just console.error and
 * return — never throw, never break the webhook ACK upstream.
 */
async function recordWebhookFailure(opts: {
  shop: string;
  payload: unknown;
  errorMessage: string;
}): Promise<void> {
  try {
    await supabase.from("webhook_failures").insert({
      topic: "app/uninstalled",
      shop: opts.shop,
      payload: opts.payload as Record<string, unknown>,
      error_message: opts.errorMessage,
    });
    sentry.addBreadcrumb({
      category: "webhook.failure",
      message: "app/uninstalled supabase write failed",
      level: "error",
      data: { shop: opts.shop, error: opts.errorMessage },
    });
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "webhook.uninstalled", branch: "failure_row_insert_failed" },
      extra: { shop: opts.shop, originalError: opts.errorMessage },
    });
    console.error(
      `[webhooks.app.uninstalled] CRITICAL: failed to record webhook_failures row for ${opts.shop}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
