/**
 * app/routes/api.scan.ts
 *
 * POST /api/scan
 *
 * Authenticated API endpoint that triggers a full 10-check GMC compliance scan
 * for the currently authenticated merchant.
 *
 * Flow:
 *   1. Authenticate via App Bridge session token (authenticate.admin).
 *   2. Look up the merchant record in Supabase.
 *   3. Enforce scan quota — free tier starts with scans_remaining = 1.
 *   4. Run runComplianceScan (all 10 checks, results saved to Supabase).
 *   5. Decrement scans_remaining for quota-limited merchants.
 *   6. Return the complete scan + violations as JSON.
 *
 * ─── REQUIRED DB MIGRATIONS ────────────────────────────────────────────────
 * Run the following in your Supabase SQL editor before using this route:
 *
 *   -- 1. Add quota columns to merchants
 *   ALTER TABLE merchants
 *     ADD COLUMN IF NOT EXISTS scans_remaining INTEGER DEFAULT 1,
 *     ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'free'
 *       CHECK (tier IN ('free', 'pro'));
 *
 *   -- 2. Backfill existing installed merchants with 1 free scan
 *   UPDATE merchants
 *   SET scans_remaining = 1
 *   WHERE scans_remaining IS NULL AND uninstalled_at IS NULL;
 *
 *   -- 3. Allow "error" severity in violations (for checks that throw unexpectedly)
 *   ALTER TABLE violations
 *     DROP CONSTRAINT IF EXISTS violations_severity_check;
 *   ALTER TABLE violations
 *     ADD CONSTRAINT violations_severity_check
 *     CHECK (severity IN ('critical', 'warning', 'info', 'error'));
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import { checkRateLimit, recordScanRequest, RATE_LIMIT_MAX_REQUESTS as RATE_LIMIT_MAX } from "../lib/rate-limiter.server";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Serialises a value to a JSON Response with the given HTTP status code. */
function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — reject non-POST requests gracefully
// ─────────────────────────────────────────────────────────────────────────────

export async function loader(_args: LoaderFunctionArgs) {
  return json({ error: "method_not_allowed", message: "Use POST /api/scan." }, 405);
}

