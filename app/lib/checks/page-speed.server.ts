/**
 * CHECK 9 — page_speed
 *
 * Calls the Google PageSpeed Insights API to measure mobile performance.
 * Uses GOOGLE_PAGESPEED_API_KEY if set; falls back to the unauthenticated tier.
 *
 * PageSpeed Insights is an EXTERNAL Google service we don't control. When it
 * times out, rate-limits, or returns no score, that says nothing about the
 * merchant's store — so those outcomes degrade to a calm, non-scorable INFO
 * ("not measured") rather than an alarming error or a warning. Only a
 * SUCCESSFUL response with a real performance score produces a pass/warning
 * that participates in the compliance score.
 */

import type { CheckResult } from "./types";

const CHECK_NAME = "page_speed";

/**
 * Build a "couldn't measure" result: a calm INFO note, passed (not a failure),
 * and scorable:false so a transient external hiccup is excluded from BOTH the
 * numerator and the denominator of the compliance score (never moves it). See
 * compliance-score.ts.
 */
function notMeasured(
  storeUrl: string,
  lead: string,
  extraRaw: Record<string, unknown>,
): CheckResult {
  return {
    check_name: CHECK_NAME,
    passed: true,
    severity: "info",
    scorable: false,
    title: "Page Speed — Not Measured",
    description: `${lead} This doesn't affect your compliance status.`,
    fix_instruction:
      "No action needed on your end. Page speed is measured by Google's " +
      "PageSpeed Insights service — re-run your scan later for a fresh reading, " +
      "or check it any time at https://pagespeed.web.dev.",
    raw_data: { store_url: storeUrl, measured: false, ...extraRaw },
  };
}

export async function checkPageSpeed(storeUrl: string): Promise<CheckResult> {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const apiUrl =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(storeUrl)}&strategy=mobile` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : "");

  try {
    const res = await fetch(apiUrl, {
      signal: AbortSignal.timeout(30_000), // PSI can be slow on first call
    });

    if (!res.ok) {
      // Non-200 (429 quota, 5xx, etc.) — Google's side, not the store's.
      // Log calmly (not "failed") and skip scoring.
      console.info(
        `[Scanner] page_speed not measured — PageSpeed Insights returned HTTP ${res.status}`,
      );
      return notMeasured(
        storeUrl,
        res.status === 429
          ? "Couldn't measure page speed right now — Google's PageSpeed API is rate-limited (HTTP 429)."
          : `Couldn't measure page speed right now — Google's PageSpeed API is temporarily unavailable (HTTP ${res.status}).`,
        { api_status: res.status },
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
      // Successful response but no score (brand-new / private-domain stores).
      // Nothing to measure → skip scoring rather than award a free pass.
      return notMeasured(
        storeUrl,
        "Couldn't measure page speed right now — Google's PageSpeed API didn't return a score for this store yet.",
        { authenticated: !!apiKey },
      );
    }

    const interstitialsAudit =
      psiData.lighthouseResult?.audits?.["intrusive-interstitials"];
    const interstitialsFailed =
      interstitialsAudit !== undefined && (interstitialsAudit.score ?? 1) < 0.9;

    const raw_data = {
      store_url: storeUrl,
      performance_score: performanceScore,
      intrusive_interstitials_failed: interstitialsFailed,
      intrusive_interstitials_display: interstitialsAudit?.displayValue ?? null,
      authenticated: !!apiKey,
      measured: true,
    };

    const issues: string[] = [];
    if (performanceScore < 50)
      issues.push(`mobile performance score is ${performanceScore}/100 (threshold: 50)`);
    if (interstitialsFailed)
      issues.push(
        "a full-screen pop-up appears when your store loads"
      );

    if (issues.length === 0) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "warning",
        title: "Page Speed",
        description: `Mobile performance score: ${performanceScore}/100. No full-screen pop-ups blocking your store on load.`,
        fix_instruction: "No action required.",
        raw_data,
      };
    }

    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Page Speed Issues Detected",
      description: `PageSpeed Insights flagged the following on mobile: ${issues.join("; ")}.`,
      fix_instruction:
        "1. Run a full check at https://pagespeed.web.dev for detailed recommendations.\n" +
        "2. Common mobile fixes: use smaller, compressed images, load images only as they " +
        "scroll into view, trim your theme's code, and remove extra apps that add scripts.\n" +
        "3. Remove or delay full-screen pop-ups that appear the moment your store loads — " +
        "Google lowers your ranking for these.\n" +
        "4. In Shopify Admin → Apps, turn off non-essential apps that slow down loading " +
        "(chat widgets, loyalty pop-ups, etc.).",
      raw_data,
    };
  } catch (err) {
    // Timeout / abort / network error — Google's API was slow or unreachable.
    // This is NOT a store problem, so log calmly and skip scoring entirely
    // instead of surfacing an alarming "check failed".
    const message = err instanceof Error ? err.message : String(err);
    console.info(
      `[Scanner] page_speed not measured — PageSpeed Insights API unavailable (${message})`,
    );
    return notMeasured(
      storeUrl,
      "Couldn't measure page speed right now — Google's PageSpeed API didn't respond in time.",
      { error: message },
    );
  }
}
