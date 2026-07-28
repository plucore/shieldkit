# ShieldKit Data-Integrity Audit — 2026-07-27

Diagnostic only. No code changed, no migrations run.

Method: every claim below was traced to source and re-checked against the live Supabase project
(`bhnpcirhutczdorkhibm`), the live PostHog project (Plucore / 140634, EU), the deployed Shopify app
manifest (`.shopify/deploy-bundle/manifest.json`), and git history. Where `CLAUDE.md` contradicts the
code, the code wins and the drift is flagged.

---

## The headline, before the six issues

Two of your inferences were wrong in a way that matters, and the truth is worse than the report you
started from.

**1. Uninstalls *are* being recorded. The rows are then deleted.**
`uninstalled_at` is not silently failing to write. It writes, and then Shopify's GDPR `shop/redact`
webhook hard-deletes the entire merchant row 48 hours later, cascading to scans, violations and
enrichments. `uninstalled_at IS NOT NULL` is a state with a 48-hour half-life — a point-in-time query
can essentially never observe it.

**Proof:** `leads` has no foreign key to `merchants`, so it survives the cascade. There are **41 orphan
`leads` rows**, all `.myshopify.com`, spread evenly from 2026-03-23 to 2026-07-18. 40 of them carry the
signature of the authenticated install-path writer (`public_risk_score IS NULL`). Each one is a shop
that installed, ran a scan, and no longer exists.

**Real churn is roughly 40 out of ~94 lifetime installs (~43%), not zero.**

**2. One of your two paying customers already churned, and one of the two remaining "paid" rows is your
own test store.**

| Shop | Paid | Status |
|---|---|---|
| `cq3dar-gv.myshopify.com` | 2026-07-07 09:36 UTC (Monitoring, monthly) | **Row hard-deleted.** Gone from `merchants` and `sessions`; only the orphan `leads` row remains. |
| `sex-eshop.myshopify.com` | 2026-07-12 08:17 UTC (Monitoring, monthly) | Active — your one real paying customer. |
| `shieldkit-test-stor.myshopify.com` | tier `monitoring` since 2026-05-28 | Your own test store. `shopify_subscription_id IS NULL`, so `reconcile-subscriptions` can never demote it. Permanent phantom MRR. |

The database reports **2 paying, 0 churned**. Reality: **1 real paying customer, 1 real customer who paid
and churned, 1 test store**. `cq3dar-gv` installed and paid within **159 seconds**, then vanished.

**3. A cross-cutting bug nobody's six issues owned: two of your three Vercel crons have never run.**
All three cron routes are POST-only behind a 405 loader
(`api.cron.reconcile-installs.ts:57-70`, `api.cron.reconcile-subscriptions.ts:61-73`,
`api.cron.process-scan-triggers.ts:71-80`). **Vercel Cron issues GET.** Only
`process-scan-triggers` does work, and only because `.github/workflows/process-scan-triggers.yml:49`
passes `--request POST`.

Consequence: `reconcile-subscriptions` has **never executed**. It is the only code path that demotes a
merchant on terminal subscription status. Paid churn is invisible twice over — the row gets deleted
*and* cancellation is never detected.

---

## ISSUE 1 — `installed_at` is overwritten

**Severity: HIGH. Still firing — most recent clobber 2026-07-18, nine days ago.**

### Root cause

Two constructs compose.

**(a) The write.** [`app/shopify.server.ts:70-80`](app/shopify.server.ts:70) is the *only* write to
`merchants.installed_at` in the repo. Line 76 is the offending literal:

```ts
installed_at: new Date().toISOString(),
```

**(b) The upsert is a clobber.** `.upsert(values, { onConflict: "shopify_domain" })` sends
`Prefer: resolution=merge-duplicates`, which PostgREST turns into
`INSERT … ON CONFLICT DO UPDATE SET <every key in the body> = EXCLUDED.<key>`. On an existing row this
is a full UPDATE of all four columns in the payload. `created_at` is absent from the body, so it is
never touched.

**(c) `afterAuth` fires far more often than "on install".** `@shopify/shopify-app-react-router` v1.1.0
ships only the token-exchange strategy — there is no authorization-code path. `afterAuth` runs after
*any* successful offline-token exchange, and the gate
(`strategies/token-exchange.mjs:56-57`) is `!session || !session.isActive(...)`. So it fires on install,
reinstall, after a sessions-row deletion, after a token-decrypt failure, and after token expiry.

