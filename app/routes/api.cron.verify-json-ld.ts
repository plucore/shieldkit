/**
 * app/routes/api.cron.verify-json-ld.ts
 *
 * POST /api/cron/verify-json-ld
 *
 * Triggered by Vercel Cron every 2 hours. Pulls merchants who clicked the
 * "Enable JSON-LD" button but haven't been verified yet, fetches their
 * storefront, and confirms the theme block is rendering.
 *
 * Bounded work per invocation: BATCH_SIZE merchants per tick, sequential
 * with 1s pacing so we never exceed the Vercel Hobby 60s function ceiling
 * and stay gentle on merchants' storefronts.
 *
 * Auth: bearer CRON_SECRET — matches the other cron endpoints.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { verifyJsonLdForMerchant } from "../lib/json-ld-verifier.server";

const BATCH_SIZE = 30;
const PACE_MS = 1000;

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { error: "method_not_allowed", message: "Use POST /api/cron/verify-json-ld." },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/verify-json-ld] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  // Merchants who clicked Enable, haven't been verified yet, aren't
  // uninstalled, and haven't exhausted the retry budget. Oldest click first
  // so first-time users see the "Active ✓" flip soonest.
  const { data: rows, error } = await supabase
    .from("merchants")
    .select("id, shopify_domain, primary_domain, json_ld_verification_attempts")
    .not("json_ld_enable_clicked_at", "is", null)
    .is("json_ld_verified_at", null)
    .is("uninstalled_at", null)
    .lt("json_ld_verification_attempts", 5)
    .order("json_ld_enable_clicked_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[cron/verify-json-ld] fetch failed:", error.message);
    return json({ error: "database_error", message: error.message }, 500);
  }

  if (!rows || rows.length === 0) {
    return json({ checked: 0, verified: 0 });
  }

  let verified = 0;
  let failed = 0;

  for (const row of rows as Array<{
    id: string;
    shopify_domain: string;
    primary_domain: string | null;
  }>) {
    try {
      const result = await verifyJsonLdForMerchant(
        row.id,
        row.shopify_domain,
        row.primary_domain,
      );
      if (result.verified) verified++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(
        `[cron/verify-json-ld] verifier threw for ${row.shopify_domain}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await sleep(PACE_MS);
  }

  return json({ checked: rows.length, verified, not_verified: failed });
}
