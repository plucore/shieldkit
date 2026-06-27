import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { sentry } from "../lib/sentry.server";

/**
 * GDPR: shop/redact
 *
 * Shopify sends this 48h after uninstall, FROM ITS OWN uninstall record — so it
 * can fire for a shop that has NO merchant row in our DB (never fully installed,
 * already redacted, or a duplicate delivery). The handler must therefore be
 * fully idempotent and must NEVER throw.
 *
 * Why never-throw matters here specifically: Shopify does NOT retry shop/redact
 * on a non-2xx response. Any uncaught exception is a PERMANENT, silent GDPR
 * compliance gap — the merchant's data is never deleted and we never find out.
 * (The pre-fix handler had no exception boundary and emitted nothing to Sentry,
 * which is exactly how 3 merchants stayed un-redacted since May with zero
 * visibility.) A logged 200 is strictly better than a 5xx: the data-delete is
 * still attempted, and a Sentry capture leaves a manual-completion trail.
 *
 * Contract:
 *   - authenticate.webhook (HMAC) stays OUTSIDE the try/catch — a genuinely bad
 *     HMAC must still 401 (same as customers/redact, which has 0% failure).
 *   - Hard-delete the merchant by shop domain directly — no existence lookup,
 *     no .single(). Deleting zero rows is a no-op, not an error. ON DELETE
 *     CASCADE propagates to all child tables.
 *   - Any delete failure (Postgres error OR a client-level rejection) →
 *     Sentry.captureException(shop) → STILL return 200.
 *   - Always return 200 after attempting deletion.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC verification — throws a 401 Response on a bad signature. Intentionally
  // left outside the try/catch below: an unauthenticated request should 401,
  // not be ACKed as a completed redaction.
  const { shop } = await authenticate.webhook(request);

  try {
    // Direct delete by shop domain — no existence assumption. delete().eq() of
    // zero matching rows succeeds with error=null, so this is naturally
    // idempotent across duplicate deliveries and shops we never stored. ON
    // DELETE CASCADE removes every child row (scans→violations,
    // enrichment_webhook_log, schema_enrichments, appeal_letters,
    // llms_txt_requests, pending_scan_triggers, …).
    const { error: merchantError } = await supabase
      .from("merchants")
      .delete()
      .eq("shopify_domain", shop);

    if (merchantError) {
      throw new Error(`merchants.delete: ${merchantError.message}`);
    }

    // Remove any lingering OAuth sessions (keyed by shop, no FK to merchants).
    const { error: sessionError } = await supabase
      .from("sessions")
      .delete()
      .eq("shop", shop);

    if (sessionError) {
      throw new Error(`sessions.delete: ${sessionError.message}`);
    }
  } catch (err) {
    // Shopify does not retry redact on non-2xx, so surfacing a 5xx would be a
    // permanent, silent compliance gap. Capture for a manual-completion trail,
    // then fall through to ACK 200.
    sentry.captureException(err, {
      tags: { area: "webhook.shop_redact", branch: "delete_failed" },
      extra: { shop },
    });
    console.error(
      `[GDPR] shop/redact failed to delete data for ${shop}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Always ACK 200 after attempting deletion.
  return new Response(null, { status: 200 });
};