**(d) The historical amplifier.** `future.expiringOfflineAccessTokens: true` was live from the initial
commit (`c0b0e3f`, 2026-02-26) until `138d4aa` (2026-06-26). Tokens carried a ~24h TTL, so any merchant
opening the embedded app a day after their last exchange triggered a fresh exchange and a restamp.

**Your hypothesis: partially correct.** Confirmed that the upsert clobbers. Refined on the trigger — it
is not "every OAuth callback / token refresh / session create", it is *every token exchange*, which was
near-daily per active merchant before 2026-06-26 and is occasional now.

### What the production data actually shows

The "all 54 rows differ" figure decomposes into two very different populations:

| Bucket | Count | Delta |
|---|---|---|
| `installed_at` ~0.1–0.6s **before** `created_at` | **27** | Sub-second JS-clock vs DB-clock skew at INSERT. **These rows are clean** — never re-authed. |
| `installed_at` **after** `created_at` | **27** | Genuine clobbers: 1 hour to 87.4 days. |

So it is not 54 corrupted rows — it is **exactly 27 (50%)**.

Clobbers stamped **after** the 2026-06-26 fix: **4**, of which 2 in July. Most recent: **2026-07-18
03:02 UTC**. The flag flip cut the frequency; it did not stop the bug. 38 merchants still hold dormant
legacy sessions and will re-corrupt on their next visit.

The "scan 59 min before installed_at" observation: **26 merchants have a scan predating their own
`installed_at`**. Merchants scan minutes after installing, then a later re-auth pushes `installed_at`
forward past the scan.

### Trustworthy first-install timestamp: `created_at` — yes, safe to rely on

- `TIMESTAMPTZ NOT NULL DEFAULT now()`; no migration alters it.
- No code path anywhere writes `merchants.created_at` (exhaustive grep across `app/`, `scripts/`,
  `supabase/`).
- No trigger or function on `public.merchants` references it.
- Empirical: **0 of 114 scans predate their merchant's `created_at`** (vs 26 that predate `installed_at`).
- The only re-INSERT risk would be a reinstall after `shop/redact` hard-delete — that would legitimately
  reset `created_at`, and there is no such case in the current data.

Best illustration of the damage: `shieldkit-test-stor` has `subscription_started_at = 2026-05-28` but
`installed_at = 2026-06-27` — it appears to have subscribed **30 days before installing**.

### Blast radius

- Any cohort, tenure, or time-to-activation metric keyed on `installed_at`.
- Time-to-conversion: negative for one of two paying merchants.
- Nothing in the app *reads* `installed_at`, so no runtime behaviour is affected — this is purely an
  analytics corruption.

### Fix (smallest first)

1. **Delete line 76** from the afterAuth payload. The column is `NOT NULL DEFAULT now()`, so the first
   INSERT still stamps correctly and the column drops out of the `DO UPDATE` SET list. One line, no
   migration. Test-safe: `tests/bug-fixes.test.ts:1300-1321` only asserts `scans_remaining` is absent
   from that payload.
2. Optional: add a `last_auth_at` column if you want the re-auth signal preserved (PostHog `install`
   already covers this from 2026-06-27).

### Backfill

**Fully recoverable.** `UPDATE merchants SET installed_at = created_at WHERE installed_at > created_at + INTERVAL '2 seconds';`
(27 rows). **Deploy the code fix first** — otherwise the 38 dormant legacy sessions re-corrupt rows as
merchants return.

---

## ISSUE 2 — uninstalls never recorded

**Severity: CRITICAL. Data is being permanently destroyed right now.**

### Root cause

Your three suspected mechanisms are all refuted:

- **Not a route mismatch.** Vercel logs show `POST /webhooks/app/uninstalled` returning **401**, not 404 —
  the route resolves and the handler runs. (The 401 is a manual probe without a valid HMAC; that is
  correct behaviour.)
- **Not a missing subscription.** `.shopify/deploy-bundle/manifest.json` contains a
  `webhook_subscription` module for `app/uninstalled` → `https://shieldkit.vercel.app/webhooks/app/uninstalled`,
  api_version 2026-04. It is deployed.
