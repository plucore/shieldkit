#!/usr/bin/env bash
#
# scripts/weekly-health.sh — run this once a week. Takes about two seconds.
#
# Watches the three numbers that actually predict a Vercel Hobby incident, and
# the two that predict a merchant-facing failure. Everything here is a plain
# read; the script never writes.
#
# WHY THESE NUMBERS. The 2026-07-28 usage investigation found that ShieldKit's
# Vercel spend is driven almost entirely by function INVOCATION COUNT, and that
# queue inbound is the leading indicator for both the billing wall and the
# product wall (stale enrichment). Fluid Active CPU is the binding resource
# (62% of the 4h cap at the time of writing) and it tracks invocations, so
# invocation drivers are what you monitor — not GB-hours.
#
# USAGE
#   ./scripts/weekly-health.sh            # reads SUPABASE_* from .env
#   ./scripts/weekly-health.sh --json     # machine-readable, for piping
#
# Requires: curl, python3. No npm install, no tsx, no dependencies.

set -euo pipefail
cd "$(dirname "$0")/.."

JSON_MODE=0
[ "${1:-}" = "--json" ] && JSON_MODE=1

# ── env ──────────────────────────────────────────────────────────────────────
# Strips surrounding whitespace and either quote style. Deliberately not
# `source .env` — that would execute whatever is in the file.
_getenv() {
  grep -E "^[[:space:]]*$1=" .env 2>/dev/null | head -1 | cut -d= -f2- \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
if [ -f .env ]; then
  SUPABASE_URL=$(_getenv SUPABASE_URL)
  SERVICE_KEY=$(_getenv SUPABASE_SERVICE_ROLE_KEY)
fi
SUPABASE_URL="${SUPABASE_URL:-}"
SERVICE_KEY="${SERVICE_KEY:-}"
if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_KEY" ]; then
  echo "ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found in .env" >&2
  exit 1
fi

# One round trip. Supabase exposes RPC only for defined functions, so this uses
# PostgREST's table endpoints with server-side counts via Prefer: count=exact,
# which is why each metric is a HEAD-style request rather than one big SQL.
q() { # q <path> -> total count from Content-Range
  curl -sS -I \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Prefer: count=exact" -H "Range: 0-0" \
    "$SUPABASE_URL/rest/v1/$1" \
  | tr -d '\r' | awk -F'/' 'tolower($0) ~ /^content-range:/ {print $2}'
}

# Must end in `Z`, not `+00:00`. An unencoded `+` in a query string is decoded
# as a SPACE, which makes PostgREST reject the timestamp and return no
# content-range — silently yielding an empty count rather than an error.
_ago() { python3 -c "import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1"; }
ISO_1D=$(_ago 1)
ISO_7D=$(_ago 7)

BACKLOG=$(q "pending_scan_triggers?select=id&processed_at=is.null")
INBOUND_24H=$(q "pending_scan_triggers?select=id&trigger_at=gte.$ISO_1D")
INBOUND_7D=$(q "pending_scan_triggers?select=id&trigger_at=gte.$ISO_7D")
DRAINED_24H=$(q "pending_scan_triggers?select=id&processed_at=gte.$ISO_1D")
WEBHOOK_7D=$(q "enrichment_webhook_log?select=id&created_at=gte.$ISO_7D")
LOGROWS=$(q "enrichment_webhook_log?select=id")
OLDEST=$(curl -sS -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  "$SUPABASE_URL/rest/v1/pending_scan_triggers?select=trigger_at&processed_at=is.null&order=trigger_at.asc&limit=1" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['trigger_at'][:10] if d else 'none')")

INBOUND_PER_DAY=$(python3 -c "print(round($INBOUND_7D/7))")

if [ "$JSON_MODE" = "1" ]; then
  python3 -c "
import json;print(json.dumps({
 'backlog':$BACKLOG,'oldest_unprocessed':'$OLDEST','inbound_24h':$INBOUND_24H,
 'inbound_per_day_7d_avg':$INBOUND_PER_DAY,'drained_24h':$DRAINED_24H,
 'webhook_deliveries_7d':$WEBHOOK_7D,'enrichment_log_rows_total':$LOGROWS}))"
  exit 0
fi

echo
echo "ShieldKit weekly health — $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "─────────────────────────────────────────────────────────────"
printf "  queue backlog (unprocessed)   %8s\n" "$BACKLOG"
printf "  oldest unprocessed            %8s\n" "$OLDEST"
printf "  inbound  last 24h             %8s\n" "$INBOUND_24H"
printf "  inbound  per day (7d avg)     %8s   <-- THE NUMBER TO WATCH\n" "$INBOUND_PER_DAY"
printf "  drained  last 24h             %8s\n" "$DRAINED_24H"
printf "  webhook deliveries last 7d    %8s\n" "$WEBHOOK_7D"
printf "  enrichment_webhook_log rows   %8s\n" "$LOGROWS"
echo "─────────────────────────────────────────────────────────────"

# ── thresholds ───────────────────────────────────────────────────────────────
# Drain capacity after PR #12 is ~500 rows/day (BATCH_SIZE 100 x 5 runs/day,
# bounded by a 45s wall-clock guard and 5-way concurrency).
ALERT=0
if [ "$INBOUND_PER_DAY" -ge 400 ]; then
  echo "  ACT NOW — inbound ${INBOUND_PER_DAY}/day is at or above 400."
  echo "    You are within ~20% of the ~500/day drain ceiling. No Hobby-legal"
  echo "    cron cadence fixes this. Do the catalog-reconcile migration"
  echo "    (replace products/update with a daily reconcile) NOW, not later."
  ALERT=1
elif [ "$INBOUND_PER_DAY" -ge 300 ]; then
  echo "  WATCH — inbound ${INBOUND_PER_DAY}/day. Headroom is shrinking."
  echo "    Start the catalog-reconcile build; you have weeks, not days."
  ALERT=1
fi
if [ "$BACKLOG" -ge 2000 ]; then
  echo "  ACT NOW — backlog ${BACKLOG}. Enrichment is materially stale for a"
  echo "    PAYING merchant. Check the drainer is running: the GitHub Actions"
  echo "    workflow should fire 4x/day and Vercel Cron once at 12:00 UTC."
  ALERT=1
elif [ "$BACKLOG" -ge 500 ]; then
  echo "  WATCH — backlog ${BACKLOG}. Fine if it is falling week over week;"
  echo "    a problem if it is not. Compare against last week's run."
  ALERT=1
fi
if [ "$DRAINED_24H" -lt 40 ] && [ "$BACKLOG" -gt 100 ]; then
  echo "  INVESTIGATE — only ${DRAINED_24H} drained in 24h with ${BACKLOG} waiting."
  echo "    The drainer is not running. Check the GitHub Actions run history and"
  echo "    that CRON_SECRET still matches between GitHub and Vercel."
  ALERT=1
fi
if [ "$LOGROWS" -ge 400000 ]; then
  echo "  HOUSEKEEPING — enrichment_webhook_log at ${LOGROWS} rows. Nothing reads"
  echo "    this table. Run the prune plan in docs/september-backlog.md §A."
  ALERT=1
fi
[ "$ALERT" = "0" ] && echo "  All clear. Nothing to do."
echo
