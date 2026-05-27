/**
 * app/routes/api.cron.reconcile-installs.ts
 *
 * POST /api/cron/reconcile-installs
 *
 * Daily 03:00 UTC. Walks merchants flagged uninstalled_at IS NULL and probes
 * Shopify Admin API with a cheap `{ shop { id } }` query. Token revocation
 * (401 from Shopify, or "No access token" from createAdminClient) means the
 * merchant has uninstalled — we back-fill uninstalled_at and delete sessions
 * to match.
 *
 * This is the durable safety net for app/uninstalled webhook deliveries that
 * fail their Supabase writes (the audit-identified root cause of the ~30%
 * ghost-merchant rate). The webhook itself now also records a webhook_failures
 * row on side-effect failures (Fix 4), but this reconciler closes the loop
 * for any failure mode — including webhooks Shopify never delivered at all.
 *
 * Bounded for Vercel Hobby's 60s function ceiling: 500ms pacing between
 * merchants, no concurrent fan-out. Scales to ~80 merchants per tick which
 * comfortably exceeds today's paid base; when it doesn't, mirror the
 * weekly-scan enqueue/drain split.
 *
 * Auth: bearer CRON_SECRET, same as the other crons.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { createAdminClient } from "../lib/shopify-api.server";
import { sentry } from "../lib/sentry.server";

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

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    {
      error: "method_not_allowed",
      message: "Use POST /api/cron/reconcile-installs.",
    },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

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

  // Pull every merchant still flagged installed. Cheap query — small table.
  const { data: merchants, error: fetchErr } = await supabase
    .from("merchants")
    .select("id, shopify_domain")
    .is("uninstalled_at", null);

  if (fetchErr) {
    console.error(
      "[cron/reconcile-installs] merchant fetch failed:",
      fetchErr.message,
    );
    return json(
      { error: "database_error", message: fetchErr.message },
      500,
    );
  }

  if (!merchants || merchants.length === 0) {
    return json({ checked: 0, reconciled: 0, still_installed: 0, errors: 0 });
  }

  let reconciled = 0;
  let stillInstalled = 0;
  let errors = 0;
  const reconciledDomains: string[] = [];

  for (const m of merchants as Array<{ id: string; shopify_domain: string }>) {
    const outcome = await probeMerchant(m.shopify_domain);

    if (outcome === "uninstalled") {
      try {
        await reconcileToUninstalled(m.id, m.shopify_domain);
        reconciled += 1;
        reconciledDomains.push(m.shopify_domain);
        sentry.addBreadcrumb({
          category: "reconcile-installs",
          message: "reconciled_to_uninstalled",
          level: "warning",
          data: { shop: m.shopify_domain },
        });
      } catch (err) {
        errors += 1;
        sentry.captureException(err, {
          tags: { area: "reconcile-installs", branch: "reconcile_failed" },
          extra: { shop: m.shopify_domain },
        });
      }
    } else if (outcome === "installed") {
      stillInstalled += 1;
    } else {
      errors += 1;
    }

    await sleep(PACE_MS);
  }

  return json({
    checked: merchants.length,
    reconciled,
    still_installed: stillInstalled,
    errors,
    reconciled_domains: reconciledDomains,
  });
}

type ProbeOutcome = "installed" | "uninstalled" | "transient_error";

/**
 * Probe a single merchant. We treat a missing-token state and Shopify 401
 * responses as definitive uninstalls; everything else (5xx, network errors,
 * GraphQL errors) is transient — skip and retry tomorrow rather than risk
 * an erroneous reconciliation.
 */
async function probeMerchant(shopifyDomain: string): Promise<ProbeOutcome> {
  let executor;
  try {
    executor = await createAdminClient(shopifyDomain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No access token")) {
      // No token in sessions OR merchants → the OAuth path's already gone.
      return "uninstalled";
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
    // The executor throws "HTTP 401 from <shop>" on revoked tokens. That's
    // the unambiguous uninstall signal we want to act on.
    if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
      return "uninstalled";
    }
    // 5xx, timeouts, connection resets — try again tomorrow.
    console.warn(
      `[cron/reconcile-installs] probe failed for ${shopifyDomain}: ${msg}`,
    );
    return "transient_error";
  }
}

/**
 * Mark merchant uninstalled + delete sessions + record an audit row in
 * webhook_failures so the absence of an inbound webhook is captured.
 */
async function reconcileToUninstalled(
  merchantId: string,
  shop: string,
): Promise<void> {
  const nowIso = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("merchants")
    .update({ uninstalled_at: nowIso })
    .eq("id", merchantId);

  if (updateErr) {
    throw new Error(
      `merchants.update failed for ${shop}: ${updateErr.message}`,
    );
  }

  // Best-effort session cleanup. Token's revoked anyway; this is just hygiene.
  await supabase.from("sessions").delete().eq("shop", shop);

  // Audit row — record that this uninstall was discovered by the reconciler
  // rather than via the webhook. Inserted already-resolved so it doesn't
  // pollute the unresolved hot set.
  try {
    await supabase.from("webhook_failures").insert({
      topic: "app/uninstalled",
      shop,
      payload: { reconciled: true, source: "reconcile-installs" },
      error_message: "no webhook received — discovered by reconciler",
      resolved_at: nowIso,
    });
  } catch (err) {
    console.warn(
      `[cron/reconcile-installs] webhook_failures audit insert failed for ${shop}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
