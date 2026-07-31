/**
 * app/routes/api.cron.reconcile-installs.ts
 *
 * POST /api/cron/reconcile-installs
 *
 * Daily 03:00 UTC. Walks merchants flagged uninstalled_at IS NULL and probes
 * the Shopify Admin API with a cheap `{ shop { id } }` query as a
 * NON-DESTRUCTIVE auth-health check.
 *
 * IMPORTANT (2026-06-26): a probe 401/403 is NOT treated as an uninstall.
 * Offline tokens could self-expire (the `expiringOfflineAccessTokens` future
 * flag, now disabled) and background jobs have no request-time path to refresh
 * them, so a 401 routinely means "our stored token is stale", NOT "the merchant
 * uninstalled". Acting on a 401 here previously soft-deleted the merchant AND
 * deleted the sessions row — destroying the refresh_token that is the only
 * non-reinstall recovery path. That was an irreversible-data-loss landmine
 * across every still-installed merchant whose token had lapsed (42/43 of them).
 *
 * This route therefore NEVER writes uninstalled_at and NEVER deletes sessions.
 * The app/uninstalled webhook (webhooks.app.uninstalled.tsx) is the
 * AUTHORITATIVE uninstaller — that path is a real token revoke. Here we only
 * record a non-destructive `auth_stale` signal (console + Sentry breadcrumb +
 * response counts) for visibility into token health.
 *
 * Bounded for Vercel Hobby's 60s function ceiling: 500ms pacing between
 * merchants, no concurrent fan-out.
 *
 * Auth: bearer CRON_SECRET, same as the other crons.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { createAdminClient } from "../lib/shopify-api.server";
import { sentry } from "../lib/sentry.server";
import { recordCronRun } from "../lib/cron-runs.server";

const PROBE_QUERY = /* GraphQL */ `
  query ShieldKitInstallProbe {
    shop {
      id
    }
  }
`;

const PACE_MS = 500;

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Vercel Cron invokes a scheduled path with **GET**, which React Router routes
// to the loader. This route used to 405 every GET, so the declared Vercel cron
// never executed and the auth-health signal was never produced. Both verbs now
// run the same handler; the bearer CRON_SECRET check inside `run()` is the only
// authorisation gate, so widening the verb does not widen access. This route is
// still strictly NON-DESTRUCTIVE (see the header) — making it actually run does
// not put any merchant row at risk. Fixed 2026-07-28.
export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/reconcile-installs] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  // Everything past the auth gate is one recorded run. A rejected bearer token
  // is NOT a run and is deliberately not logged here — it would turn the table
  // into a scanner-noise log.
  const startedAt = Date.now();
  let summary: Record<string, unknown>;
  let ok = true;
  let status = 200;
  try {
    summary = await probeAllMerchants();
  } catch (err) {
    ok = false;
    status = 500;
    const messageText = err instanceof Error ? err.message : String(err);
    console.error("[cron/reconcile-installs] run failed:", messageText);
    await sentry.captureException(err, {
      tags: { area: "cron.reconcile-installs" },
    });
    summary = { error: "database_error", message: messageText };
  }

  // Recorded on BOTH outcomes, from one place, so "did it run?" is answerable
  // in SQL instead of from a Vercel log window that no longer reaches yesterday.
  await recordCronRun({ job: "reconcile-installs", startedAt, ok, summary });

  return json(summary, status);
}

/**
 * The actual pass. Throws on a database error so `run()` has exactly one
 * failure path to record; every other outcome is a normal summary object.
 */
async function probeAllMerchants(): Promise<Record<string, unknown>> {
  // Pull every merchant still flagged installed. Cheap query — small table.
  const { data: merchants, error: fetchErr } = await supabase
    .from("merchants")
    .select("id, shopify_domain")
    .is("uninstalled_at", null);

  if (fetchErr) {
    throw new Error(`merchant fetch failed: ${fetchErr.message}`);
  }

  if (!merchants || merchants.length === 0) {
    return { checked: 0, still_installed: 0, auth_stale: 0, errors: 0 };
  }

  let stillInstalled = 0;
  let authStale = 0;
  let errors = 0;
  const authStaleDomains: string[] = [];

  for (const m of merchants as Array<{ id: string; shopify_domain: string }>) {
    const outcome = await probeMerchant(m.shopify_domain);

    if (outcome === "installed") {
      stillInstalled += 1;
    } else if (outcome === "auth_stale") {
      // NON-DESTRUCTIVE. A stale/expired or missing offline token is not a
      // reliable uninstall signal — never write uninstalled_at, never delete
      // the sessions row (its refresh_token is the only non-reinstall recovery
      // path). Record for visibility only; the app/uninstalled webhook is the
      // authoritative uninstaller.
      authStale += 1;
      authStaleDomains.push(m.shopify_domain);
      sentry.addBreadcrumb({
        category: "reconcile-installs",
        message: "auth_stale",
        level: "info",
        data: { shop: m.shopify_domain },
      });
      console.warn(
        `[cron/reconcile-installs] auth_stale (non-destructive) for ${m.shopify_domain} — ` +
          "stored offline token rejected; leaving install state untouched.",
      );
    } else {
      errors += 1;
    }

    await sleep(PACE_MS);
  }

  return {
    checked: merchants.length,
    still_installed: stillInstalled,
    auth_stale: authStale,
    errors,
    auth_stale_domains: authStaleDomains,
  };
}

type ProbeOutcome = "installed" | "auth_stale" | "transient_error";

/**
 * Probe a single merchant's Admin API reachability. This is a NON-DESTRUCTIVE
 * health check: a 401/403 or a missing stored token resolves to "auth_stale"
 * (our token can't authenticate) — NOT to "uninstalled". Nothing in this route
 * acts on the outcome destructively. Genuine uninstalls are handled by the
 * app/uninstalled webhook.
 */
async function probeMerchant(shopifyDomain: string): Promise<ProbeOutcome> {
  let executor;
  try {
    executor = await createAdminClient(shopifyDomain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No access token")) {
      // No usable stored token — a lapsed/expired token or a never-completed
      // OAuth. Either way NOT a reliable uninstall signal: non-destructive.
      return "auth_stale";
    }
    // Unknown init error — treat as transient.
    console.warn(
      `[cron/reconcile-installs] createAdminClient threw for ${shopifyDomain}: ${msg}`,
    );
    return "transient_error";
  }

  try {
    const result = await executor<{ shop: { id: string } }>(PROBE_QUERY);
    if (result.data?.shop?.id) {
      return "installed";
    }
    // GraphQL succeeded but no data — anomalous, treat as transient.
    return "transient_error";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The executor throws "HTTP 401 from <shop>" when our stored offline token
    // is rejected. With self-expiring tokens this is usually a STALE token, not
    // an uninstall — so it is non-destructive auth_stale, never an uninstall.
    // See the file header. The app/uninstalled webhook handles real revokes.
    if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
      return "auth_stale";
    }
    // 5xx, timeouts, connection resets — try again tomorrow.
    console.warn(
      `[cron/reconcile-installs] probe failed for ${shopifyDomain}: ${msg}`,
    );
    return "transient_error";
  }
}
