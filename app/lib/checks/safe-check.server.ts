/**
 * app/lib/checks/safe-check.server.ts
 *
 * The safeCheck wrapper ensures a single check throwing never aborts the scan.
 */

import type { CheckResult } from "./types";

/**
 * Executes a single check function and catches any unexpected thrown errors.
 *
 * If the check throws (e.g. a network timeout or uncaught exception), this
 * returns a well-formed CheckResult with severity "error" instead of
 * propagating the error up and aborting the entire scan.
 *
 * Normal check failures (policy missing, score too low, etc.) are returned
 * as CheckResult objects with passed=false — they never throw, so this only
 * fires for genuinely unexpected runtime errors.
 */
export async function safeCheck(
  checkName: string,
  fn: () => CheckResult | Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Scanner] Check "${checkName}" threw unexpectedly: ${message}`);
    return {
      check_name: checkName,
      passed: false,
      severity: "error",
      title: checkName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: "Could not complete this check — please try again.",
      fix_instruction:
        "Re-run the scan. If the issue persists, check your network connectivity " +
        "and ensure the store is accessible, then contact support.",
      raw_data: { error: message },
    };
  }
}
