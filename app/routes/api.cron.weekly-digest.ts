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
    .select("id, shopify_domain, shop_name, tier")
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

      // 3e. Recipient email from leads table (collected at first scan).
      const { data: lead } = await supabase
        .from("leads")
        .select("email")
        .eq("shop_domain", merchant.shopify_domain)
        .maybeSingle();

      const to = lead?.email;
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

      // 3f. Render + send.
      const tierKey: "shield" | "pro" = merchant.tier === "pro" ? "pro" : "shield";
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
      });

      const result = await sendEmail({
        to,
        subject: digestSubject(merchant.shop_name ?? merchant.shopify_domain),
        html,
      });

      const providerId = result.ok
        ? result.messageId ?? "OK:no_id"
        : `FAILED:${(result.error ?? "unknown").slice(0, 64)}`;

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
