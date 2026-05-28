/**
 * app/lib/policy-validator.server.ts
 *
 * Self-consistency validator for AI-generated store policies (v4 §5).
 *
 * After the policy-generator returns a policy body, we re-run the SAME
 * regex signals the compliance scanner uses for that policy type. If the
 * generated body would fail the scan it's about to need to pass, surface
 * that to the caller so it can:
 *   1. Retry the generation once with an appended instruction listing
 *      the missing signals (handled in the generatePolicy action), or
 *   2. Save it anyway with a soft warning so the merchant can decide.
 *
 * The regexes are imported from checks/constants.ts so the validator
 * and the scanner can't drift apart.
 */

import {
  RETURN_WINDOW_RE,
  ITEM_CONDITION_RE,
  REFUND_METHOD_RE,
  TIMELINE_RE,
  COST_RE,
  PLACEHOLDER_RE,
} from "./checks/constants";
import { stripHtml } from "./checks/helpers.server";
import type { PolicyType } from "./policy-generator.server";

export interface PolicyValidationResult {
  valid: boolean;
  /**
   * Human-readable labels for content signals the body is missing OR
   * disallowed signals it triggered (e.g. placeholder text). Empty when
   * `valid === true`.
   */
  missing: string[];
}

/**
 * Run the same content-signal checks the compliance scanner runs for the
 * given policy type. Returns `{ valid: true, missing: [] }` when the body
 * would pass; otherwise lists the missing signals.
 */
export function validateGeneratedPolicy(
  policyType: PolicyType,
  htmlBody: string,
): PolicyValidationResult {
  const text = stripHtml(htmlBody ?? "");
  if (!text.trim()) {
    return { valid: false, missing: ["body is empty"] };
  }

  const missing: string[] = [];

  switch (policyType) {
    case "refund": {
      if (!RETURN_WINDOW_RE.test(text)) missing.push("return window");
      if (!ITEM_CONDITION_RE.test(text)) missing.push("item condition");
      if (!REFUND_METHOD_RE.test(text)) missing.push("refund method");
      if (PLACEHOLDER_RE.test(text)) missing.push("placeholder text detected");
      break;
    }
    case "shipping": {
      if (!TIMELINE_RE.test(text)) missing.push("delivery timeline");
      if (!COST_RE.test(text)) missing.push("shipping cost");
      break;
    }
    case "privacy":
    case "terms": {
      // Compliance scan for privacy/terms only requires non-blank body,
      // so the validator mirrors that — we already checked emptiness up
      // top. The placeholder detector adds a guard: a model that emits
      // "[Your Company Name]" is not consistent with a real policy.
      if (PLACEHOLDER_RE.test(text)) missing.push("placeholder text detected");
      break;
    }
  }

  return { valid: missing.length === 0, missing };
}