- **Not silent HMAC rejection.** `webhook_failures` being empty is *not* evidence of anything. It is only
  written on a Supabase **write error** ([`webhooks.app.uninstalled.tsx:73-101`](app/routes/webhooks.app.uninstalled.tsx:73)),
  so 0 rows is equally consistent with "never delivered" and "delivered and succeeded".

**The actual mechanism: the row is deleted 48 hours later.**

[`webhooks.shop.redact.tsx:45-48`](app/routes/webhooks.shop.redact.tsx:45) hard-deletes the merchant by
domain, and all 7 child FKs CASCADE. Shopify sends `shop/redact` 48h after every uninstall. It is the
**only** merchant-delete path in the entire codebase (verified: every `.delete()` call in `app/` and
`scripts/` enumerated).

So the lifecycle is: uninstall → `uninstalled_at` written, sessions deleted → 48h → **entire row and all
history erased**.

**Evidence:** 41 orphan `leads` rows (no FK, survives the cascade), all `.myshopify.com`, 40 with the
install-path signature. Corroborated by PostHog: of 24 shops with an `install` event since 2026-06-27,
**8 no longer have a merchant row** — a 40% 30-day cohort churn against a reported 0%.

**Secondary, historical mechanism.** `expiringOfflineAccessTokens: true` (live 2026-02-26 → 2026-06-26)
made `authenticate.webhook()` attempt a token refresh for expired offline sessions, which always fails
for an already-uninstalled shop and throws *before* the handler body. The production preconditions are
armed: **38 of 54 sessions carry a non-null `expires`, all expired, all with a refresh token**. Those 38
split cleanly from the 16 modern sessions:

| Token state | Merchants | Never scanned | Most recent scan | NULL metadata |
|---|---|---|---|---|
| Legacy, expired | 38 | 3 | 2026-06-22 | **18 (all of them)** |
| Modern, non-expiring | 16 | 0 | 2026-07-27 | 0 |

I could not bound how many of those 38 are "ghosts" — already uninstalled but unrecordable. It is a real
exposure, but the **proven, dominant mechanism is the hard-delete**, which accounts for all 40 documented
churn events.

### Blast radius

- Churn, retention, cohort survival, LTV: **all unmeasurable**, all-time.
- Every scan, violation, policy and enrichment belonging to ~40 merchants: **permanently gone**.
- `scans` = 114 is an undercount for the same reason.
- Active-install count (54) is an overcount by an unknown number of ghosts.
- **Live GDPR gap, opposite direction:** `leads` has no FK, so the merchant's *email address* survives a
  `shop/redact` that is supposed to erase them. Your most useful data asset and your worst compliance gap
  are the same table.

### Fix (smallest first)

1. **`captureEvent(shop, "uninstall", { tier })`** in `webhooks.app.uninstalled.tsx` after line 24. One
   line, no migration, ships today. Immediately closes the PostHog funnel
   (install → scan → paywall → purchase → uninstall) and makes churn measurable this week.
2. **An append-only `install_events` table with NO foreign key to `merchants`**, written from `afterAuth`,
   from `webhooks.app.uninstalled.tsx`, and from `webhooks.shop.redact.tsx` **before** the delete at line
   45. FK-free is non-negotiable — anything with an FK gets eaten by the same cascade. This is the only
   durable fix.
3. Fix the cron GET/405 mismatch (see the headline) so cancellation is detected at all.

**Sequencing trap:** ship #2 **before** any GDPR fix that deletes `leads` on redact, or you destroy the
only surviving historical churn ledger.

### Backfill

- **Count and identity: recoverable now** from the 40 orphan `leads` rows.
- **Uninstall dates: lost from our systems**, all-time. Vercel Hobby retains runtime logs ~1 hour.
- **Recoverable from Shopify**: the Partner API exposes `RELATIONSHIP_UNINSTALLED` app events with exact
  timestamps for all time. `app/lib/billing/partner-api.server.ts` has a working Partner API client, but
  its `SUBSCRIPTION_EVENT_TYPES` enum contains only the 7 `SUBSCRIPTION_CHARGE_*` values — a backfill
  needs new event types and a domain→Partner-shop-GID resolver that does not exist yet. **Sanity-check
  against the Partner Dashboard install/uninstall chart first — one minute, free.**
