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
 *
 * Why apiKey is a parameter (and not read from process.env here): this
 * helper is imported by client-side code in app/routes/app._index.tsx.
 * Vite does not expose process.env to the browser, so reading the env
 * inside this module would throw at runtime on the dashboard. Callers
 * read SHOPIFY_API_KEY in a server-side loader and pass it through
 * useLoaderData. The throw on missing apiKey keeps the failure loud at
 * the call site rather than silently emitting a broken activateAppId.
 */

export type JsonLdBlock =
  | "product-schema"
  | "organization-schema"
  | "website-schema";

export function getJsonLdThemeEditorUrl(
  shopDomain: string,
  block: JsonLdBlock,
  apiKey: string | null | undefined,
): string {
  if (!apiKey) {
    throw new Error(
      "apiKey is required for theme editor deep links. " +
        "Pass the Shopify app client_id from a server-side loader; the " +
        "browser cannot read server env vars directly.",
    );
  }
  return `https://${shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/${block}`;
}
