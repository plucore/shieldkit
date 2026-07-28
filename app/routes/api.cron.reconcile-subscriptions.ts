/**
 * app/routes/api.cron.reconcile-subscriptions.ts
 *
 * POST /api/cron/reconcile-subscriptions
 *
 * Triggered by Vercel Cron daily at 04:00 UTC.
 *
 * Why this exists: Post April 28, 2026 the APP_SUBSCRIPTIONS_UPDATE webhook
 * is gone and `billing.check()` no longer returns subscription state for
 * managed-pricing apps. If a merchant cancels their plan via Shopify's
 * hosted billing page and never reopens the embedded app, the dashboard
 * self-heal loader (app._index.tsx) never runs — so the DB keeps showing
 * them as a paid tier and they get paid features for free.
 *
 * This job closes that gap. For every active paid merchant we query the
 * Partner API for the current subscription status. If Shopify says the
 * subscription is in a terminal state (cancelled / expired / frozen /
 * declined) we demote the merchant to free, mirroring exactly what the
 * APP_SUBSCRIPTIONS_UPDATE webhook used to do on the same statuses.
 *
 * CRITICAL FAIL-SAFE: if the Partner API call fails or returns
 * `status: "unknown"` (network error, GraphQL error, no matching events,
 * unrecognised plan name, etc.) we MUST NOT demote. Skip and log. Demoting
 * on uncertainty would yank features from a paying customer because of a
 * transient network blip. Same principle as the dashboard self-heal loader.
 *
 * Scaling note: this currently runs a single-pass loop. Each Partner API
 * call costs ~300ms–1s nominal (up to ~3.5s in the worst-case 3-retry
 * exponential-backoff path). With ~50 paid merchants that's well under
 * Vercel Hobby's 60s function ceiling. When the paid base outgrows what
 * fits in ~50s of Partner API calls (rough ceiling ~80–100 merchants),
 * follow the enqueue/drain pattern from api.cron.weekly-scan.ts +
 * api.cron.process-scan-triggers.ts: enqueue one trigger row per merchant
 * here, drain in a separate route polled by GitHub Actions.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { PAID_TIERS } from "../lib/billing/plans";
import { getActiveSubscriptionByChargeId } from "../lib/billing/partner-api.server";
import {
  ensureProductWebhooks,
  removeProductWebhooks,
} from "../lib/webhooks/product-webhooks.server";
import { sentry } from "../lib/sentry.server";

const TERMINAL_STATUSES = new Set([
  "cancelled",
  "expired",
  "frozen",
  "declined",
]);

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Vercel Cron invokes a scheduled path with **GET**, which React Router routes
// to the loader. This route used to 405 every GET, so this reconciler — the
// ONLY code path that demotes a merchant on terminal Partner-API status — had
// never executed in production, and cancel-but-stay-installed churn was
// undetectable. Both verbs now run the same handler; the bearer CRON_SECRET
// check inside `run()` is the only authorisation gate, so widening the verb
// does not widen access. Fixed 2026-07-28.
export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

async function run(request: Request) {
  // ── 1. Verify CRON_SECRET ───────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron/reconcile-subscriptions] CRON_SECRET env var is not set",
    );
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

  // ── 2. Fetch every merchant with a stored subscription gid ─────────────────
  //
  // Deliberately NOT restricted to PAID_TIERS (widened 2026-07-28). This job
  // used to only walk merchants we already believed were paid, which made it
  // structurally incapable of fixing the failure that actually happened: a
  // merchant wrongly demoted to `free` was excluded by the tier filter, so the
  // only job that could restore them never looked at them again.
  //
  // Now it walks anything carrying a charge id and reconciles in BOTH
  // directions — demote a paid row Shopify says is finished, and RE-PROMOTE a
  // free row Shopify says is still active. A missing charge id is still
  // skipped, because there is nothing to look up.
  //
  // Direction of failure is a deliberate choice: over-entitling on a Partner
  // API misread is recoverable on the next pass, under-entitling loses a
  // paying customer. Fail toward access.
    // ── ALARM: entitled but INVISIBLE to this reconciler ──────────────────────
  //
  // This job filters on `shopify_subscription_id IS NOT NULL`, because a NULL id
  // gives it nothing to look up. That makes a paid row with a NULL id permanently
  // invisible HERE — it will never be demoted, never re-promoted, and never get
  // the still-active `ensureProductWebhooks` self-heal below. It is the one
  // entitlement state nothing in the system converges on, so it has to be
  // reported rather than reconciled.
  //
  // The founder's dev store lives in this state legitimately and forever: its
  // charges are all `test: true`, so there is no Partner API charge to track and
  // no id to store. Alarming on it daily would train the alarm to be ignored,
  // which is worse than not having one — so it is exempt BY NAME, with the reason,
  // and still counted in the response so it stays visible without being noisy.
  const PROVISIONING_ALARM_EXEMPT = new Set<string>([
    // test-only charges → no Partner API charge id exists to store
    "shieldkit-test-stor.myshopify.com",
  ]);

  let unreconcilableExempt = 0;
  const unreconcilablePaid: string[] = [];
  try {
    const { data: orphanPaid, error: orphanErr } = await supabase
      .from("merchants")
      .select("shopify_domain, tier")
      .is("uninstalled_at", null)
      .is("shopify_subscription_id", null)
      .neq("tier", "free");
    if (orphanErr) throw new Error(orphanErr.message);
    for (const row of orphanPaid ?? []) {
      if (PROVISIONING_ALARM_EXEMPT.has(row.shopify_domain as string)) {
        unreconcilableExempt += 1;
      } else {
        unreconcilablePaid.push(`${row.shopify_domain} (tier=${row.tier})`);
      }
    }
    if (unreconcilablePaid.length > 0) {
      sentry.captureMessage(
        `reconcile-subscriptions: ${unreconcilablePaid.length} paid merchant(s) have NO shopify_subscription_id and are invisible to every reconciler — ` +
          `${unreconcilablePaid.join(", ")}. Fix: find the charge in the Partner API and write shopify_subscription_id, or demote if they are not actually paying.`,
        "warning",
      );
      console.error(
        `[cron/reconcile-subscriptions] UNRECONCILABLE PAID ROWS: ${unreconcilablePaid.join(", ")}`,
      );
    }
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "reconcile-subscriptions", branch: "unreconcilable_alarm" },
    });
  }

  const { data: merchants, error: fetchError } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier, shopify_subscription_id, billing_cycle")
    .is("uninstalled_at", null)
    .not("shopify_subscription_id", "is", null);

  if (fetchError) {
    console.error(
      "[cron/reconcile-subscriptions] Failed to fetch merchants:",
      fetchError.message,
    );
    return json(
      { error: "database_error", message: "Could not fetch merchants." },
      500,
    );
  }

  if (!merchants || merchants.length === 0) {
    return json({ checked: 0, demoted: 0, skipped_unknown: 0 });
  }

  let demoted = 0;
  let skippedUnknown = 0;
  let stillActive = 0;
  let repromoted = 0;
  let alreadyFree = 0;
  let lookupErrors = 0;
  const demotedDomains: string[] = [];
  const skippedDomains: string[] = [];
  const repromotedDomains: string[] = [];

  for (const m of merchants) {
    const subGid = m.shopify_subscription_id as string;
    // Does OUR DB currently believe this merchant is entitled? Drives which
    // direction of correction applies below.
    const entitledNow = (PAID_TIERS as readonly string[]).includes(m.tier);

    // A thrown Partner API error must not abort the whole pass — one bad row
    // would otherwise leave every merchant after it unreconciled. Treat a throw
    // exactly like status="unknown": skip this row, keep going.
    let sub: Awaited<ReturnType<typeof getActiveSubscriptionByChargeId>>;
    try {
      sub = await getActiveSubscriptionByChargeId(subGid);
    } catch (err) {
      lookupErrors += 1;
      sentry.captureException(err, {
        tags: { area: "reconcile-subscriptions", branch: "partner_api_lookup" },
        extra: { shop: m.shopify_domain, subscription: subGid },
      });
      console.error(
        `[cron/reconcile-subscriptions] Partner API threw for ${m.shopify_domain} — skipping row, continuing pass: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // ── RE-PROMOTE: Shopify says active, our DB says free ────────────────────
    // This is the recovery path for the 2026-07-28 incident, where a superseded
    // -subscription cancellation demoted a live $29/mo customer. Runs BEFORE the
    // demote branch so an active subscription is never re-evaluated for demotion.
    if (sub.status === "active" && !entitledNow) {
      // Never grant paid access on a TEST charge — those are development-store
      // charges where no money moves, and doing so is what puts phantom paid
      // rows in the tier counts.
      if (sub.test === true) {
        console.warn(
          `[cron/reconcile-subscriptions] ${m.shopify_domain} has an ACTIVE but TEST charge ${subGid} — not re-promoting.`,
        );
        alreadyFree += 1;
        continue;
      }
      if (!sub.tier || sub.tier === "free") {
        console.warn(
          `[cron/reconcile-subscriptions] ${m.shopify_domain} active charge ${subGid} maps to tier=${sub.tier} — nothing to restore.`,
        );
        alreadyFree += 1;
        continue;
      }

      const { error: promoteError } = await supabase
        .from("merchants")
        .update({
          tier: sub.tier,
          billing_cycle: sub.cycle ?? m.billing_cycle ?? null,
          subscription_started_at: sub.activatedAt ?? null,
          shopify_subscription_id: subGid,
          scans_remaining: null, // null = unlimited on every paid tier
        })
        .eq("id", m.id);

      if (promoteError) {
        console.error(
          `[cron/reconcile-subscriptions] failed to RE-PROMOTE ${m.shopify_domain}: ${promoteError.message}`,
        );
        continue;
      }

      repromoted += 1;
      repromotedDomains.push(m.shopify_domain);
      // Loud on purpose: a re-promote means something previously stripped a
      // paying merchant's access, and that root cause deserves attention even
      // though this pass has papered over the symptom.
      sentry.captureMessage(
        `reconcile-subscriptions RE-PROMOTED ${m.shopify_domain} — Partner API says active but DB had tier=${m.tier}`,
        "warning",
      );
      console.log(
        `[cron/reconcile-subscriptions] RE-PROMOTED ${m.shopify_domain} to tier=${sub.tier} cycle=${sub.cycle} (was tier=${m.tier})`,
      );

      // Re-assert their per-shop products/* subscriptions, which a demotion
      // would have torn down via removeProductWebhooks.
      try {
        const ensure = await ensureProductWebhooks(m.shopify_domain);
        if (ensure.errors.length) {
          console.warn(
            `[cron/reconcile-subscriptions] ensureProductWebhooks errors for re-promoted ${m.shopify_domain}: ${ensure.errors.join("; ")}`,
          );
        }
      } catch (err) {
        sentry.captureException(err, {
          tags: { area: "reconcile-subscriptions", branch: "repromote_ensure_webhooks" },
          extra: { shop: m.shopify_domain },
        });
      }
      continue;
    }

    // ── Already free and Shopify agrees it is finished → nothing to do ───────
    // Load-bearing guard. Widening the query to include free rows means a free
    // row carrying a stale cancelled charge id now reaches this loop every day.
    // Without this branch it would fall into the demote block below and rewrite
    // `scans_remaining: 1` on every pass — a daily free-scan refill, i.e. an
    // unlimited-free-scan farm on any merchant who ever cancelled.
    if (!entitledNow) {
      alreadyFree += 1;
      continue;
    }

    // FAIL-SAFE: never demote on uncertainty.
    if (sub.status === "unknown") {
      console.warn(
        `[cron/reconcile-subscriptions] skip ${m.shopify_domain} — partner-api status=unknown reason=${sub.reason}`,
      );
      skippedUnknown += 1;
      skippedDomains.push(m.shopify_domain);
      continue;
    }

    if (TERMINAL_STATUSES.has(sub.status)) {
      // Mirror the APP_SUBSCRIPTIONS_UPDATE webhook's terminal-status reset.
      const { error: updateError } = await supabase
        .from("merchants")
        .update({
          tier: "free",
          billing_cycle: null,
          subscription_started_at: null,
          // shopify_subscription_id DELIBERATELY PRESERVED — see the matching
          // note in webhooks.app_subscriptions.update.tsx. Nulling it here would
          // re-erase the key this very job filters on, so a demotion that later
          // turns out to be wrong could never be undone. The `entitledNow`
          // guard above is what stops a preserved id causing repeat demotes.
          scans_remaining: 1,
          scans_reset_at: new Date().toISOString(),
        })
        .eq("id", m.id);

      if (updateError) {
        console.error(
          `[cron/reconcile-subscriptions] failed to demote ${m.shopify_domain}: ${updateError.message}`,
        );
        continue;
      }

      console.log(
        `[cron/reconcile-subscriptions] demoted ${m.shopify_domain} — partner-api status=${sub.status} (was tier=${m.tier})`,
      );

      // Now that they're free, tear down their per-shop products/* webhooks so
      // we stop paying for enrichment deliveries they can no longer use.
      // Best-effort — never let a webhook cleanup failure abort the cron pass.
      try {
        const removal = await removeProductWebhooks(m.shopify_domain);
        if (removal.errors.length) {
          console.warn(
            `[cron/reconcile-subscriptions] removeProductWebhooks errors for ${m.shopify_domain}: ${removal.errors.join("; ")}`,
          );
        }
      } catch (err) {
        sentry.captureException(err, {
          tags: {
            area: "reconcile-subscriptions",
            branch: "remove_product_webhooks",
          },
          extra: { shop: m.shopify_domain },
        });
      }

      demoted += 1;
      demotedDomains.push(m.shopify_domain);
      continue;
    }

    // status === "active" | "pending" — DB and Shopify agree (or merchant
    // is in a pre-approval pending state). Leave the row alone.
    stillActive += 1;

    // Self-heal backstop: re-assert the per-shop products/* subscriptions for
    // confirmed-active paid merchants. Idempotent and cheap (only paid
    // merchants are iterated here), this repairs any subscription that a
    // missed upgrade-path call left unprovisioned, within 24h. Best-effort.
    if (sub.status === "active") {
      try {
        const ensure = await ensureProductWebhooks(m.shopify_domain);
        if (ensure.errors.length) {
          console.warn(
            `[cron/reconcile-subscriptions] ensureProductWebhooks errors for ${m.shopify_domain}: ${ensure.errors.join("; ")}`,
          );
        }
      } catch (err) {
        sentry.captureException(err, {
          tags: {
            area: "reconcile-subscriptions",
            branch: "ensure_product_webhooks",
          },
          extra: { shop: m.shopify_domain },
        });
      }
    }
  }

  return json({
    checked: merchants.length,
    // Always reported, alarmed on only when non-exempt — see the alarm block above.
    unreconcilable_paid: unreconcilablePaid,
    unreconcilable_exempt: unreconcilableExempt,
    demoted,
    repromoted,
    skipped_unknown: skippedUnknown,
    still_active: stillActive,
    already_free: alreadyFree,
    lookup_errors: lookupErrors,
    demoted_domains: demotedDomains,
    repromoted_domains: repromotedDomains,
    skipped_domains: skippedDomains,
  });
}
