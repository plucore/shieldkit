/**
 * app/lib/json-ld-verifier.server.ts
 *
 * Confirms whether the ShieldKit JSON-LD theme block is actually rendering
 * on the merchant's storefront. The "enable" click sets clicked_at; this
 * verifier flips json_ld_verified_at + json_ld_enabled only after positive
 * confirmation, retiring the silent-success bug where intent was conflated
 * with state.
 *
 * Verification: fetch the homepage and (if discoverable) a product page,
 * grep for the `shieldkit-jsonld-v1` marker emitted by the Liquid block.
 * Positive when the marker appears AND a Product JSON-LD script tag exists.
 *
 * Failure handling:
 *   - attempts < 5 OR clicked_at younger than 7 days → leave for next retry
 *   - else → reset clicked_at = NULL so the UI re-prompts the merchant
 */

import { fetchPublicPage } from "./checks/helpers.server";
import { supabase } from "../supabase.server";
import { sentry } from "./sentry.server";

const MARKER = "shieldkit-jsonld-v1";
const PRODUCT_LDJSON_RE = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?"@type"\s*:\s*"Product"[\s\S]*?<\/script>/i;
const MAX_ATTEMPTS = 5;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface VerifyResult {
  verified: boolean;
  reason: string;
  pagesChecked: string[];
}

/**
 * Run the verifier for a single merchant. Always returns a structured
 * result; never throws so callers can drive batches without per-item
 * try/catch boilerplate.
 *
 * @param merchantId      Supabase merchants.id (UUID)
 * @param shopifyDomain   {shop}.myshopify.com (used as fallback only)
 * @param primaryDomain   Storefront hostname (e.g. "example.com"). Falls
 *                        back to shopifyDomain if null — both work for the
 *                        verifier but the custom domain matches what real
 *                        crawlers will see.
 */
export async function verifyJsonLdForMerchant(
  merchantId: string,
  shopifyDomain: string,
  primaryDomain: string | null,
): Promise<VerifyResult> {
  const host = primaryDomain && primaryDomain.length > 0
    ? primaryDomain
    : shopifyDomain;
  const homepage = `https://${host}`;

  const pagesChecked: string[] = [homepage];

  // Fetch homepage first — Organization + WebSite blocks (when installed)
  // emit the marker into the <head>. Product block needs a product page.
  const homepageResult = await fetchPublicPage(homepage, 8_000);

  // Try to discover one product URL via the homepage HTML so we exercise the
  // Product block path. Cheap regex over /products/<handle> links; falls
  // back to no product fetch if none found.
  let productHtml: string | null = null;
  const productUrl = homepageResult?.html
    ? extractProductUrl(homepageResult.html, host)
    : null;
  if (productUrl) {
    pagesChecked.push(productUrl);
    const productResult = await fetchPublicPage(productUrl, 8_000);
    productHtml = productResult?.html ?? null;
  }

  const matchedMarker =
    (homepageResult?.html?.includes(MARKER) ?? false) ||
    (productHtml?.includes(MARKER) ?? false);
  const matchedProductSchema =
    (productHtml ? PRODUCT_LDJSON_RE.test(productHtml) : false) ||
    (homepageResult?.html ? PRODUCT_LDJSON_RE.test(homepageResult.html) : false);

  // Positive verification requires both: the marker (proves OUR block is
  // installed, not a third-party schema app) AND a Product JSON-LD script
  // (proves the block actually rendered with content).
  if (matchedMarker && matchedProductSchema) {
    const { error } = await supabase
      .from("merchants")
      .update({
        json_ld_verified_at: new Date().toISOString(),
        json_ld_enabled: true,
      })
      .eq("id", merchantId);

    if (error) {
      sentry.captureException(error, {
        tags: { area: "json-ld-verifier", branch: "supabase_update_failed" },
        extra: { merchantId, shopifyDomain },
      });
    }

    sentry.addBreadcrumb({
      category: "json-ld-verifier",
      message: "verified",
      level: "info",
      data: { merchantId, host, pagesChecked: pagesChecked.length },
    });

    return { verified: true, reason: "marker+product_schema", pagesChecked };
  }

  // Negative — increment attempts and decide whether to give up.
  const reason = !matchedMarker
    ? matchedProductSchema
      ? "product_schema_present_but_no_shieldkit_marker"
      : "no_marker_no_product_schema"
    : "marker_present_but_no_product_schema";

  // Read current attempts + clicked_at so we know if it's time to give up.
  const { data: row } = await supabase
    .from("merchants")
    .select("json_ld_enable_clicked_at, json_ld_verification_attempts")
    .eq("id", merchantId)
    .maybeSingle();

  const attempts = (row?.json_ld_verification_attempts ?? 0) + 1;
  const clickedAt = row?.json_ld_enable_clicked_at
    ? new Date(row.json_ld_enable_clicked_at as string).getTime()
    : Date.now();
  const stale = Date.now() - clickedAt > STALE_AFTER_MS;

  const giveUp = attempts >= MAX_ATTEMPTS || stale;

  const update: Record<string, unknown> = {
    json_ld_verification_attempts: attempts,
  };
  if (giveUp) {
    // Reset clicked_at so the UI re-shows the Enable button. Do NOT touch
    // json_ld_enabled here — if the merchant was previously verified and
    // later regressed (e.g. uninstalled the block), v1 leaves the flag as
    // last-known-positive. Teardown detection is a separate ticket.
    update.json_ld_enable_clicked_at = null;
    update.json_ld_verification_attempts = 0;
  }

  await supabase.from("merchants").update(update).eq("id", merchantId);

  sentry.addBreadcrumb({
    category: "json-ld-verifier",
    message: giveUp ? "gave_up" : "retry_pending",
    level: "warning",
    data: { merchantId, host, attempts, reason, pagesChecked },
  });

  return { verified: false, reason, pagesChecked };
}

/**
 * Extract one product page URL from homepage HTML. Looks for the first
 * /products/<handle> link with no query string, normalises to absolute URL.
 * Returns null when none found (storefront has no products, hidden behind
 * a redirect, etc.).
 */
function extractProductUrl(html: string, host: string): string | null {
  const match = html.match(/href\s*=\s*["']([^"']*\/products\/[a-z0-9][a-z0-9-]*)["']/i);
  if (!match) return null;
  const href = match[1];
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://${host}${href}`;
  return `https://${host}/${href}`;
}
