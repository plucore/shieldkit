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
import { createHash } from "node:crypto";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { identifyCrawler } from "../lib/ai-visibility/identify-crawler.server";

const CACHE: Map<string, { body: string; expires: number }> = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Fire-and-forget: stamp merchants.llms_txt_last_served_at so the weekly
// digest can compute the AI Readiness Score's freshness component.
async function recordLlmsTxtServe(shop: string): Promise<void> {
  try {
    await supabase
      .from("merchants")
      .update({ llms_txt_last_served_at: new Date().toISOString() })
      .eq("shopify_domain", shop);
  } catch (err) {
    console.warn(
      "[proxy/llms-txt] failed to update llms_txt_last_served_at:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Phase 7.2 — privacy-respecting IP hash. We strip the last octet (IPv4)
// or the last 64 bits (IPv6) before hashing so the hash can't be linked
// back to a specific household but still de-dupes within a /24 or /64.
function hashIp(ipRaw: string | null): string | null {
  if (!ipRaw) return null;
  // Take only the first IP if X-Forwarded-For provided a list.
  const ip = ipRaw.split(",")[0].trim();
  let canonical = ip;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) canonical = `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  } else if (ip.includes(":")) {
    const parts = ip.split(":");
    canonical = `${parts.slice(0, 4).join(":")}::`;
  }
  return createHash("sha256").update(canonical).digest("hex");
}

async function logLlmsTxtRequest(opts: {
  shop: string;
  userAgent: string | null;
  ipHash: string | null;
}): Promise<void> {
  try {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id")
      .eq("shopify_domain", opts.shop)
      .maybeSingle();

    await supabase.from("llms_txt_requests").insert({
      shop_domain: opts.shop,
      merchant_id: merchant?.id ?? null,
      user_agent: opts.userAgent,
      crawler_name: identifyCrawler(opts.userAgent),
      ip_hash: opts.ipHash,
    });
  } catch (err) {
    console.warn(
      "[proxy/llms-txt] failed to log crawler hit:",
      err instanceof Error ? err.message : err,
    );
  }
}

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
  const userAgent = request.headers.get("user-agent");
  const forwardedFor =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip");
  const ipHash = hashIp(forwardedFor);

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
    void recordLlmsTxtServe(shop);
    void logLlmsTxtRequest({ shop, userAgent, ipHash });
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
  void recordLlmsTxtServe(shop);
  void logLlmsTxtRequest({ shop, userAgent, ipHash });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-ShieldKit-Cache": "MISS",
    },
  });
}
