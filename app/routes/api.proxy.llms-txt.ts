/**
 * app/routes/api.proxy.llms-txt.ts
 *
 * Phase 4.2 — App Proxy endpoint serving llms.txt for Shield Max merchants.
 * Configured in shopify.app.toml as /apps/llms-txt → this URL.
 *
 * Shopify's React Router authenticate.public.appProxy(request) verifies the
 * HMAC signature on the request before we get here; if the signature is
 * invalid the call throws a 401 Response.
 *
 * Output: text/plain llms.txt body. Cached per-shop in-memory for 24h. The
 * cache is per-process so cold-starts re-generate; that's fine for an
 * endpoint that fetches fresh shop data anyway.
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

const CACHE: Map<string, { body: string; expires: number }> = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ShopFields {
  name: string;
  description: string | null;
  primary_domain: { url: string };
  email: string | null;
}

interface PolicyFields {
  shopPolicies: Array<{ type: string; url: string | null }>;
}

interface ProductsConn {
  products: { nodes: Array<{ title: string; onlineStoreUrl: string | null }> };
}

const QUERY = `#graphql
  query LlmsTxt {
    shop {
      name
      description
      email
      primaryDomain { url }
      shopPolicies { type url }
    }
    products(first: 50) {
      nodes { title onlineStoreUrl }
    }
  }
`;

function buildLlmsTxt(
  shop: ShopFields & PolicyFields,
  products: ProductsConn["products"]["nodes"],
): string {
  const baseUrl = shop.primary_domain.url.replace(/\/$/, "");

  const lines: string[] = [];
  lines.push(`# ${shop.name}`);
  if (shop.description) {
    lines.push(`> ${shop.description.replace(/\s+/g, " ").trim()}`);
  }
  lines.push("");

  const publishedProducts = products.filter((p) => !!p.onlineStoreUrl);
  if (publishedProducts.length > 0) {
    lines.push("## Products");
    for (const p of publishedProducts) {
      lines.push(`- [${p.title}](${p.onlineStoreUrl})`);
    }
    lines.push("");
  }

  const policyUrls = shop.shopPolicies.filter((p) => !!p.url);
  if (policyUrls.length > 0) {
    lines.push("## Policies");
    const policyLabels: Record<string, string> = {
      REFUND_POLICY: "Refund Policy",
      PRIVACY_POLICY: "Privacy Policy",
      TERMS_OF_SERVICE: "Terms of Service",
      SHIPPING_POLICY: "Shipping Policy",
      CONTACT_INFORMATION: "Contact",
      LEGAL_NOTICE: "Legal Notice",
      SUBSCRIPTION_POLICY: "Subscription Policy",
    };
    for (const p of policyUrls) {
      const label = policyLabels[p.type] ?? p.type;
      lines.push(`- [${label}](${p.url})`);
    }
    lines.push("");
  }

  if (shop.email) {
    lines.push("## Contact");
    lines.push(`- ${shop.email}`);
    lines.push("");
  }

  lines.push("## Site");
  lines.push(`- Homepage: ${baseUrl}`);
  lines.push("");

  return lines.join("\n");
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Verify HMAC + parse query params via Shopify's helper.
  const { session, admin } = await authenticate.public.appProxy(request);

  if (!session || !admin) {
    return new Response("Forbidden\n", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const shop = session.shop;

  // ── Tier gate: Shield Max only ─────────────────────────────────────────────
  const { data: merchant } = await supabase
    .from("merchants")
    .select("tier")
    .eq("shopify_domain", shop)
    .maybeSingle();

  if (merchant?.tier !== "pro") {
    return new Response(
      "# llms.txt is a Shield Max feature\n\n" +
        "This store is not currently subscribed to ShieldKit Shield Max.\n",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // ── Cache ──────────────────────────────────────────────────────────────────
  const cached = CACHE.get(shop);
  if (cached && cached.expires > Date.now()) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "X-ShieldKit-Cache": "HIT",
      },
    });
  }

  // ── Fetch fresh data ───────────────────────────────────────────────────────
  let body: string;
  try {
    const res = await admin.graphql(QUERY);
    const json = (await res.json()) as {
      data?: {
        shop: ShopFields & PolicyFields;
        products: ProductsConn["products"];
      };
      errors?: unknown;
    };
    if (!json.data) {
      console.error("[proxy/llms-txt] GraphQL returned no data:", json.errors);
      return new Response("# Temporarily unavailable\n", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    body = buildLlmsTxt(json.data.shop, json.data.products.nodes);
  } catch (err) {
    console.error("[proxy/llms-txt] generation failed:", err);
    return new Response("# Temporarily unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  CACHE.set(shop, { body, expires: Date.now() + CACHE_TTL_MS });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-ShieldKit-Cache": "MISS",
    },
  });
}
