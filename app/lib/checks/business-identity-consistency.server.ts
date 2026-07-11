/**
 * CHECK 10 — business_identity_consistency
 *
 * Compares the store display name against its primary domain and About/Contact
 * page content using Jaccard word-set overlap. A score below 0.3 suggests a
 * potential branding mismatch that may flag GMC manual reviews.
 */

import type { ShopInfo, Page } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { stripHtml } from "./helpers.server";
import { STOP_WORDS } from "./constants";

export function checkBusinessIdentityConsistency(
  shopInfo: ShopInfo | null,
  pages: Page[],
  storeUrl: string
): CheckResult {
  const CHECK_NAME = "business_identity_consistency";

  if (!shopInfo) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Business Identity Consistency — Skipped",
      description: "Shop info was unavailable. This check was skipped.",
      fix_instruction: "No action required.",
      raw_data: { skipped: true, reason: "shop_info_unavailable" },
    };
  }

  // ── Normalise text into a bag of meaningful words ──────────────────────────
  const tokenize = (text: string): Set<string> => {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    return new Set(tokens);
  };

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 1 : intersection.size / union.size;
  };

  // ── Build token sets ───────────────────────────────────────────────────────
  const shopNameTokens = tokenize(shopInfo.name);

  // Strip TLD and www, split on hyphens/underscores
  const domainRoot = shopInfo.primaryDomain.host
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[-_]/g, " ");
  const domainTokens = tokenize(domainRoot);

  // Use About/Contact page bodies as corroborating identity evidence
  const aboutPages = pages.filter((p) =>
    /about|contact/i.test(p.title + " " + p.handle)
  );
  const aboutText = aboutPages.map((p) => stripHtml(p.body ?? "")).join(" ");
  const aboutTokens = tokenize(aboutText.slice(0, 2_000)); // cap for perf

  // ── Score: weight domain match (60%) + about page match (40%) ─────────────
  const nameVsDomain = jaccard(shopNameTokens, domainTokens);
  const nameVsAbout = aboutTokens.size > 0 ? jaccard(shopNameTokens, aboutTokens) : null;

  const consistencyScore =
    nameVsAbout !== null
      ? nameVsDomain * 0.6 + nameVsAbout * 0.4
      : nameVsDomain;

  const THRESHOLD = 0.3;
  // If the shop name has no meaningful tokens (purely stop words / symbols), skip
  const passed = consistencyScore >= THRESHOLD || shopNameTokens.size === 0;

  const raw_data = {
    shop_name: shopInfo.name,
    primary_domain: shopInfo.primaryDomain.host,
    shop_name_tokens: [...shopNameTokens],
    domain_tokens: [...domainTokens],
    about_page_tokens_sample: [...aboutTokens].slice(0, 20),
    name_vs_domain_score: Math.round(nameVsDomain * 100) / 100,
    name_vs_about_score: nameVsAbout !== null ? Math.round(nameVsAbout * 100) / 100 : null,
    consistency_score: Math.round(consistencyScore * 100) / 100,
    threshold: THRESHOLD,
    store_url: storeUrl,
  };

  if (passed) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "warning",
      title: "Business Identity Consistency",
      description:
        `Your store name "${shopInfo.name}" closely matches your website ` +
        `address.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "info",
    title: "Potential Business Identity Mismatch",
    description:
      `Your store name ("${shopInfo.name}") and your website address ` +
      `("${shopInfo.primaryDomain.host}") don't closely match. A big mismatch ` +
      `can prompt Google Merchant Center to review your account manually.`,
    fix_instruction:
      "1. Ensure your Shopify store name (Settings → General) matches the brand name " +
      "used on your domain, About page, and social profiles.\n" +
      "2. If you have recently rebranded, update your primary domain in Shopify to match.\n" +
      "3. This is only a heads-up — if your brand name is stylised or shortened, it may not " +
      "match exactly, and that's usually fine.",
    raw_data,
  };
}
