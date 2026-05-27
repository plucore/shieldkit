import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { sentry } from "../lib/sentry.server";

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
