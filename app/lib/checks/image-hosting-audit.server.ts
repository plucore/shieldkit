/**
 * CHECK 12 — image_hosting_audit
 *
 * Flags products whose `descriptionHtml` references images hosted on known
 * dropshipper / supplier CDNs. Direct misrepresentation trigger for GMC —
 * Google considers using supplier-hosted assets a strong signal that the
 * merchant is reselling someone else's product without authorisation.
 *
 * Sample: first 20 products from the already-fetched product set.
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
  const sample = products.slice(0, 20);

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
      title: "Image Hosting Audit",
      description:
        sample.length === 0
          ? "No products available to scan."
          : `Scanned ${sample.length} product${sample.length === 1 ? "" : "s"} — no dropshipper-hosted images detected.`,
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
    severity: "critical",
    title: "Dropshipper-Hosted Images Detected",
    description:
      `${flagged.length} of ${sample.length} sampled product${flagged.length === 1 ? "" : "s"} embed images hosted on supplier/dropshipper CDNs ` +
      `(${Array.from(new Set(flagged.flatMap((f) => f.matched_hosts))).join(", ")}). ` +
      `Google Merchant Center treats this as a misrepresentation signal. Affected: ${productList}${flagged.length > 10 ? "…" : ""}.`,
    fix_instruction:
      "1. Open each affected product in Shopify Admin -> Products.\n" +
      "2. Re-host the product images on Shopify's CDN (cdn.shopify.com) by uploading new copies to the product's image gallery.\n" +
      "3. Edit the product description: replace any image tags pointing at the supplier CDN with the Shopify-hosted versions, or remove the inline images entirely.\n" +
      "4. After saving each product, re-run the scan to confirm.",
    raw_data: {
      sample_size: sample.length,
      flagged_count: flagged.length,
      flagged_products: flagged,
      hosts_matched: Array.from(new Set(flagged.flatMap((f) => f.matched_hosts))),
    },
  };
}
