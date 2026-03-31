/**
 * CHECK 2 — refund_return_policy
 *
 * Verifies the refund policy exists and contains the three required specifics:
 * a return window, item condition requirements, and the accepted refund method.
 * Also flags placeholder text that indicates the policy was not customised.
 */

import type { ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { stripHtml } from "./helpers.server";

export function checkRefundPolicy(policies: ShopPoliciesResult): CheckResult {
  const CHECK_NAME = "refund_return_policy";
  const policy = policies.REFUND_POLICY;

  if (!policy || !policy.body?.trim()) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Missing Refund & Return Policy",
      description:
        "No Refund/Return Policy was found. Google Merchant Center requires " +
        "a clearly visible and detailed return policy for all Shopping listings.",
      fix_instruction:
        "1. In Shopify Admin → Settings → Policies, create a Refund Policy.\n" +
        "2. Specify: the return window (e.g. '30 days'), the required item " +
        "condition (e.g. 'unused, in original packaging'), and the refund " +
        "method (e.g. 'full refund', 'store credit', or 'exchange').\n" +
        "3. Save and ensure the policy page is linked in your store footer.",
      raw_data: { policy_present: false },
    };
  }

  const text = stripHtml(policy.body);
  const bodyLength = text.length;

  // ── Content quality signals ───────────────────────────────────────────────
  const RETURN_WINDOW_RE =
    /\d+\s*(?:calendar\s+)?(?:day|week|month|year)s?(?:\s*[-–]\s*\d+\s*(?:day|week|month|year)s?)?/i;
  const ITEM_CONDITION_RE =
    /\b(?:unused|unworn|unwashed|original\s+packaging|original\s+condition|undamaged|unopened|tags\s+attached)\b/i;
  const REFUND_METHOD_RE =
    /\b(?:full\s+refund|refund|exchange|store\s+credit|replacement|credit\s+card)\b/i;
  const PLACEHOLDER_RE =
    /lorem\s+ipsum|\[your\s+(?:company|store|name)\]|\[company\s*name\]|\[insert\b/i;

  const hasReturnWindow = RETURN_WINDOW_RE.test(text);
  const hasItemCondition = ITEM_CONDITION_RE.test(text);
  const hasRefundMethod = REFUND_METHOD_RE.test(text);
  const hasPlaceholder = PLACEHOLDER_RE.test(text);

  const raw_data = {
    policy_present: true,
    policy_url: policy.url,
    body_length: bodyLength,
    has_return_window: hasReturnWindow,
    has_item_condition: hasItemCondition,
    has_refund_method: hasRefundMethod,
    has_placeholder_text: hasPlaceholder,
  };

  const issues: string[] = [];
  if (hasPlaceholder)
    issues.push("contains placeholder/template text that must be replaced");
  if (!hasReturnWindow) issues.push("no return window specified (e.g. '30 days')");
  if (!hasItemCondition)
    issues.push("no item condition requirement (e.g. 'unused, original packaging')");
  if (!hasRefundMethod)
    issues.push("no refund method specified (e.g. 'full refund', 'store credit')");

  if (issues.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Refund & Return Policy",
      description: "Policy exists and contains all required specifics.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Incomplete Refund & Return Policy",
    description:
      `Refund policy exists but is missing key details: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Refund Policy (Shopify Admin → Settings → Policies) to:\n" +
      "1. State the return window clearly (e.g. 'Returns accepted within 30 days of delivery').\n" +
      "2. Specify required item condition (e.g. 'Items must be unused and in original packaging').\n" +
      "3. Describe the refund method (e.g. 'Refunds issued to original payment method within 5 business days').\n" +
      "4. Remove any placeholder text such as '[your company name]' or 'Lorem ipsum'.",
    raw_data,
  };
}
