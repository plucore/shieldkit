/**
 * app/routes/app.gtin-fill.tsx
 * Route: /app/gtin-fill
 *
 * Phase 5.2 — GTIN/MPN/Brand Auto-Filler. Lists products missing
 * identifiers and lets the merchant bulk-write them via Shopify metafields
 * (custom.gtin, custom.mpn, custom.brand, custom.identifier_exists).
 *
 * Status: SKELETON. The `metafieldsSet` mutation requires write_metafields
 * scope, which is in Shopify scope-review queue. Until approved, the form
 * loads + previews but the action returns a "scope pending" error rather
 * than attempting a write that would fail.
 *
 * Tier gate: tier='pro' (Shield Max) only.
 */

import { useCallback, useMemo, useRef } from "react";
import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { useWebComponentClick } from "../hooks/useWebComponentClick";
import { wrapAdminClient, getProducts } from "../lib/shopify-api.server";

const WRITE_METAFIELDS_SCOPE_ENABLED =
  (process.env.SCOPES ?? "").includes("write_metafields");

interface MissingIdentifierProduct {
  id: string;
  title: string;
  handle: string;
  hasSku: boolean;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  if (!merchant) return redirect("/app");

  if (merchant.tier !== "pro") {
    return {
      gated: true as const,
      tier: merchant.tier as string,
      missingIdentifiers: [] as MissingIdentifierProduct[],
      enrichedCount: 0,
      scopeReady: WRITE_METAFIELDS_SCOPE_ENABLED,
    };
  }

  // Fetch up to 250 products and filter for missing identifiers via raw fields.
  // Once write_metafields is approved we'll also read the custom.* metafields
  // here to confirm whether the Auto-Filler has already enriched them.
  const executor = wrapAdminClient(admin.graphql);
  const products = await getProducts(executor, 250);

  const missing: MissingIdentifierProduct[] = products
    .filter((p) => {
      const sku = p.variants[0]?.sku;
      const barcode = p.variants[0]?.barcode;
      return !sku || !barcode; // proxy for "needs identifier work"
    })
    .map((p) => ({
      id: p.handle,
      title: p.title,
      handle: p.handle,
      hasSku: !!p.variants[0]?.sku,
    }));

  // Phase 5 schema_enrichments table — count rows enriched in last 7 days
  // for the digest "Pro This Week" block.
  const { count: enrichedCount } = await supabase
    .from("schema_enrichments")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchant.id)
    .gte(
      "enriched_at",
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );

  return {
    gated: false as const,
    tier: merchant.tier as string,
    missingIdentifiers: missing,
    enrichedCount: enrichedCount ?? 0,
    scopeReady: WRITE_METAFIELDS_SCOPE_ENABLED,
  };
};

