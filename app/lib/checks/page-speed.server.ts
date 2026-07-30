/**
 * CHECK 9 — page_speed  (ADVISORY, PERMANENTLY NON-SCORABLE)
 *
 * ── WHY THIS NO LONGER RUNS INLINE (2026-07-30) ─────────────────────────────
 *
 * PageSpeed Insights is an external Google service that runs a full Lighthouse
 * audit on demand. Inside a 60s Vercel Hobby function, behind a 30s abort, it
 * did not answer for roughly two thirds of scans: of 26 recorded attempts, 17
 * were non-measurements and 16 of those 17 were timeouts. Zero were 429s, and
 * the API key IS set in production (every success records
 * `authenticated: true`), so it was never a quota or credential problem.
 *
 * Cache-warming was considered and REFUTED by production data: sex-eshop timed
 * out twice 11 SECONDS apart, and 7wf1na-x2 timed out five times at 2-4 minute
 * intervals. Success is a property of the STORE, not of a warm cache — 8 of 13
 * shops measure on the first try and 5 never measure at all. A heavy storefront
 * simply exceeds 30s every time, so no amount of pre-warming helps.
 *
 * So the measurement moved off the scan's invocation entirely:
 *   1. the scan returns `pendingPageSpeed()` immediately, no network call;
 *   2. it enqueues a `pending_scan_triggers` row (trigger_type 'page_speed');
 *   3. api.cron.measure-page-speed calls PSI on its OWN 60s invocation and
 *      patches the violation row via `measurePageSpeed()`.
 *
 * ── WHY IT IS PERMANENTLY NON-SCORABLE ──────────────────────────────────────
 *
 * Page speed is not a Google Merchant Center suspension criterion, so it has no
 * business moving a score that claims to predict suspension. Making it
 * permanently non-scorable is also what makes the deferred patch SAFE: the
 * denominator is 11 whether or not PSI ever answers, so a result arriving after
 * the merchant has already seen their score cannot change that score. There is
 * no recompute path because there is nothing to recompute.
 *
 * ── KNOWN CONSEQUENCE: INTRUSIVE INTERSTITIALS ARE NOW ADVISORY TOO ─────────
 *
 * This check bundles two signals, and they are NOT separable: the interstitial
 * verdict comes from `lighthouseResult.audits["intrusive-interstitials"]`
 * INSIDE the same PSI response. This module receives only a URL — it has no
 * access to the homepage HTML the scan already fetched — and no HTML-based
 * interstitial detector exists anywhere in the codebase. Splitting would mean
 * writing a new detector from scratch, which given this project's
 * false-positive history is its own piece of work, not a refactor.
 *
 * So intrusive interstitials, which ARE a Google policy matter, no longer
 * affect the score. That is a real (accepted) trade-off. The clean fix is an
 * HTML-based interstitial detector in checks/shared/html-detectors.server.ts,
 * which would be fast, reliable, and independently scorable — tracked as
 * follow-up, deliberately not bolted on here.
 */

import type { CheckResult } from "./types";

export const PAGE_SPEED_CHECK_NAME = "page_speed";

/** Trigger type used to queue the deferred measurement. */
export const PAGE_SPEED_TRIGGER = "page_speed";

/** Default PSI budget for the background job. Bounded well inside the 60s ceiling. */
export const PAGE_SPEED_TIMEOUT_MS = 45_000;

/**
 * Build a non-scorable INFO result. `scorable: false` excludes it from BOTH the
 * numerator and denominator of the compliance score (see compliance-score.ts),
 * which is what makes the deferred patch score-neutral.
 */
function advisory(
  storeUrl: string,
  title: string,
  description: string,
  fix_instruction: string,
  raw_data: Record<string, unknown>,
  passed = true,
): CheckResult {
  return {
    check_name: PAGE_SPEED_CHECK_NAME,
    passed,
    severity: "info",
    scorable: false,
    title,
    description,
    fix_instruction,
    raw_data: { store_url: storeUrl, ...raw_data },
  };
}

/**
 * The row the SCAN writes. No network call, so it costs the scan nothing and
 * cannot time it out. Replaced in place by measurePageSpeed() shortly after.
 */
export function pendingPageSpeed(storeUrl: string): CheckResult {
  return advisory(
    storeUrl,
    "Page Speed — Checking in the Background",
    "We're measuring your mobile page speed with Google's PageSpeed Insights. " +
      "It takes a minute or two and doesn't affect your compliance status — " +
      "re-open this page shortly to see the result.",
    "No action needed. This finishes on its own.",
    { measured: false, pending: true },
  );
}