// ─────────────────────────────────────────────────────────────────────────────
// Action — POST /api/scan
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  // Reject non-POST verbs (PUT, DELETE, etc.)
  if (request.method !== "POST") {
    return json(
      { error: "method_not_allowed", message: "Use POST /api/scan." },
      405
    );
  }

  // ── 1. Authenticate ──────────────────────────────────────────────────────────
  // authenticate.admin() validates the App Bridge JWT and throws a redirect if
  // the session is invalid, so we never reach the logic below with a bad token.
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop; // e.g. "mystore.myshopify.com"

  // ── 1b. Rate limiting ────────────────────────────────────────────────────────
  const rateCheck = await checkRateLimit(shopDomain);
  if (!rateCheck.allowed) {
    return json(
      {
        error: "rate_limited",
        message:
          `Too many scan requests. You can make ${RATE_LIMIT_MAX} scan requests per hour. ` +
          `Please try again in ${rateCheck.retryAfterSeconds} seconds.`,
        retry_after_seconds: rateCheck.retryAfterSeconds,
      },
      429
    );
  }

  // ── 2. Look up merchant ──────────────────────────────────────────────────────
  const { data: merchant, error: merchantError } = await supabase
    .from("merchants")
    .select("id, shopify_domain, scans_remaining, tier")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  if (merchantError) {
    console.error(
      `[API/scan] Supabase merchant lookup error for ${shopDomain}:`,
      merchantError.message
    );
    return json(
      {
        error: "internal_error",
        message: "Could not look up your merchant record. Please try again.",
      },
      500
    );
  }

  if (!merchant) {
    return json(
      {
        error: "merchant_not_found",
        message:
          "Merchant record not found. Please reinstall the app to re-authorise.",
      },
      404
    );
  }

  // ── 3. Enforce scan quota (atomic) ────────────────────────────────────────────
  //
  // scans_remaining semantics:
  //   null  → unlimited (paid tier / override — always allow)
  //   0     → exhausted — block and prompt upgrade
  //   n > 0 → allowed   — atomically decrement before running scan
  //
  const scansRemaining: number | null =
    "scans_remaining" in merchant ? (merchant.scans_remaining as number | null) : null;

  let newScansRemaining: number | null = scansRemaining;

  if (scansRemaining !== null) {
    // Atomic decrement — returns the new value, or no rows if already exhausted.
    const { data: rpcResult, error: rpcError } = await supabase
      .rpc("decrement_scan_quota", { p_merchant_id: merchant.id });

    if (rpcError) {
      console.error(
        `[API/scan] decrement_scan_quota RPC error for ${shopDomain}:`,
        rpcError.message
      );
      // Fall back to non-atomic check so we don't block scans if the RPC
      // hasn't been deployed yet.
      if (scansRemaining <= 0) {
        return json(
          {
            error: "scan_limit_reached",
            message:
              "You have used all your available scans on the free tier. " +
              "Upgrade to Pro to run unlimited compliance scans.",
            scans_remaining: 0,
            upgrade_url: "/app/upgrade",
          },
          402
        );
      }
    } else if (!rpcResult || (Array.isArray(rpcResult) && rpcResult.length === 0)) {
      // No rows returned — quota was already 0
      return json(
        {
          error: "scan_limit_reached",
          message:
            "You have used all your available scans on the free tier. " +
            "Upgrade to Pro to run unlimited compliance scans.",
          scans_remaining: 0,
          upgrade_url: "/app/upgrade",
        },
        402
      );
    } else {
      // Atomic decrement succeeded
      newScansRemaining = Array.isArray(rpcResult)
        ? rpcResult[0]?.new_scans_remaining ?? 0
        : 0;
    }
  }

  // ── 4. Run the compliance scan ───────────────────────────────────────────────
  //
  // runComplianceScan wraps every individual check in safeCheck(), so a single
  // check throwing (e.g. storefront timeout) records an "error" result and the
  // scan continues. Only genuinely unrecoverable errors (no access token, Supabase
  // scan INSERT failure) propagate as thrown exceptions.
  let scanResult: Awaited<ReturnType<typeof runComplianceScan>>;

  try {
    scanResult = await runComplianceScan(merchant.id, shopDomain, "manual");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[API/scan] runComplianceScan threw for ${shopDomain}:`, message);

    // Surface specific failure modes as distinct error codes so the UI can
    // render meaningful copy rather than a generic "something went wrong".
    if (message.includes("No access token")) {
      return json(
        {
          error: "token_missing",
          message:
            "The stored access token for your store could not be found. " +
            "Please reinstall the app to re-authorise.",
        },
        401
      );
    }

    if (message.includes("Failed to insert scan record")) {
      return json(
        {
          error: "database_error",
          message:
            "The scan completed but could not be saved. Please try again.",
        },
        500
      );
    }

    return json(
      {
        error: "scan_failed",
        message:
          "The scan could not be completed. Please try again in a few moments.",
        detail: message,
      },
      500
    );
  }

  // ── 5. Record successful scan for rate limiting ──────────────────────────────
  // Quota was already decremented atomically in step 3 (before the scan).
  await recordScanRequest(shopDomain);

  // ── 6. Return complete scan results ──────────────────────────────────────────
  //
  // Derive a human-readable summary of errored checks to surface in the UI
  // without requiring the client to iterate all violations.
  const erroredChecks = scanResult.violations
    .filter((v) => v.severity === "error")
    .map((v) => v.check_name);

  return json({
    success: true,
    scans_remaining: newScansRemaining,
    scan: scanResult.scan,
    violations: scanResult.violations,
    // Convenience fields so the UI doesn't have to re-derive these.
    summary: {
      score: scanResult.scan.compliance_score,
      total_checks: scanResult.scan.total_checks,
      passed_checks: scanResult.scan.passed_checks,
      critical_count: scanResult.scan.critical_count,
      warning_count: scanResult.scan.warning_count,
      info_count: scanResult.scan.info_count,
      errored_checks: erroredChecks,
    },
  });
}