- **Tier/scan/violation history of the 40 deleted shops: permanently gone.**

---

## ISSUE 3 — scan metering

**Severity: MEDIUM. Largely a non-finding, with one real bug attached.**

### Root cause

`scan_rate_limits` and `scans_remaining` are **not competing mechanisms and not comparable**. One is an
abuse throttle, the other is an entitlement counter. The 3-vs-114 ratio is apples to oranges.

**Why `scan_rate_limits` is near-empty — three reasons, none of them "metering is broken":**

1. **It is a 1-hour rolling window, not a ledger.**
   [`rate-limiter.server.ts:47-51`](app/lib/rate-limiter.server.ts:47) issues
   `.delete().lt("requested_at", cutoff)` with **no `.eq("shop", key)` filter** — a global purge of every
   row older than 1 hour, on every `checkRateLimit()` call. By construction it can only ever hold the
   last hour of traffic.
2. **The live scan path never calls it.** The dashboard `runScan` action
   (`app/routes/app._index.tsx:652-747`) does merchant lookup → `decrement_scan_quota` →
   `runComplianceScan`. It never imports the rate limiter. Only two files do: `api.scan.ts:38` and
   `scan.tsx:22-25`.
3. **`/api/scan` has no callers.** The shop-keyed branch is dead code in production.

The 3 surviving rows are all `ip:41.210.143.49` from 2026-07-14 — public `/scan` traffic. They survive
only because nothing has called `checkRateLimit()` since, so nothing has purged them. **No shop-keyed row
has ever been written.**

**`scans_remaining` decrement is correct.** The `decrement_scan_quota` RPC
(`supabase/schema.sql:233-241`) is a single guarded UPDATE; both entry points call it before scanning and
both refund on failure.

**`scans_reset_at` is never read.** Grep returns exactly two writers
(`api.cron.reconcile-subscriptions.ts:153`, `webhooks.app_subscriptions.update.tsx:145`) plus the column
DEFAULT, and **zero readers**. `api.cron.monthly-reset.ts` was deleted in v4 and no cron targets it.

**So: yes, those 42 merchants are permanently locked out at `scans_remaining = 0`.** There is no reset
path in the codebase.

### The real bug attached to this issue

The compensating refund (`app._index.tsx:723`, `api.scan.ts:206`) is **not gated on the decrement having
actually happened**. When the `decrement_scan_quota` RPC returns an error, the code logs, skips the
decrement, proceeds to scan, and on failure still credits `+1` — granting quota that was never spent.
Note also that the failure-path copy at `app._index.tsx:743` ("Your scan quota has been restored") is a
lie whenever the refund itself fails.

### Blast radius

- Nothing metric-facing. `scans` is a clean, complete ledger (114 rows, `merchant_id` + `scan_type` +
  `created_at`) — use it for all scan-activity questions.
- 42 free merchants cannot re-scan, which (see Issue 6) also blocks the only path that refreshes their
  metadata.

### Fix (smallest first)

1. **Refund as an absolute write**: `.update({ scans_remaining: scansRemaining })` rather than
   `(scansRemaining ?? 0) + 1`. Idempotent on the RPC-error path. **Do not** replace it with a relative
   `+1` RPC — that makes the bug worse.
2. Product decision: whether free tier gets any reset. 42 merchants currently have no recovery path.
3. Optional cleanup: `/api/scan` is dead code; `scan_rate_limits` could be dropped if the public scanner
   moves to a different throttle.

### Backfill

`scan_rate_limits` history: **permanently lost and was never retained** — by design, not by bug.
Actual scan activity: **fully intact** in `scans`, except for merchants deleted by `shop/redact`.

---

## ISSUE 4 — digest emails never sent

**Severity: LOW as a data issue.**

### Root cause

Not "wired but broken" — **built, briefly wired, never had a single eligible recipient, then deleted.**

