/**
 * CHECK 9 — page_speed
 *
 * Calls the Google PageSpeed Insights API to measure mobile performance.
 * Uses GOOGLE_PAGESPEED_API_KEY if set; falls back to the unauthenticated tier.
 * Skips gracefully (info pass) if the API cannot be reached.
 */

import type { CheckResult } from "./types";

export async function checkPageSpeed(storeUrl: string): Promise<CheckResult> {
  const CHECK_NAME = "page_speed";

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
      // Log a specific message for 429 (quota exhausted) so it's easy to spot in logs.
      console.warn(
        res.status === 429
          ? `[Scanner] PageSpeed API throttled (HTTP 429) — defaulting performance score to 50`
          : `[Scanner] PageSpeed API returned HTTP ${res.status} — defaulting performance score to 50`
      );
      // Return a neutral result with score 50 (at the passing threshold) so the
      // overall scan is never blocked by transient API quota or availability issues.
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed — API Unavailable",
        description:
          res.status === 429
            ? "PageSpeed Insights API rate-limited this request (HTTP 429). Performance score defaulted to 50/100 so the scan could complete."
            : `PageSpeed Insights API returned HTTP ${res.status}. Performance score defaulted to 50/100 so the scan could complete.`,
        fix_instruction:
          "Set GOOGLE_PAGESPEED_API_KEY in your environment to increase quota and avoid throttling.",
        raw_data: { store_url: storeUrl, api_status: res.status, performance_score: 50, skipped: false },
      };
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
    };

    if (performanceScore === null) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed — No Score Returned",
        description:
          "Google PageSpeed Insights did not return a performance score for this store.",
        fix_instruction:
          "This can occur for brand-new or private-domain stores. Run the scan again after publishing.",
        raw_data,
      };
    }

    const issues: string[] = [];
    if (performanceScore < 50)
      issues.push(`mobile performance score is ${performanceScore}/100 (threshold: 50)`);
    if (interstitialsFailed)
      issues.push(
        `intrusive interstitials detected (${interstitialsAudit?.displayValue ?? "failed"})`
      );

    if (issues.length === 0) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed",
        description: `Mobile performance score: ${performanceScore}/100. No intrusive interstitials detected.`,
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
        "1. Run a full audit at https://pagespeed.web.dev for detailed recommendations.\n" +
        "2. Common mobile improvements: compress images (WebP format), enable lazy loading, " +
        "minify CSS/JS, and reduce third-party scripts.\n" +
        "3. For intrusive interstitials: remove or delay full-screen pop-ups that appear " +
        "immediately on page load — Google penalises these in Shopping rankings.\n" +
        "4. In Shopify Admin → Apps, disable non-essential apps that inject scripts at load " +
        "time (chat widgets, loyalty pop-ups, etc.).",
      raw_data,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Scanner] PageSpeed check failed: ${message}`);
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Page Speed — Check Skipped",
      description:
        "PageSpeed Insights could not be reached. This check was skipped to avoid blocking the scan.",
      fix_instruction:
        "Ensure the server has outbound internet access and a valid GOOGLE_PAGESPEED_API_KEY is set.",
      raw_data: { store_url: storeUrl, error: message, skipped: true },
    };
  }
}
