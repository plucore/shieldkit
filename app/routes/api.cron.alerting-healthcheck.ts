/**
 * app/routes/api.cron.alerting-healthcheck.ts
 * Route: /api/cron/alerting-healthcheck   (GET + POST, bearer CRON_SECRET)
 *
 * Answers one question on demand: **is Sentry actually receiving from
 * production right now?**
 *
 * Sends a single `captureMessage` and returns the Sentry event id plus how long
 * delivery took. A non-null `event_id` that you can then find in Sentry is
 * end-to-end proof that DSN, network egress, and the flush all work.
 *
 * ── WHY THIS IS PERMANENT, NOT A THROWAWAY ─────────────────────────────────
 *
 * Alerting is the one system whose failure is, by construction, silent: the
 * alarm that tells you the alarms are broken is the broken alarm. This project
 * has already lived through it — captures were enqueued and never delivered for
 * an unknown period, and the only reason anyone noticed was an audit that went
 * looking for an event it knew had fired. "Is my alerting alive" should be
 * answerable in ten seconds, on demand, not reconstructed during an incident.
 *
 * Also doubles as the deploy-time verification for the flush contract in
 * sentry.server.ts: hit it after a deploy that touches Sentry and confirm the
 * returned id appears in the project.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Bearer CRON_SECRET, same gate as every other cron route. Sends NO merchant
 * data — a fixed string plus the deploy sha. Writes nothing to the database.
 * Level is `info`, so it will not page anyone or pollute the unresolved-issue
 * list the way a synthetic `error` would.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { sentry } from "../lib/sentry.server";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const dsnConfigured = !!process.env.SENTRY_DSN;
  const startedAt = Date.now();

  // Awaited: captureMessage flushes internally, and the response below would
  // otherwise be free to freeze the container mid-delivery — which is the exact
  // failure this route exists to detect.
  const eventId = await sentry.captureMessage(
    "ShieldKit alerting health check — if you can see this, explicit captures are being delivered.",
    "info",
    {
      tags: { area: "alerting.healthcheck" },
      extra: { release: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown" },
    },
  );

  return json({
    // null here with dsn_configured=true means the capture ran but Sentry
    // returned no id — a client/transport problem, not a config one.
    event_id: eventId ?? null,
    dsn_configured: dsnConfigured,
    delivery_ms: Date.now() - startedAt,
    hint: dsnConfigured
      ? "Search this event_id in the shieldkit Sentry project. Present = alerting is alive."
      : "SENTRY_DSN is not set in this environment, so capture is a no-op by design.",
  });
}