- The cron entered `vercel.json` in `1a52ac0` (2026-05-04 13:40 UTC, *after* that Monday's 13:00 slot) and
  left in `059255c` (2026-05-28). Schedule `0 13 * * 1` — **exactly three possible firings**: 2026-05-11,
  05-18, 05-25.
- The recipient query filtered `.in("tier", PAID_TIERS).is("uninstalled_at", null)` and returned
  `{ sent: 0 }` before the loop when empty. **The earliest `subscription_started_at` in the entire
  database is 2026-05-28 09:22** — roughly one hour *after* the digest infra was deleted. There was never
  a paid merchant for it to email.
- A `RESEND_API_KEY` guard would have returned early too.
- Decisive: the deleted code inserted a `digest_emails` audit row even on failure
  (`email_provider_id: "FAILED:no_email_on_file"`, `"FAILED:<reason>"`). **Zero rows proves it returned
  before any per-merchant work** — not that writes were dropped.
- `app/lib/emails/` is gone; no `resend` import remains, though `package.json:46` still declares the
  dependency.

**Note (separate from data integrity):** `app/routes/privacy.tsx` still names Resend as a subprocessor
(`:272-273`) and describes weekly-digest processing and retention (`:197`, `:296`, `:305`). That is a live
public page describing a subprocessor that receives no data and a feature that never shipped. Worth
correcting on its own merits.

### Blast radius

None. Nothing downstream reads `digest_emails`. No retention surface has ever run — your only live
re-engagement mechanism today is in-app banners plus PostHog instrumentation.

### Fix

1. Correct `privacy.tsx`.
2. Remove `resend` from `package.json` **with a regenerated lockfile in the same commit** (`vercel.json`
   uses `npm ci`).
3. Drop or repurpose the `digest_emails` table.

### Backfill

Nothing to backfill — there were no sends. Which of the two early returns fired on those three Mondays is
unrecoverable (Hobby log retention), and doesn't matter.

---

## ISSUE 5 — enrichment log bloat

**Severity: HIGH — because of what it revealed, not the bloat itself.**

### Root cause: three separate things, in three separate eras

**(1) The May blowout — app-level subscription × unconditional skip logging.**
`shopify.app.toml` declared `products/create` + `products/update` **app-wide** from `ce84658`
(2026-05-06), so every install fired the handler regardless of tier, and `logOutcome()` wrote a row on the
skip branches too.

| Month | Outcome | Rows |
|---|---|---|
| 2026-05 | `skip_tier` | **188,063** |
| 2026-05 | `skip_dedup` | 16,669 |
| 2026-05 | `noop` | 13,070 |
| 2026-05 | everything else | ~3,010 |

`skip_tier` alone is **85% of the entire all-time table**. All 220,798 pre-June rows belong to 12
merchants who are all free tier today. Killed by `697907b` (2026-05-20, removed the skip logging) and
`288329f` (2026-06-11, moved `products/*` to per-shop paid-only). June collapsed to 522 rows. **Confirmed.**

**(2) Your "row written on every delivery" suspicion is refuted for today's code.** Four branches now
return without logging (`:203-207` no merchant, `:211-213` uninstalled, `:229-231` unpaid, `:234-236`
missing scope). Today the table is 1 row per paid-merchant product edit — proportionate telemetry.

**(3) The July "spikes" are not a retry loop or duplicate subscriptions — they are one customer, and a
starved queue.**

**9,123 of July's 9,129 rows belong to a single merchant**: `sex-eshop.myshopify.com`, who upgraded on
2026-07-12. The 22–23 July peaks are that merchant editing their catalog. Nothing pathological.

**What *is* pathological is the drain rate.** July logged 3,909 `enqueued` against 4,653
`skip_already_queued` — the skip count exceeds the enqueue count because rows are piling up unprocessed:

```
pending_scan_triggers:  4,074 total
  unprocessed backlog:  3,358
  oldest unprocessed:   2026-07-13
```

`BATCH_SIZE = 10` (`api.cron.process-scan-triggers.ts:46`) × 4 GitHub Actions runs/day = **40 rows/day**
against a ~600/day inbound rate. The Vercel cron that was supposed to be the failsafe contributes zero
(GET/405 — see the headline). Empirical proof: the `processed_at` histogram shows exactly four drain
clusters per day at ~01, ~08, ~13, ~19 UTC, always exactly 10 rows, never a fifth.

**Your one paying customer's advertised enrichment feature is ~14 days behind and falling further behind
every day.** That is a live customer-facing defect, not a logging problem.

### Is anything reading the table?

**No.** Grep across `app/`, `scripts/`, `tests/` finds one writer
(`webhooks.products.update.tsx:45`), a cascade reference in `shop.redact`, and a manual prune script
(`scripts/prune-enrichment-log.ts`) that is explicitly **never wired to a cron**. It is write-only
telemetry: **50 MB, ~91% of the entire database.**

### Fix (smallest first)

1. **Raise drainer throughput** — larger `BATCH_SIZE` with a wall-clock guard under the 60s Hobby ceiling,
   and/or restore sub-6h cadence. **Breaks two tests**: `tests/phase-7-monitoring.test.ts:81` pins
   `BATCH_SIZE = 10`; `:104-111` pins the vercel.json schedule to `0 12 * * *`.
2. **Fix the cron GET/405 mismatch** so the Vercel failsafe actually contributes.
3. **Wire `scripts/prune-enrichment-log.ts`** to a 30-day retention. First bulk delete must be batched
   manually + VACUUM — 220k rows as a single DELETE will hit a statement timeout. Add a `created_at`
   index first. Reclaims ~45 MB.
4. There is a missing dedup anchor in **two** writers (`api.cron.process-scan-triggers.ts:170` and
   `app/routes/app.gtin-fill.tsx:367-381`) — fix it **before or with** the throughput change, or clearing
   the backlog removes the `skip_already_queued` mask and turns latent re-enqueue churn live.

### Backfill

- Pre-2026-05-20 rows (~85%): **safe to delete outright.** They record "a free-tier store edited a product
  and we did nothing", from a subscription that no longer exists.
- Post-2026-06-11 rows: intact and trustworthy; the same information is derivable from
  `pending_scan_triggers` and `schema_enrichments`.
- Enrichment success/failure history since 2026-05-27: **permanently lost** — the `enriched`/`noop`
  outcomes stopped being emitted and nothing replaced them.

---

## ISSUE 6 — stale shop metadata

**Severity: MEDIUM. Not an ongoing bug — a backfill gap.**

### Root cause

`app/lib/checks/index.server.ts:87-116` is the only production writer of the 12 metadata columns, and it
only runs inside `runComplianceScan`. The feature shipped in `b444795` on **2026-05-14**.

The 18 NULLs decompose exactly:

| Cause | Count |
|---|---|
| Last scan predates the 2026-05-14 feature ship | **14** |
| Never scanned at all | **3** |
| Scanned 2026-05-15, `getShopInfo()` returned null → silent skip | **1** |
| **Total** | **18** |

**Your inference was half right.** "Refresh only happens on scan" is confirmed — but only 3 of 18 never
scanned. The other 15 *did* scan; they just scanned before the code existed.

**Decisive test:** among merchants with NULL metadata, the latest scan of any kind is **2026-05-15**.
Every merchant who has scanned since then has metadata. There is no ongoing failure.

The one edge case (`0yzffh-vw`, scanned 2026-05-15) hit the `if (shopInfo)` guard at `:90`;
`getShopInfo()` swallows all failures and returns `null` (`shopify-api.server.ts:135, 162-165`), and there
is no log at the skip site. Its scan recorded `{"reason":"shop_info_unavailable","skipped":true}`.

**The serverless-freeze hypothesis is not the cause here.** The write is fire-and-forget (`void`), which
is a genuine latent risk, but the data does not show it firing — the population splits cleanly on the
feature ship date.

**Compounding with Issue 3:** 11 of the 18 NULL-metadata merchants are at `scans_remaining = 0`. Since the
only writer is gated behind the quota decrement, **those 11 can never self-heal.** The backfill script is
their only path.

### Blast radius

- Geography, plan-mix and ICP analysis have a 33% hole (18/54).
- `contact_email` missing for outreach on those 18.
- No revenue or funnel metric is affected.

### Fix (smallest first)

1. **Run `scripts/backfill-merchant-shop-info.ts`.** It already walks installed merchants with 250ms
   pacing. **Environment trap:** `tsx` is not in `package.json` and `dotenv` is only transitive — use
   `node --experimental-strip-types` per the repo's other standalone-script convention.
   Its `no_token` tally doubles as a free install-liveness probe for the ghost cohort.
2. Add a log line at the `if (shopInfo)` skip so the silent case is visible.

### Backfill

**Current state: recoverable** for every shop whose offline token still works — which, given the 38
expired legacy sessions, may be a minority. Several of the 18 are internal test stores
(`gmc-bad-test-store`, `all-tests-pass`, `shieldkit-v2-dev`).
**Point-in-time values are permanently lost** for everyone — the schema only ever stored last-known-value.

---

## Severity ranking across all six

| Rank | Issue | Destroying data now? | Blocks critical measurement? | Fix cost | Severity |
|---|---|---|---|---|---|
| 1 | **#2 uninstalls** | **Yes, continuously** — a full merchant record CASCADE-erased 48h after every uninstall. 8 in the last 30 days, ~40 all-time. | **Yes — churn is 100% unmeasurable**, and paid churn is invisible twice over. | Medium (migration + 2 handler edits) | **CRITICAL** |
| 2 | **#1 `installed_at`** | **Yes** — still firing; most recent 2026-07-18; 38 rows queued to re-corrupt. | Yes — kills cohorting and tenure. But fully recoverable from `created_at`. | **Trivial** (delete one line) | **HIGH** |
| 3 | **#5 enrichment / drainer** | No data lost, but a **paying customer's feature is 14 days behind**, and 91% of the DB is unread telemetry with no retention. | Partially — corrupts enrichment/engagement metrics. | Medium (breaks 2 tests) | **HIGH** |
| 4 | **#3 scan metering** | Quietly — the refund fires even when the decrement never ran. 42 merchants permanently locked out. | No — `scans` is a clean ledger. The 3-vs-114 ratio is a non-finding. | Low | **MEDIUM** |
| 5 | **#6 stale metadata** | No | Yes for geo/plan/ICP (33% hole); no for revenue. | Very low (run a script) | **MEDIUM** |
| 6 | **#4 digest** | No — zero rows is the *correct* value. | No | Very low | **LOW** |

**Cross-cutting, ranked above #3–#6, owned by none of the six:** the **Vercel cron GET/405 mismatch**. Two
of three crons have never executed. Two-line fix; restores the only subscription-cancellation detector.

**Ranking rationale.** #2 outranks #1 because it is the only issue where data is *gone* — `installed_at`
is reversible from `created_at`, a CASCADE-deleted merchant is not. #1 outranks #3 despite a cheaper fix
because it is actively corrupting rows today with a wider blast radius. #5 sits high on customer impact
rather than measurement. #4 ranks last precisely because "zero rows" turned out to be correct.

---

## What you actually asked: measuring free-to-paid conversion and churn

### Conversion — measurable today, **no code change required**

Use two sources together. Neither alone is sufficient.

**A. From the DB (survivorship-biased, undercounts by 50%):**

```sql
-- created_at, NOT installed_at.
SELECT date_trunc('month', created_at)::date AS install_month,
       count(*)                                                    AS installs_surviving,
       count(*) FILTER (WHERE subscription_started_at IS NOT NULL)  AS ever_paid
FROM merchants
GROUP BY 1 ORDER BY 1;
-- 2026-07-27: Mar 1/0, Apr 11/0, May 19/1, Jun 11/0, Jul 12/1
```

This finds 1 of your 2 real conversions — it cannot see `cq3dar-gv`, whose row was deleted.

**B. From PostHog (recovers deleted converters) — HogQL:**

```sql
SELECT uniq(distinct_id) AS shops_that_paid,
       arraySort(groupUniqArray(distinct_id)) AS which
FROM events
WHERE event = 'purchase' AND timestamp >= toDateTime('2026-06-27 00:00:00')
-- 2 -> ['cq3dar-gv.myshopify.com','sex-eshop.myshopify.com']
```

**Two mandatory caveats:**
- **`purchase` double-fires.** `app.billing.confirm.tsx` is a *loader*, so any re-GET of the welcome link
  re-fires it. Both converting shops have exactly 2 events ~30s apart. **Always `uniq(distinct_id)`,
  never `count()`.**
- **`install` over-fires on re-auth** — same root cause as Issue 1, same function body
  (`shopify.server.ts:76` and `:97`). 4 of 24 install events are re-auths. De-noise by joining to
  `merchants.created_at`. Conveniently, the two broken sources correct each other.

**Instrumented-cohort conversion rate:** 20 true new installs since 2026-06-27 (12 surviving + 8 deleted),
2 paid → **10%**. Exclude the test store from any paid count.

**Verdict: conversion is trustworthy from 2026-06-27 forward at ±0 error, using A ∪ B.** Before that date
it is survivorship-biased and only the Partner Dashboard can correct it.

### Churn — **not measurable today**, and it needs code

There is no `uninstall` event in PostHog, no surviving `uninstalled_at`, and no cron that detects
cancellation. The best available today is a lower bound with no dates:

```sql
-- Shops that were installed and whose row is now gone.
SELECT date_trunc('month', l.created_at)::date AS month_first_seen,
       count(*) AS confirmed_churned
FROM leads l
LEFT JOIN merchants m ON m.shopify_domain = l.shop_domain
WHERE m.id IS NULL
  AND l.shop_domain LIKE '%.myshopify.com'
  AND l.public_risk_score IS NULL   -- isolates the authenticated install-path writer
GROUP BY 1 ORDER BY 1;
-- 40 rows. Monthly: Mar 1, Apr 6, May 15, Jun 11, Jul 7.
```

It is a lower bound twice over: it misses churned shops that never ran an authenticated scan, and anyone
who uninstalled <48h ago. It gives you no uninstall date and no tenure.

### The minimum fix set

**For conversion: nothing.** It already works.

**For churn: exactly three changes, all required.**

1. **`captureEvent(shop, "uninstall")`** in `webhooks.app.uninstalled.tsx` — one line, ships today, makes
   churn measurable this week.
2. **An append-only `install_events` table with no FK to `merchants`**, written from `afterAuth`, the
   uninstall handler, and `shop/redact` *before* the delete. Without this, every other churn fix is erased
   48h later. **Non-negotiable, and must land before any GDPR fix that prunes `leads`.**
3. **Fix the cron GET/405 mismatch** so `reconcile-subscriptions` runs — otherwise cancel-but-stay-installed
   churn stays invisible even after 1 and 2.

Fixing Issue 1 is **not** required for either metric (it is urgent for its own reasons). Issues 3–6 are
irrelevant to both.

### Trust-from dates

| Metric | Permanently lost | Trustworthy from |
|---|---|---|
| Install dates | Nothing | **Today**, if you use `created_at` |
| Conversion count | Nothing since 2026-06-27; earlier deleted converters need the Partner API | **2026-06-27** |
| Churn count | Shops that churned without ever scanning | **Today** (lower bound, no dates) |
| Churn rate with dates | All uninstall timestamps, all-time, from our systems | Ship date of fixes 1+2 — **or all-time via a Partner API backfill** |
| Tier/scan history of the 40 deleted shops | **Permanently gone** | n/a |

**Do this first, today:** open the Shopify Partner Dashboard install/uninstall chart. It has your true
all-time churn curve, it takes one minute, and it will confirm or refute the ~43% figure independently of
anything in this report.

---

## CLAUDE.md drift found during the audit

- **§3** states `expiringOfflineAccessTokens: true`. It was set to false on 2026-06-26 (`138d4aa`). This is
  the single most load-bearing fact for Issues 1 and 2.
- **§7 / webhook table** states `api.cron.reconcile-installs` writes `uninstalled_at` and deletes sessions.
  It explicitly does **neither** since 2026-06-26 — the file header says so.
- **§15** documents all three Vercel crons as working POST endpoints. Vercel Cron sends GET; two of the
  three have never run.
- **§4** tier distribution (`free=28, monitoring=2, pro=2`) is stale — live is `free=52, monitoring=2,
  pro=0`.
- **§3 webhook table** still lists `themes/update` / `themes/publish` as registered. They were removed from
  `shopify.app.toml`.
- **§5** describes metadata as "opportunistically refreshed every scan" without noting it only applies from
  2026-05-14 forward, and that quota-exhausted merchants can never trigger it.
- **§9** omits three scripts: `prune-enrichment-log.ts`, `purge-free-scan-triggers.ts`,
  `backfill-product-webhooks.ts`.
- The repo contains both `CLAUDE.md` and `claude.md` (case-variant duplicates on a case-insensitive
  filesystem).
