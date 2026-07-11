/**
 * CHECK 12 — image_hosting_audit
 *
 * Flags products whose `descriptionHtml` embeds images loaded from known
 * marketplace / supplier CDNs. This is an ADVISORY heuristic, not a Google
 * Merchant Center enforcement signal: GMC does not evaluate the CDN host of a
 * description image. What GMC actually checks is the feed's `image_link` (the
 * primary product photo) against its image requirements — no promotional
 * overlays/watermarks, adequate resolution, not generic/placeholder, and a
 * stable crawlable URL. Supplier-hosted images correlate with those problems,
 * so we surface them at WARNING severity to prompt a review, without accusing
 * the merchant of anything.
 *
 * Sample: up to 50 products from the already-fetched product set (the scan
 * fetches at most 50), so supplier-hosted images on products beyond the first 20
 * of a large dropship catalog are no longer silently missed.
 */

import type { Product } from "../graphql-queries.server";
import type { CheckResult } from "./types";

const DROPSHIPPER_HOSTS = [
  "cdn.cjdropshipping.com",
  "ae01.alicdn.com",
  "ae02.alicdn.com",
  "ae03.alicdn.com",
  "ae04.alicdn.com",
  "s.cdpn.io",
  "usercontent.alibaba.com",
  "oss.aliexpress.com",
  "hk.uupingo.com",
  "fp.ps.netease.com",
];

interface FlaggedProduct {
  title: string;
  handle: string;
  matched_hosts: string[];
}

function findDropshipperHosts(html: string): string[] {
  if (!html) return [];
  // Match every src/srcset/data-src URL in the HTML.
  const urlRegex = /(?:src|srcset|data-src)\s*=\s*["']([^"']+)["']/gi;
  const matched = new Set<string>();
  for (const m of html.matchAll(urlRegex)) {
    const url = m[1].toLowerCase();
    for (const host of DROPSHIPPER_HOSTS) {
      if (url.includes(host)) matched.add(host);
    }
  }
  return Array.from(matched);
}

export function checkImageHostingAudit(products: Product[]): CheckResult {
  const CHECK_NAME = "image_hosting_audit";
  const sample = products.slice(0, 50);

  const flagged: FlaggedProduct[] = [];
  for (const p of sample) {
    const matched = findDropshipperHosts(p.descriptionHtml ?? "");
    if (matched.length > 0) {
      flagged.push({
        title: p.title,
        handle: p.handle,
        matched_hosts: matched,
      });
    }
  }

  if (flagged.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Product Image Hosting",
      description:
        sample.length === 0
          ? "No products available to scan."
          : `Scanned ${sample.length} product${sample.length === 1 ? "" : "s"} — no externally-hosted supplier images detected in product descriptions.`,
      fix_instruction: "No action required.",
      raw_data: { sample_size: sample.length, flagged_products: [] },
    };
  }

  const productList = flagged
    .slice(0, 10)
    .map((p) => `${p.title} (/products/${p.handle})`)
    .join(", ");

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Some Product Images Load From Your Supplier's Site",
    description:
      `${flagged.length} of ${sample.length} product${flagged.length === 1 ? "" : "s"} we checked load images from an outside supplier's website instead of your own store. ` +
      `Google checks your main product photo, and supplier images are more likely to have watermarks, promotional text, or low quality — any of which can get a product's image rejected. ` +
      `Worth reviewing: ${productList}${flagged.length > 10 ? "…" : ""}.`,
    fix_instruction:
      "1. Check that each product's main image meets Google's image requirements: a clear, " +
      "unobstructed product photo with no promotional text, watermarks, or added borders; at " +
      "least 100x100px (250x250px for apparel); not a placeholder or generic stock image.\n" +
      "2. Upload your images to the product's media gallery in Shopify Admin → Products so Google " +
      "always loads them from your own store.\n" +
      "3. Replace or remove any supplier images embedded in the product description.\n" +
      "4. After updating, re-run the scan to confirm.",
    raw_data: {
      sample_size: sample.length,
      flagged_count: flagged.length,
      flagged_products: flagged,
      hosts_matched: Array.from(new Set(flagged.flatMap((f) => f.matched_hosts))),
    },
  };
}
