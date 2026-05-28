/**
 * CHECK 2 — refund_return_policy
 *
 * Verifies the refund policy exists and contains the three required specifics:
 * a return window, item condition requirements, and the accepted refund method.
 * Also flags placeholder text that indicates the policy was not customised.
 *
 * Detection order:
 *   1. Shopify Settings → Policies → Refund Policy (canonical home).
 *   2. Fallback: search the merchant's online-store Pages for a handle/title
 *      matching /refund|return/i. If found and content passes the regexes,
 *      we PASS the check with an `info` advisory pointing the merchant to
 *      move it into Settings → Policies (so it lands in the footer and GMC
 *      reviewers see it).
 *   3. Neither → fail as before.
 */

import type { Page, ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { findPolicyPage, stripHtml } from "./helpers.server";
import {
  RETURN_WINDOW_RE,
  ITEM_CONDITION_RE,
  REFUND_METHOD_RE,
  PLACEHOLDER_RE,
} from "./constants";

const REFUND_PAGE_PATTERN = /refund|return/i;

export function checkRefundPolicy(
  policies: ShopPoliciesResult,
  pages: Page[] = [],
): CheckResult {
  const CHECK_NAME = "refund_return_policy";
  const policy = policies.REFUND_POLICY;

  // ── 1. Canonical source: Settings → Policies ─────────────────────────────
  if (policy && policy.body?.trim()) {
    return evaluateBody({
      checkName: CHECK_NAME,
      body: policy.body,
      source: "policy",
      sourceUrl: policy.url,
    });
  }

  // ── 2. Fallback: Shopify Page that looks like the refund policy ──────────
  const page = findPolicyPage(pages, REFUND_PAGE_PATTERN);
  if (page) {
    const evaluated = evaluateBody({
      checkName: CHECK_NAME,
      body: page.body,
      source: "page",
      sourceUrl: page.url ?? `/pages/${page.handle}`,
      pageHandle: page.handle,
    });
    if (evaluated.passed) return evaluated;
    // If the page content is incomplete, fall through to the missing-policy
    // path so the merchant sees both signals.
  }

  // ── 3. Missing entirely ──────────────────────────────────────────────────
  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "critical",
    title: "Missing Refund & Return Policy",
    description:
      "No Refund/Return Policy was found in Settings → Policies or as a " +
      "Shopify Page. Google Merchant Center requires a clearly visible and " +
      "detailed return policy for all Shopping listings.",
    fix_instruction:
      "1. In Shopify Admin → Settings → Policies, create a Refund Policy.\n" +
      "2. Specify: the return window (e.g. '30 days'), the required item " +
      "condition (e.g. 'unused, in original packaging'), and the refund " +
      "method (e.g. 'full refund', 'store credit', or 'exchange').\n" +
      "3. Save and ensure the policy page is linked in your store footer.",
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

  const hasReturnWindow = RETURN_WINDOW_RE.test(text);
  const hasItemCondition = ITEM_CONDITION_RE.test(text);
  const hasRefundMethod = REFUND_METHOD_RE.test(text);
  const hasPlaceholder = PLACEHOLDER_RE.test(text);

  const raw_data: Record<string, unknown> = {
    policy_present: true,
    source,
    policy_url: sourceUrl,
    body_length: bodyLength,
    has_return_window: hasReturnWindow,
    has_item_condition: hasItemCondition,
    has_refund_method: hasRefundMethod,
    has_placeholder_text: hasPlaceholder,
  };
  if (pageHandle) raw_data.page_handle = pageHandle;

  const issues: string[] = [];
  if (hasPlaceholder)
    issues.push("contains placeholder/template text that must be replaced");
  if (!hasReturnWindow) issues.push("no return window specified (e.g. '30 days')");
  if (!hasItemCondition)
    issues.push("no item condition requirement (e.g. 'unused, original packaging')");
  if (!hasRefundMethod)
    issues.push("no refund method specified (e.g. 'full refund', 'store credit')");

  if (issues.length === 0) {
    // Content quality passes. Severity differs by source so the merchant
    // sees a "move to Settings → Policies" advisory when it's a Page.
    if (source === "page") {
      return {
        check_name: checkName,
        passed: true,
        severity: "info",
        title: "Policy detected on page, not in Settings → Policies",
        description:
          `Your refund/return policy was found at /pages/${pageHandle ?? ""} ` +
          "but isn't registered in Settings → Policies. Google Merchant " +
          "Center reviewers and shoppers expect it linked from your legal " +
          "footer.",
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
      title: "Refund & Return Policy",
      description: "Policy exists and contains all required specifics.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: checkName,
    passed: false,
    severity: "warning",
    title: source === "page"
      ? "Incomplete Refund & Return Policy (found on Page)"
      : "Incomplete Refund & Return Policy",
    description:
      `Refund policy ${source === "page" ? `at /pages/${pageHandle ?? ""}` : "exists"} ` +
      `but is missing key details: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Refund Policy (Shopify Admin → Settings → Policies) to:\n" +
      "1. State the return window clearly (e.g. 'Returns accepted within 30 days of delivery').\n" +
      "2. Specify required item condition (e.g. 'Items must be unused and in original packaging').\n" +
      "3. Describe the refund method (e.g. 'Refunds issued to original payment method within 5 business days').\n" +
      "4. Remove any placeholder text such as '[your company name]' or 'Lorem ipsum'.",
    raw_data,
  };
}
