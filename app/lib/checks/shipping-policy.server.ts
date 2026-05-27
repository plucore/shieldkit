/**
 * CHECK 3 — shipping_policy
 *
 * Verifies the shipping policy exists and contains delivery timeline and
 * shipping cost information — both required by Google Merchant Center.
 *
 * Detection order:
 *   1. Shopify Settings → Policies → Shipping Policy.
 *   2. Fallback: Shopify Page with handle/title matching /shipping|delivery/i.
 *      If found and content passes regexes, PASS with an info-severity
 *      advisory to move it into Settings → Policies.
 *   3. Neither → fail as before.
 */

import type { Page, ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { findPolicyPage, stripHtml } from "./helpers.server";

const SHIPPING_PAGE_PATTERN = /shipping|delivery/i;

const TIMELINE_RE =
  /\d+\s*(?:to|[-–])\s*\d+\s*(?:business\s+)?days?|\d+\s*(?:business\s+)?days?|within\s+\d+\s*(?:business\s+)?days?|same[\s-]day|next[\s-]day|overnight/i;
const COST_RE =
  /free\s+shipping|flat[\s-]rate|\$\s*[\d,.]+|calculated\s+at\s+checkout|free\s+on\s+orders|shipping\s+costs?|postage|delivery\s+fee/i;

export function checkShippingPolicy(
  policies: ShopPoliciesResult,
  pages: Page[] = [],
): CheckResult {
  const CHECK_NAME = "shipping_policy";
  const policy = policies.SHIPPING_POLICY;

  if (policy && policy.body?.trim()) {
    return evaluateBody({
      checkName: CHECK_NAME,
      body: policy.body,
      source: "policy",
      sourceUrl: policy.url,
    });
  }

  const page = findPolicyPage(pages, SHIPPING_PAGE_PATTERN);
  if (page) {
    const evaluated = evaluateBody({
      checkName: CHECK_NAME,
      body: page.body,
      source: "page",
      sourceUrl: page.url ?? `/pages/${page.handle}`,
      pageHandle: page.handle,
    });
    if (evaluated.passed) return evaluated;
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "critical",
    title: "Missing Shipping Policy",
    description:
      "No Shipping Policy was found in Settings → Policies or as a Shopify " +
      "Page. Google Merchant Center requires a shipping policy that details " +
      "delivery times and costs for all regions where products are sold.",
    fix_instruction:
      "1. In Shopify Admin → Settings → Policies, create a Shipping Policy.\n" +
      "2. Include: estimated delivery timeframes (e.g. '3–7 business days'), " +
      "and shipping costs (e.g. 'Free shipping on orders over $50, otherwise $5.99 flat rate').\n" +
      "3. If you ship internationally, add per-region information.\n" +
      "4. Link the policy in your store footer.",
    raw_data: { policy_present: false, page_fallback_checked: pages.length > 0 },
  };
}

interface EvaluateArgs {
  checkName: string;
  body: string;
  source: "policy" | "page";
  sourceUrl: string;
  pageHandle?: string;
}

function evaluateBody(args: EvaluateArgs): CheckResult {
  const { checkName, body, source, sourceUrl, pageHandle } = args;
  const text = stripHtml(body);
  const bodyLength = text.length;

  const hasTimeline = TIMELINE_RE.test(text);
  const hasCost = COST_RE.test(text);

  const raw_data: Record<string, unknown> = {
    policy_present: true,
    source,
    policy_url: sourceUrl,
    body_length: bodyLength,
    has_delivery_timeline: hasTimeline,
    has_shipping_cost_info: hasCost,
  };
  if (pageHandle) raw_data.page_handle = pageHandle;

  const issues: string[] = [];
  if (!hasTimeline)
    issues.push("no delivery timeline mentioned (e.g. '3–7 business days')");
  if (!hasCost)
    issues.push(
      "no shipping cost information (e.g. 'Free shipping', '$5.99 flat rate', or 'calculated at checkout')",
    );

  if (issues.length === 0) {
    if (source === "page") {
      return {
        check_name: checkName,
        passed: true,
        severity: "info",
        title: "Policy detected on page, not in Settings → Policies",
        description:
          `Your shipping policy was found at /pages/${pageHandle ?? ""} but ` +
          "isn't registered in Settings → Policies. Google Merchant Center " +
          "reviewers and shoppers expect it linked from your legal footer.",
        fix_instruction:
          "In Shopify admin, go to Settings → Policies and paste your " +
          "policy content there. Shopify will auto-link it in your store " +
          "footer.",
        raw_data,
      };
    }
    return {
      check_name: checkName,
      passed: true,
      severity: "info",
      title: "Shipping Policy",
      description: "Policy exists and specifies delivery timelines and costs.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: checkName,
    passed: false,
    severity: "warning",
    title: source === "page"
      ? "Vague Shipping Policy (found on Page)"
      : "Vague Shipping Policy",
    description:
      `Shipping policy ${source === "page" ? `at /pages/${pageHandle ?? ""}` : "exists"} ` +
      `but is missing important details: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Shipping Policy (Shopify Admin → Settings → Policies):\n" +
      "1. Add a clear delivery timeframe per shipping method " +
      "(e.g. 'Standard Shipping: 5–7 business days').\n" +
      "2. State your shipping costs explicitly — even if free " +
      "(e.g. 'Free standard shipping on all orders').\n" +
      "3. For international shipping, list each region's estimated transit times.",
    raw_data,
  };
}