/**
 * Run the real PSI measurement. Called ONLY from the background cron, where a
 * long wait is free. Returns a CheckResult ready to overwrite the pending row.
 */
export async function measurePageSpeed(
  storeUrl: string,
  timeoutMs: number = PAGE_SPEED_TIMEOUT_MS,
): Promise<CheckResult> {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const apiUrl =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(storeUrl)}&strategy=mobile` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : "");

  // Recorded on EVERY outcome, success or timeout. Without it there is no way
  // to tell "the budget is too small" from "PSI is down", which is exactly the
  // question the 30s inline version could never answer.
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(timeoutMs) });

    if (!res.ok) {
      console.info(
        `[page-speed] not measured — PageSpeed Insights returned HTTP ${res.status} after ${elapsed()}ms`,
      );
      return advisory(
        storeUrl,
        "Page Speed — Not Measured",
        res.status === 429
          ? "Couldn't measure page speed right now — Google's PageSpeed API is rate-limited (HTTP 429). This doesn't affect your compliance status."
          : `Couldn't measure page speed right now — Google's PageSpeed API is temporarily unavailable (HTTP ${res.status}). This doesn't affect your compliance status.`,
        "No action needed on your end. Re-run your scan later for a fresh reading, " +
          "or check any time at https://pagespeed.web.dev.",
        { measured: false, api_status: res.status, elapsed_ms: elapsed() },
      );
    }

    const psiData = (await res.json()) as {
      lighthouseResult?: {
        categories?: { performance?: { score?: number } };
        audits?: {
          "intrusive-interstitials"?: { score?: number | null; displayValue?: string };
        };
      };
    };

    const rawScore = psiData.lighthouseResult?.categories?.performance?.score ?? null;
    const performanceScore = rawScore !== null ? Math.round(rawScore * 100) : null;

    if (performanceScore === null) {
      return advisory(
        storeUrl,
        "Page Speed — Not Measured",
        "Couldn't measure page speed right now — Google's PageSpeed API didn't " +
          "return a score for this store yet. This doesn't affect your compliance status.",
        "No action needed on your end. Re-run your scan later for a fresh reading.",
        { measured: false, authenticated: !!apiKey, elapsed_ms: elapsed() },
      );
    }

    const interstitialsAudit =
      psiData.lighthouseResult?.audits?.["intrusive-interstitials"];
    const interstitialsFailed =
      interstitialsAudit !== undefined && (interstitialsAudit.score ?? 1) < 0.9;

    const raw_data = {
      performance_score: performanceScore,
      intrusive_interstitials_failed: interstitialsFailed,
      intrusive_interstitials_display: interstitialsAudit?.displayValue ?? null,
      authenticated: !!apiKey,
      measured: true,
      elapsed_ms: elapsed(),
    };

    const issues: string[] = [];
    if (performanceScore < 50)
      issues.push(`mobile performance score is ${performanceScore}/100 (threshold: 50)`);
    if (interstitialsFailed)
      issues.push("a full-screen pop-up appears when your store loads");

    if (issues.length === 0) {
      return advisory(
        storeUrl,
        "Page Speed",
        `Mobile performance score: ${performanceScore}/100. No full-screen pop-ups blocking your store on load.`,
        "No action required.",
        raw_data,
      );
    }

    // passed:false so the merchant SEES the finding in the checklist. Still
    // non-scorable — advisory, never a compliance failure.
    return advisory(
      storeUrl,
      "Page Speed Issues Detected",
      `PageSpeed Insights flagged the following on mobile: ${issues.join("; ")}. ` +
        `This is advisory and doesn't affect your compliance status.`,
      "1. Run a full check at https://pagespeed.web.dev for detailed recommendations.\n" +
        "2. Common mobile fixes: use smaller, compressed images, load images only as they " +
        "scroll into view, trim your theme's code, and remove extra apps that add scripts.\n" +
        "3. Remove or delay full-screen pop-ups that appear the moment your store loads — " +
        "Google lowers your ranking for these.\n" +
        "4. In Shopify Admin → Apps, turn off non-essential apps that slow down loading " +
        "(chat widgets, loyalty pop-ups, etc.).",
      raw_data,
      false,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.info(
      `[page-speed] not measured — PSI unavailable after ${elapsed()}ms (${message})`,
    );
    return advisory(
      storeUrl,
      "Page Speed — Not Measured",
      "Couldn't measure page speed right now — Google's PageSpeed API didn't " +
        "respond in time. This doesn't affect your compliance status.",
      "No action needed on your end. Re-run your scan later for a fresh reading, " +
        "or check any time at https://pagespeed.web.dev.",
      { measured: false, error: message, elapsed_ms: elapsed() },
    );
  }
}
