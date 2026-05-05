/**
 * app/routes/api.cron.weekly-digest.ts
 *
 * POST /api/cron/weekly-digest
 *
 * Vercel Cron, Mondays 13:00 UTC. For every active paid merchant
 * (tier IN ('shield','pro')) we:
 *   1. Pull the most recent two scans from the last ~14 days.
 *   2. Diff their failed-violations sets to derive new_issues_count
 *      and fixes_confirmed_count.
 *   3. Look up the lead email (leads table — collected at first scan
 *      via getShopInfo).
 *   4. Render the digest HTML and send via Resend.
 *   5. INSERT a digest_emails row capturing the result.
 *
 * Failure isolation: per-merchant try/catch — one bad address won't
 * stop the batch.
 *
 * If RESEND_API_KEY is not set the cron is a no-op (logs and returns
 * { sent: 0, skipped_no_resend_key: <count> }).
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { sendEmail } from "../lib/emails/send.server";
import {
  renderWeeklyDigest,
  digestSubject,
  type IssueChange,
} from "../lib/emails/weekly-digest";
import { createAdminClient, executeWithRetry } from "../lib/shopify-api.server";

// Fallback recipient when leads.email is missing — fetch the shop owner email
// from Shopify Admin GraphQL using the merchant's stored offline session token.
// Returns null on any failure so the caller can record a no-email skip.
async function fetchShopOwnerEmail(shopifyDomain: string): Promise<string | null> {
  try {
    const executor = await createAdminClient(shopifyDomain);
    const result = await executeWithRetry<{ shop: { email: string | null } }>(
      executor,
      "shopOwnerEmailFallback",
      `#graphql
        query { shop { email } }
      `,
    );
    const email = result.data?.shop?.email;
    return email && email.length > 0 ? email : null;
  } catch (err) {
    console.warn(
      `[cron/weekly-digest] shop-owner email fallback failed for ${shopifyDomain}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface MerchantRow {
  id: string;
  shopify_domain: string;
  shop_name: string | null;
  tier: string;
  llms_txt_last_served_at: string | null;
  pro_settings: { bot_preferences?: Record<string, unknown> } | null;
}

interface ScanRow {
  id: string;
  compliance_score: number | null;
  created_at: string;
}

interface ViolationRow {
  check_name: string;
  passed: boolean;
  title: string | null;
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { error: "method_not_allowed", message: "Use POST /api/cron/weekly-digest." },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/weekly-digest] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  // ── 2. RESEND_API_KEY guard — no-op if missing ─────────────────────────────
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "[cron/weekly-digest] RESEND_API_KEY is not set — skipping all sends.",
    );
    return json({ sent: 0, skipped_no_resend_key: true });
  }

  const appUrl = process.env.SHOPIFY_APP_URL ?? "https://shieldkit.vercel.app";

  // ── 3. Fetch active paid merchants ─────────────────────────────────────────
  const { data: merchants, error: merchantsErr } = await supabase
    .from("merchants")
    .select("id, shopify_domain, shop_name, tier, llms_txt_last_served_at, pro_settings")
    .in("tier", ["shield", "pro"])
    .is("uninstalled_at", null);

  if (merchantsErr) {
    console.error("[cron/weekly-digest] merchant fetch failed:", merchantsErr.message);
    return json({ error: "database_error", message: merchantsErr.message }, 500);
  }

  if (!merchants || merchants.length === 0) {
    return json({ sent: 0 });
  }

  let sent = 0;
  let failed = 0;
  let skippedNoEmail = 0;
  let skippedNoScans = 0;

  for (const merchant of merchants as MerchantRow[]) {
    try {
      // 3a. Pull two most-recent scans for diffing.
      const { data: scans } = await supabase
        .from("scans")
        .select("id, compliance_score, created_at")
        .eq("merchant_id", merchant.id)
        .order("created_at", { ascending: false })
        .limit(2);

      const scansList = (scans ?? []) as ScanRow[];
      if (scansList.length === 0) {
        skippedNoScans++;
        continue;
      }
      const latest = scansList[0];
      const previous = scansList[1] ?? null;

      // 3b. Pull violations for both scans.
      const scanIds = previous ? [latest.id, previous.id] : [latest.id];
      const { data: violations } = await supabase
        .from("violations")
        .select("scan_id, check_name, passed, title")
        .in("scan_id", scanIds);

      const violationsByScan: Record<string, ViolationRow[]> = {};
      for (const row of (violations ?? []) as Array<
        ViolationRow & { scan_id: string }
      >) {
        if (!violationsByScan[row.scan_id]) violationsByScan[row.scan_id] = [];
        violationsByScan[row.scan_id].push({
          check_name: row.check_name,
          passed: row.passed,
          title: row.title,
        });
      }

      // 3c. Diff.
      const latestRows = violationsByScan[latest.id] ?? [];
      const previousRows = previous ? violationsByScan[previous.id] ?? [] : [];

      const latestFailed = new Map<string, ViolationRow>();
      latestRows.filter((v) => !v.passed).forEach((v) => latestFailed.set(v.check_name, v));
      const latestPassed = new Set(
        latestRows.filter((v) => v.passed).map((v) => v.check_name),
      );
      const previousFailed = new Set(
        previousRows.filter((v) => !v.passed).map((v) => v.check_name),
      );
      const previousPassed = new Set(
        previousRows.filter((v) => v.passed).map((v) => v.check_name),
      );

      const newIssues: IssueChange[] = [];
      for (const [name, v] of latestFailed) {
        if (previousPassed.has(name)) {
          newIssues.push({ check_name: name, title: v.title ?? name });
        }
      }
      const fixesConfirmed: IssueChange[] = [];
      for (const v of latestRows) {
        if (v.passed && previousFailed.has(v.check_name)) {
          fixesConfirmed.push({ check_name: v.check_name, title: v.title ?? v.check_name });
        }
      }

      // 3d. Payment icon health derived from check 6 result.
      const checkout = latestRows.find((v) => v.check_name === "checkout_transparency");
      const paymentIconHealthy = checkout?.passed === true;

      // 3e. Recipient email — leads table first (captured on first scan),
      //     then fall back to Shopify shop-owner email via Admin GraphQL.
      const { data: lead } = await supabase
        .from("leads")
        .select("email")
        .eq("shop_domain", merchant.shopify_domain)
        .maybeSingle();

      let to = lead?.email ?? null;
      let recipientSource: "lead" | "shopify_owner" = "lead";
      if (!to) {
        const ownerEmail = await fetchShopOwnerEmail(merchant.shopify_domain);
        if (ownerEmail) {
          to = ownerEmail;
          recipientSource = "shopify_owner";
        }
      }

      if (!to) {
        skippedNoEmail++;
        // Still record an audit row so we know we tried.
        await supabase.from("digest_emails").insert({
          merchant_id: merchant.id,
          scan_id: latest.id,
          new_issues_count: newIssues.length,
          fixes_confirmed_count: fixesConfirmed.length,
          email_provider_id: "FAILED:no_email_on_file",
        });
        continue;
      }

      // 3f. Compose Shield Max ("Pro This Week") block when applicable.
      const tierKey: "shield" | "pro" = merchant.tier === "pro" ? "pro" : "shield";
      let proThisWeek: Parameters<typeof renderWeeklyDigest>[0]["proThisWeek"];
      if (tierKey === "pro") {
        const sevenDaysAgo = new Date(
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const [{ count: enrichedCount }, { count: totalEnrichedCount }] =
          await Promise.all([
            supabase
              .from("schema_enrichments")
              .select("id", { count: "exact", head: true })
              .eq("merchant_id", merchant.id)
              .gte("enriched_at", sevenDaysAgo),
            supabase
              .from("schema_enrichments")
              .select("id", { count: "exact", head: true })
              .eq("merchant_id", merchant.id),
          ]);

        // Total products is approximated via the latest scan's
        // product_data_quality raw_data — when available. When not,
        // default to enriched count so the percentage shows progress
        // rather than 0/0.
        const productDataQuality = latestRows.find(
          (v) => v.check_name === "product_data_quality",
        );
        const totalProducts =
          (productDataQuality as any)?.raw_data?.total_products ??
          totalEnrichedCount ??
          0;

        // AI Readiness Score: simple weighted aggregate, 0-100.
        //   - 60% schema coverage (productsWithFullSchema / totalProducts)
        //   - 30% llms.txt freshness (binary: refreshed in last 30d → full points)
        //   - 10% bot configuration completeness (Phase 5 will read merchant.pro_settings.bot_preferences)
        const schemaShare =
          totalProducts > 0
            ? Math.min(1, (totalEnrichedCount ?? 0) / totalProducts)
            : 0;
        const llmsTxtRefreshedAt: string | null = merchant.llms_txt_last_served_at;
        const llmsFreshShare =
          llmsTxtRefreshedAt &&
          Date.now() - new Date(llmsTxtRefreshedAt).getTime() <=
            7 * 24 * 60 * 60 * 1000
            ? 1
            : 0;
        const botPrefs = merchant.pro_settings?.bot_preferences;
        const botConfigShare = botPrefs
          ? Object.values(botPrefs).filter((v) => v === true).length / 11
          : 0;
        const aiReadinessScore = Math.round(
          schemaShare * 60 + llmsFreshShare * 30 + botConfigShare * 10,
        );

        proThisWeek = {
          productsEnrichedCount: enrichedCount ?? 0,
          productsWithFullSchema: totalEnrichedCount ?? 0,
          totalProducts,
          llmsTxtRefreshedAt,
          aiReadinessScore,
        };
      }

      const html = renderWeeklyDigest({
        shopName: merchant.shop_name ?? merchant.shopify_domain,
        shopDomain: merchant.shopify_domain,
        appUrl,
        tier: tierKey,
        scoreThisWeek: latest.compliance_score,
        scorePreviousWeek: previous?.compliance_score ?? null,
        newIssues,
        fixesConfirmed,
        paymentIconHealthy,
        customerPrivacyApiWired: null, // Phase 5
        proThisWeek,
      });

      const result = await sendEmail({
        to,
        subject: digestSubject(merchant.shop_name ?? merchant.shopify_domain),
        html,
      });

      // Tag the audit row with the recipient source when fallback was used,
      // so we can spot shops still missing a captured lead.
      const sourceTag = recipientSource === "shopify_owner" ? "|src=shopify_owner" : "";
      const providerId = result.ok
        ? `${result.messageId ?? "OK:no_id"}${sourceTag}`
        : `FAILED:${(result.error ?? "unknown").slice(0, 64)}${sourceTag}`;

      await supabase.from("digest_emails").insert({
        merchant_id: merchant.id,
        scan_id: latest.id,
        new_issues_count: newIssues.length,
        fixes_confirmed_count: fixesConfirmed.length,
        email_provider_id: providerId,
      });

      if (result.ok) sent++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(
        `[cron/weekly-digest] merchant ${merchant.shopify_domain} failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    // gentle pacing for Resend
    await sleep(150);
  }

  return json({ sent, failed, skipped_no_email: skippedNoEmail, skipped_no_scans: skippedNoScans });
}
