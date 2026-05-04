/**
 * app/routes/api.cron.monthly-reset.ts
 *
 * POST /api/cron/monthly-reset
 *
 * Vercel Cron: 1st of month at 00:00 UTC. Resets scans_remaining=1 for any
 * free-tier merchant whose last reset is older than 30 days. Uninstalled
 * merchants are excluded.
 *
 * Auth: bearer token CRON_SECRET (matches existing weekly-scan cron pattern).
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { error: "method_not_allowed", message: "Use POST /api/cron/monthly-reset." },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/monthly-reset] CRON_SECRET env var is not set");
    return json(
      { error: "server_config_error", message: "CRON_SECRET not configured." },
      500,
    );
  }

  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json(
      { error: "unauthorized", message: "Invalid or missing authorization." },
      401,
    );
  }

  // Reset free-tier merchants whose last reset is > 30 days ago.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("merchants")
    .update({ scans_remaining: 1, scans_reset_at: nowIso })
    .eq("tier", "free")
    .is("uninstalled_at", null)
    .lt("scans_reset_at", cutoff)
    .select("id");

  if (error) {
    console.error("[cron/monthly-reset] Update failed:", error.message);
    return json(
      { error: "database_error", message: error.message },
      500,
    );
  }

  const resetCount = data?.length ?? 0;
  console.log(
    `[cron/monthly-reset] Reset ${resetCount} free-tier merchant(s) at ${nowIso}`,
  );

  return json({ reset_count: resetCount });
}
