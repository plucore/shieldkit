# ShieldKit Backlog

Tracked items that are intentionally deferred, decisions that should not be re-litigated, and known issues that are accepted as-is. Sorted by category, not priority.

---

## RESOLVED

### Weekly-scan cron timeout on Vercel Hobby *(was: HIGH)*
**Symptom:** `api.cron.weekly-scan.ts` ran all scans sequentially in one Vercel function call. Each scan takes ~10–15s; Vercel Hobby caps function duration at 60s. The cron would abort at ~5 paid merchants, leaving the rest unscanned and their digests empty.

**Resolution:** Split into enqueue + drain. Weekly cron now inserts one `pending_scan_triggers` row per paid merchant (1–3s). A new GitHub Actions workflow (`.github/workflows/process-scan-triggers.yml`) curls `/api/cron/process-scan-triggers` every 5 minutes with `CRON_SECRET` bearer auth; the processor drains one merchant per invocation (BATCH_SIZE=1, ~12s, well under 60s). Daily Vercel cron at 12:00 UTC remains as a safety net.

**Capacity ceiling:** ~288 merchants/day at the current cadence. Beyond that, either tighten GH Actions schedule (best-effort below 5 min) or move to Vercel Pro for sub-daily crons and 300s function ceiling. Documented in CLAUDE.md §15.

**Manual setup performed:** added `CRON_SECRET` to GitHub repo Actions secrets (matches Vercel env var of same name).

---

## DEFERRED

### `/app/billing/confirm` auth bounce *(LOW)*
**Symptom:** When Shopify redirects the merchant back from Managed Pricing to `/app/billing/confirm`, the loader sometimes returns HTTP 302 → `/auth/login`. The merchant sees the login screen briefly before App Bridge re-establishes the session.

**Why deferred:** The `app_subscriptions/update` webhook is the source of truth for billing state and populates `merchants.tier`, `billing_cycle`, `shopify_subscription_id`, `subscription_started_at` correctly within seconds of the merchant accepting the plan. The confirm route is a UX nicety, not a correctness gate. Self-heal in `app/routes/app._index.tsx` loader also reconciles drift on every dashboard render via `billing.check()`.

**Likely fix:** Pass the App Bridge session via the `charge_id` query param on the welcome-link redirect, or move the confirm route to use `unauthenticated.public.appProxy`-style verification instead of `authenticate.admin`. Verify against current `@shopify/shopify-app-react-router` patterns before implementing.

---

## CLEANUP

### Stale `billing_plan` column in live Supabase
Per `CLAUDE.md` §12. Live `merchants` table may still carry both `billing_plan` (stale, unused) and `tier` (canonical). All code paths read `tier`.

**Action:** Run in Supabase SQL editor:
```sql
ALTER TABLE merchants DROP COLUMN IF EXISTS billing_plan;
```
Verify no rows reference `billing_plan` first:
```sql
SELECT count(*) FROM merchants WHERE billing_plan IS NOT NULL;
```

### Supabase project rename *(LOW)*
The Supabase project is currently labeled **"ShieldKit-Dev"** in the dashboard, but it is in fact the production database (project ID `bhnpcirhutczdorkhibm`).

**Action:** Rename to "ShieldKit-Prod" via Supabase dashboard → Project Settings → General. No code changes — the project ID and connection strings stay the same.

---

## POLICY DOCUMENTED — DO NOT CHANGE

### v1 grandfathered merchants
Three merchants are on `tier='pro'` with `shopify_subscription_id IS NULL`:

- `bybaanoo`
- `tbgypsysoul`
- `nngf4r-d0`

**Founder decision:** grandfather in place forever. They were paying v1 customers, the v1 product they paid for has been retired, and the founder elected to leave them on Shield Max indefinitely as a goodwill gesture. **Do not run the billing self-heal logic against these rows.** Do not "fix" the NULL `shopify_subscription_id`. Do not migrate them. They are intentionally irregular.

If a future migration touches `merchants` and would reset these rows, exclude them by domain explicitly.

---

## KNOWN, NO ACTION

### Polaris web component type-gap errors
Per `CLAUDE.md` §11. Props like `submit`, `loading`, `disabled` on `<s-button>` and other Polaris web components work at runtime but are not in the TypeScript type definitions. The codebase uses `@ts-ignore` and conditional spread patterns to work around this.

**Do not auto-fix.** Removing the `@ts-ignore` directives or attempting to add custom typings will either re-introduce TS errors or diverge from the upstream Polaris React Router patterns. Wait for `@shopify/app-bridge-react` to publish updated type defs.