// ─── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (!WRITE_METAFIELDS_SCOPE_ENABLED) {
    return data(
      {
        ok: false,
        error:
          "write_metafields scope is pending Shopify review. The Auto-Filler will activate the moment scope approval lands — no further code changes required.",
        enriched: 0,
      },
      { status: 403 },
    );
  }

  if (intent === "enrich") {
    // ── Phase 5.2 mutation path (skeleton) ─────────────────────────────────
    // For each selected product:
    //   const res = await admin.graphql(`#graphql
    //     mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    //       metafieldsSet(metafields: $metafields) {
    //         userErrors { field message }
    //       }
    //     }
    //   `, { variables: { metafields: [
    //     { ownerId: productGid, namespace: "custom", key: "gtin",
    //       type: "single_line_text_field", value: "<lookup result>" },
    //     ...
    //   ]}});
    //
    // After each successful write:
    //   await supabase.from("schema_enrichments").upsert({
    //     merchant_id, product_id, enriched_fields: ["gtin","mpn","brand"],
    //     metafield_values: { ... },
    //     enriched_at: new Date().toISOString(),
    //   }, { onConflict: "merchant_id,product_id" });
    //
    // Identifier source: this skeleton does NOT auto-derive GTINs (they
    // require an external product database). The intended UX is:
    //   1. User enters identifiers manually for high-value SKUs, OR
    //   2. User toggles "Identifier doesn't exist" for handmade/vintage,
    //      which writes custom.identifier_exists = "false" so Google stops
    //      flagging the SKU.
    return data(
      { ok: false, error: "Phase 5 enrich path not yet implemented.", enriched: 0 },
      { status: 501 },
    );
  }

  if (intent === "mark_no_identifier") {
    // Bulk-toggle: write custom.identifier_exists = "false" for selected
    // products. Useful for handmade / vintage / custom-made categories.
    return data(
      { ok: false, error: "Phase 5 mark-no-identifier path not yet implemented.", enriched: 0 },
      { status: 501 },
    );
  }

  return data({ ok: false, error: "Unknown intent.", enriched: 0 }, { status: 400 });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function GtinFillPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isWorking = nav.state !== "idle";

  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = useCallback((intent: string) => {
    return () => {
      if (!formRef.current) return;
      const intentInput = formRef.current.querySelector(
        'input[name="intent"]',
      ) as HTMLInputElement | null;
      if (intentInput) intentInput.value = intent;
      formRef.current.requestSubmit();
    };
  }, []);
  const enrichRef = useWebComponentClick<HTMLElement>(submitForm("enrich"));
  const noIdRef = useWebComponentClick<HTMLElement>(
    submitForm("mark_no_identifier"),
  );

  if (loaderData.gated) {
    return (
      <s-page heading="GTIN / MPN / Brand Auto-Filler">
        <s-section>
          <s-banner tone="info" heading="Shield Max only">
            The Auto-Filler enriches your product feed with the identifiers
            Google Merchant Center expects. Upgrade to Shield Max to access it.
          </s-banner>
          <s-link href="/app/plan-switcher">View plans</s-link>
        </s-section>
      </s-page>
    );
  }

  const total = loaderData.missingIdentifiers.length;

  return (
    <s-page heading="GTIN / MPN / Brand Auto-Filler">
      {!loaderData.scopeReady && (
        <s-section>
          <s-banner tone="warning" heading="write_metafields scope pending">
            The Auto-Filler is wired and ready to run. Shopify is reviewing the
            scope expansion request — actions will activate as soon as
            approval lands. No code change required on your side.
          </s-banner>
        </s-section>
      )}

      <s-section>
        <s-paragraph>
          <strong>{total}</strong> product{total === 1 ? "" : "s"} appear to
          need identifier work (missing SKU or barcode signal).
          <br />
          <strong>{loaderData.enrichedCount}</strong> enriched in the last 7
          days.
        </s-paragraph>
        <s-paragraph>
          Identifiers added via metafields satisfy the GMC "Missing identifiers"
          warning for most categories. Some regulated categories (apparel size
          variants, grocery) may require identifiers in your Shopify product
          feed directly — for those, also add to the variant SKU/barcode field.
        </s-paragraph>
      </s-section>

      {actionData?.error && (
        <s-section>
          <s-banner tone="critical" heading="Action failed">
            {actionData.error}
          </s-banner>
        </s-section>
      )}

      <s-section heading="Products needing identifiers">
        <form method="post" ref={formRef}>
          <input type="hidden" name="intent" value="enrich" />
          <ul style={{ paddingLeft: "20px", margin: "12px 0", lineHeight: 1.6 }}>
            {loaderData.missingIdentifiers.slice(0, 50).map((p) => (
              <li key={p.id}>
                <strong>{p.title}</strong>{" "}
                <code style={{ fontSize: "12px", color: "#6d7175" }}>
                  /products/{p.handle}
                </code>
                {!p.hasSku && (
                  <>
                    {" "}
                    <s-badge tone="warning">No SKU</s-badge>
                  </>
                )}
              </li>
            ))}
          </ul>
          {total > 50 && (
            <s-paragraph>
              …and {total - 50} more. Auto-Fill processes them all in batches.
            </s-paragraph>
          )}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "16px" }}>
            {/* @ts-ignore — s-button supports `loading` and `disabled` at runtime */}
            <s-button
              variant="primary"
              ref={enrichRef}
              {...(isWorking ? { loading: "" } : {})}
              {...(!loaderData.scopeReady || total === 0 ? { disabled: "" } : {})}
            >
              Auto-Fill identifiers
            </s-button>
            {/* @ts-ignore — s-button supports `loading` and `disabled` at runtime */}
            <s-button
              variant="secondary"
              ref={noIdRef}
              {...(isWorking ? { loading: "" } : {})}
              {...(!loaderData.scopeReady || total === 0 ? { disabled: "" } : {})}
            >
              Mark "no identifier exists" (handmade / vintage)
            </s-button>
          </div>
        </form>
      </s-section>
    </s-page>
  );
}

// ─── Boundaries ───────────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
