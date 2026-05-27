/**
 * app/lib/json-ld-deep-link.ts
 *
 * Single source of truth for the Shopify theme editor deep link that
 * activates a ShieldKit JSON-LD theme block.
 *
 * Pre-fix the URL was hard-coded twice in app/routes/app._index.tsx,
 * including the literal app client_id `071fc51ee1ef7f358cdaed5f95922498`
 * (also embedded once in the wizard step after Fix 5). Any client_id
 * rotation would silently break activation in one place but not another.
 *
 * The block parameter accepts the three Liquid block handles defined in
 * extensions/json-ld-schema/blocks/ — only `product-schema` is wired into
 * the UI today; the others are accepted so future "Enable Organization"
 * or "Enable WebSite" CTAs can reuse this helper.
 */

export type JsonLdBlock =
  | "product-schema"
  | "organization-schema"
  | "website-schema";

export function getJsonLdThemeEditorUrl(
  shopDomain: string,
  block: JsonLdBlock = "product-schema",
): string {
  // SHOPIFY_API_KEY is set in the runtime env (Vercel) and mirrors the
  // client_id from shopify.app.toml. We use it as the source rather than
  // hard-coding the client_id so a future rotation is one env-var change.
  const clientId = process.env.SHOPIFY_API_KEY;
  if (!clientId) {
    throw new Error(
      "SHOPIFY_API_KEY is required for theme editor deep links. " +
        "Set it in Vercel env (mirrors client_id from shopify.app.toml).",
    );
  }
  return `https://${shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${clientId}/${block}`;
}
