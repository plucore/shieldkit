/**
 * app/routes/app.gtin-fill.tsx
 * Route: /app/gtin-fill
 *
 * Phase 5.2 — GTIN/MPN/Brand Auto-Filler. Lists products missing
 * identifiers and lets the merchant bulk-write them via Shopify metafields
 * (custom.gtin, custom.mpn, custom.brand, custom.identifier_exists).
 *
 * Status: SKELETON. The `metafieldsSet` mutation requires write_products
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
  (process.env.SCOPES ?? "").includes("write_products");

const ENRICHMENT_CANDIDATES_QUERY = `#graphql
  query EnrichmentCandidates($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          vendor
          variants(first: 1) {
            edges { node { sku barcode } }
          }
          metafields(namespace: "custom", first: 10) {
            edges { node { key value } }
          }
        }
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message }
    }
  }
`;

interface MissingIdentifierProduct {
  id: string;
  title: string;
  handle: string;
  hasSku: boolean;
}

interface CandidateProduct {
  id: string; // gid e.g. "gid://shopify/Product/12345"
  title: string;
  vendor: string | null;
  sku: string | null;
  barcode: string | null;
  metafields: Record<string, string>;
}

// Extracts the numeric portion of a Shopify gid for the BIGINT column.
function gidToNumericId(gid: string): string | null {
  const m = gid.match(/\/(\d+)$/);
  return m ? m[1] : null;
}

// Pull up to 500 products with the fields needed to decide what to write.
// Stops early once Shopify reports no further pages.
async function fetchEnrichmentCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminGraphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<any>,
): Promise<CandidateProduct[]> {
  const out: CandidateProduct[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await adminGraphql(ENRICHMENT_CANDIDATES_QUERY, {
      variables: { first: 50, after: cursor },
    });
    const json = await res.json();
    const conn = json?.data?.products;
    if (!conn) break;
    for (const { node } of conn.edges as Array<{ node: {
      id: string; title: string; vendor: string | null;
      variants: { edges: Array<{ node: { sku: string | null; barcode: string | null } }> };
      metafields: { edges: Array<{ node: { key: string; value: string } }> };
    } }>) {
      const v = node.variants.edges[0]?.node;
      const mf: Record<string, string> = {};
      for (const { node: m } of node.metafields.edges) mf[m.key] = m.value;
      out.push({
        id: node.id,
        title: node.title,
        vendor: node.vendor,
        sku: v?.sku ?? null,
        barcode: v?.barcode ?? null,
        metafields: mf,
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
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
  // Once write_products is approved we'll also read the custom.* metafields
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

interface ActionResult {
  ok: boolean;
  error?: string;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ productId: string; message: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const fail = (status: number, error: string) =>
    data<ActionResult>(
      { ok: false, error, processed: 0, succeeded: 0, failed: 0, errors: [] },
      { status },
    );

  // Tier gate
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();
  if (!merchant || merchant.tier !== "pro") return fail(403, "Shield Max only.");

  // Scope gate
  if (!WRITE_METAFIELDS_SCOPE_ENABLED) {
    return fail(
      501,
      "write_products scope is pending Shopify review. The Auto-Filler will activate the moment scope approval lands — no further code changes required.",
    );
  }

  if (intent !== "enrich" && intent !== "mark_no_identifier") {
    return fail(400, "Unknown intent.");
  }

  // Brand fallback: shop.name is the last-resort brand value.
  let shopName = "";
  try {
    const r = await admin.graphql(`#graphql
      query { shop { name } }
    `);
    const j = await r.json();
    shopName = j?.data?.shop?.name ?? "";
  } catch {
    /* shop name fallback only — non-fatal */
  }

  const candidates = await fetchEnrichmentCandidates(admin.graphql);

  // Filter to products this intent actually has work for. Skip anything the
  // merchant has already opted out of via custom.identifier_exists=false.
  const filtered = candidates.filter((p) => {
    if (p.metafields["identifier_exists"] === "false") return false;
    if (intent === "enrich") {
      const wantGtin = !p.metafields["gtin"] && !!p.barcode;
      const wantMpn = !p.metafields["mpn"] && !!p.sku;
      const wantBrand =
        !p.metafields["brand"] &&
        ((p.vendor && p.vendor.length > 0) || shopName.length > 0);
      return wantGtin || wantMpn || wantBrand;
    }
    // mark_no_identifier targets products without any identifier signal
    return !p.barcode && !p.sku;
  });

  // Optional caller-supplied filter — restrict to a subset of product gids.
  const requestedIds = formData.getAll("productId").map(String).filter(Boolean);
  const target =
    requestedIds.length > 0
      ? filtered.filter((p) => requestedIds.includes(p.id))
      : filtered;

  type MetafieldInput = {
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  };

  const BATCH = 25;
  let succeeded = 0;
  let failed = 0;
  const errors: ActionResult["errors"] = [];

  for (let i = 0; i < target.length; i += BATCH) {
    const chunk = target.slice(i, i + BATCH);
    const inputs: MetafieldInput[] = [];
    const writtenByProduct = new Map<string, Record<string, string>>();

    for (const p of chunk) {
      const written: Record<string, string> = {};
      const push = (key: string, type: string, value: string) => {
        inputs.push({ ownerId: p.id, namespace: "custom", key, type, value });
        written[key] = value;
      };
      if (intent === "enrich") {
        if (!p.metafields["gtin"] && p.barcode) {
          push("gtin", "single_line_text_field", p.barcode);
        }
        if (!p.metafields["mpn"] && p.sku) {
          push("mpn", "single_line_text_field", p.sku);
        }
        if (!p.metafields["brand"]) {
          const brand = p.vendor && p.vendor.length > 0 ? p.vendor : shopName;
          if (brand) push("brand", "single_line_text_field", brand);
        }
      } else {
        push("identifier_exists", "boolean", "false");
      }
      writtenByProduct.set(p.id, written);
    }

    if (inputs.length === 0) continue;

    let chunkErrored = false;
    try {
      const res = await admin.graphql(METAFIELDS_SET_MUTATION, {
        variables: { metafields: inputs },
      });
      const json = await res.json();
      const userErrors: Array<{ field: string[] | null; message: string }> =
        json?.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        chunkErrored = true;
        for (const ue of userErrors) {
          // userError.field looks like ["metafields", "<index>", "<field>"]
          const idx = Number(ue.field?.[1]);
          const owner = Number.isFinite(idx)
            ? inputs[idx]?.ownerId ?? "unknown"
            : "unknown";
          errors.push({ productId: owner, message: ue.message });
        }
      }
    } catch (err) {
      chunkErrored = true;
      const msg = err instanceof Error ? err.message : String(err);
      for (const p of chunk) errors.push({ productId: p.id, message: msg });
    }

    if (chunkErrored) {
      failed += chunk.length;
      continue;
    }

    succeeded += chunk.length;

    const rows = chunk
      .map((p) => {
        const numericId = gidToNumericId(p.id);
        const written = writtenByProduct.get(p.id) ?? {};
        const fields = Object.keys(written);
        if (!numericId || fields.length === 0) return null;
        return {
          merchant_id: merchant.id,
          product_id: numericId,
          enriched_fields: fields,
          metafield_values: written,
          enriched_at: new Date().toISOString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      const { error: upsertErr } = await supabase
        .from("schema_enrichments")
        .upsert(rows, { onConflict: "merchant_id,product_id" });
      if (upsertErr) {
        console.error(
          "[gtin-fill] schema_enrichments upsert failed:",
          upsertErr.message,
        );
      }
    }
  }

  const result: ActionResult = {
    ok: failed === 0,
    processed: target.length,
    succeeded,
    failed,
    errors,
  };
  if (failed > 0) {
    result.error = `${failed} product${failed === 1 ? "" : "s"} failed to enrich. See details below.`;
  }
  return data(result);
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
          <s-banner tone="warning" heading="write_products scope pending">
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

      {actionData?.ok && actionData.succeeded > 0 && (
        <s-section>
          <s-banner tone="success" heading="Enrichment complete">
            Wrote metafields for {actionData.succeeded} product
            {actionData.succeeded === 1 ? "" : "s"}.
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
