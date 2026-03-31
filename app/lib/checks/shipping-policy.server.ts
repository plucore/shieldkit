/**
 * CHECK 3 — shipping_policy
 *
 * Verifies the shipping policy exists and contains delivery timeline and
 * shipping cost information — both required by Google Merchant Center.
 */

import type { ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { stripHtml } from "./helpers.server";

export function checkShippingPolicy(policies: ShopPoliciesResult): CheckResult {
  const CHECK_NAME = "shipping_policy";
  const policy = policies.SHIPPING_POLICY;

  if (!policy || !policy.body?.trim()) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Missing Shipping Policy",
      description:
        "No Shipping Policy was found. Google Merchant Center requires a " +
        "shipping policy that details delivery times and costs for all regions " +
        "where products are sold.",
      fix_instruction:
        "1. In Shopify Admin → Settings → Policies, create a Shipping Policy.\n" +
        "2. Include: estimated delivery timeframes (e.g. '3–7 business days'), " +
        "and shipping costs (e.g. 'Free shipping on orders over $50, otherwise $5.99 flat rate').\n" +
        "3. If you ship internationally, add per-region information.\n" +
        "4. Link the policy in your store footer.",
      raw_data: { policy_present: false },
    };
  }

  const text = stripHtml(policy.body);
  const bodyLength = text.length;

  // ── Content quality signals ───────────────────────────────────────────────
  const TIMELINE_RE =
    /\d+\s*(?:to|[-–])\s*\d+\s*(?:business\s+)?days?|\d+\s*(?:business\s+)?days?|within\s+\d+\s*(?:business\s+)?days?|same[\s-]day|next[\s-]day|overnight/i;
  const COST_RE =
    /free\s+shipping|flat[\s-]rate|\$\s*[\d,.]+|calculated\s+at\s+checkout|free\s+on\s+orders|shipping\s+costs?|postage|delivery\s+fee/i;

  const hasTimeline = TIMELINE_RE.test(text);
  const hasCost = COST_RE.test(text);

  const raw_data = {
    policy_present: true,
    policy_url: policy.url,
    body_length: bodyLength,
    has_delivery_timeline: hasTimeline,
    has_shipping_cost_info: hasCost,
  };

  const issues: string[] = [];
  if (!hasTimeline)
    issues.push(
      "no delivery timeline mentioned (e.g. '3–7 business days')"
    );
  if (!hasCost)
    issues.push(
      "no shipping cost information (e.g. 'Free shipping', '$5.99 flat rate', or 'calculated at checkout')"
    );

  if (issues.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Shipping Policy",
      description: "Policy exists and specifies delivery timelines and costs.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Vague Shipping Policy",
    description:
      `Shipping policy exists but is missing important details: ${issues.join("; ")}.`,
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
