# ShieldKit — Complete Project Reference

> **This file is committed as lowercase `claude.md`.** `git ls-files` tracks exactly one path,
> `claude.md`; the `CLAUDE.md` you may see locally is the same inode surfaced by macOS's
> case-insensitive filesystem (`core.ignorecase=true`), not a second file. On a case-sensitive
> checkout (Linux CI, a Vercel build container) the uppercase `CLAUDE.md` that agent tooling looks
> for **does not exist**. To rename, `git mv` through a temporary name — a direct
> `git mv claude.md CLAUDE.md` is a no-op under `core.ignorecase`.

_Last rewritten 2026-05-29 from current code + live DB inspection after the v4 pricing overhaul (one paid tier, AI cap, weekly-cron removal, PlanStatusCard, post-fix reassurance) AND the 2026-05-28 cleanup batch (JSON-LD verifier removed; aside card two-state; onboarding 3 steps; PlanStatusCard JSON-LD row display-only; per-page intros; GTIN zero-work feedback; FK cascade for GDPR shop/redact)._

## 1. Project Overview

ShieldKit is a B2B SaaS Shopify Embedded App that scans Shopify stores for Google Merchant Center (GMC) compliance issues and surfaces AI-search visibility tools.

* **Module A (Current):** 12-point automated compliance scanner. Identifies suspension risks and provides plain-English fix instructions.
* **Module B (Future/Hidden):** Automated DMCA Takedown Legal Engine. Deferred indefinitely — placeholder route removed 2026-05-14.

### Pricing — v4 (effective 2026-05-28)

Two plans only. The Partner Dashboard pricing UI advertises only these:

| Plan | Price (LIVE, verified via Partner API 2026-07-28) | DB tier | Plan-name strings (must match Partner Dashboard) |
|------|-------|---------|---|
| **Free** | $0 | `'free'` | `"Free"` — plus localised variants Shopify serves per merchant locale: `"Gratuit"`, `"Gratis"`, `"Grátis"`, `"Gratuito"`, `"Kostenlos"` |
| **Monitoring** | **$29.00 USD/month** | `'monitoring'` | `"Monitoring"` |

> **⚠️ `plans.ts` PRICE CONSTANTS ARE WRONG — verified 2026-07-28.** Every real
> `SUBSCRIPTION_CHARGE_ACTIVATED` for a Monitoring plan in the Partner API bills
> **$29.00**: `cq3dar-gv` (2026-07-07), `sex-eshop` (2026-07-12), `9973f3-3` /
> Wanok (2026-07-25). `app/lib/billing/plans.ts:81` declares `monthly: 49` and
> `:90` declares `annual: 390`. Neither figure has ever matched a real charge.
> Observed price history: **$39 → $29** somewhere between 2026-06-17
> (`hbhkfy-gy` @ 39.0) and 2026-07-07 (`cq3dar-gv` @ 29.0). The only annual
> charge ever seen is `"Monitoring Annual"` @ **$290.00** (`ygxib5-9s`,
> 2026-05-18), not $390.
>
> **Why this is not cosmetic:** `cycleFromChargeAmount()` (`plans.ts:196-208`)
> resolves billing_cycle by matching the charge amount against
> `TIER_PRICE_POINTS`. With monthly pinned at 49 and annual at 390, a real
> $29 charge matches NEITHER and the function returns `null`; the caller then
> falls back to `PLAN_NAME_TO_CYCLE`, which maps bare `"Monitoring"` → monthly.
> So monthly happens to resolve correctly **by accident**. A future annual
> subscriber on the collapsed single-name plan would resolve to `monthly`,
> silently, because the amount can no longer discriminate. Fix the constants
> before selling annual again.
>
> **`sex-eshop` is NOT grandfathered** — they pay $29.00, the same as the current
> price. There is no grandfathered paying merchant: every `pro`/`shield`-tier row
> is gone (see the tier distribution below).

**Lifetime revenue, Partner API `transactions`, 2026-07-28: $300.00 gross / $290.24 net across 10 transactions.**
- **3 × `AppOneTimeSale` @ $29.00 → $28.16 net each = $84.48.** This is the "all-time one-time charges" figure in the Partner Dashboard: `nngf4r-d0` (2026-04-15), `bybaanoo` (2026-04-25), `tbgypsysoul` (2026-05-04). They date from the one-time-$29 billing model shipped in `374dc39` (2026-03-31) and removed by the Managed Pricing migration `68bf618` (2026-05-09). **Nothing in the current codebase can create a one-time charge** — do not look for a bug here. This also explains why those merchants carry paid-feature residue (`generated_policies`, `schema_enrichments`) while sitting at `tier='free'`.
- 7 × `AppSubscriptionSale`: $39 × 4, $14 × 2, $29 × 1.
- **`cq3dar-gv` was a REAL paying customer**, not a test store: `test: false` on the charge AND a settled `AppSubscriptionSale` of $29.00 → $28.16 net on 2026-07-16. They activated 2026-07-07 and cancelled 2026-07-13. An earlier audit note in this repo guessed 5–10% likely-real; that guess was wrong and is retracted.
- `sex-eshop` and Wanok have **no settled transaction yet** — their first cycles had not paid out as of 2026-07-28.

**Free tier** — one compliance scan, granted at install via DB DEFAULT, **never refilled**. No monthly reset cron exists in v4. JSON-LD product schema theme extension + step-by-step fix instructions for whatever the first scan finds.

**Monitoring** — the single paid tier. Unlocks everything:
- Unlimited on-demand scans (`scans_remaining = null`)
- AI-written store policies (refund, shipping, privacy, terms) with self-consistency validator + monthly cap
- GMC re-review appeal letter generator
- Bulk + ongoing GTIN/MPN/brand fill (existing catalog + per-product webhook enrichment)
- Auto structured data for new products via theme extension blocks
- llms.txt at `/apps/llms-txt` for AI search visibility
- AI crawler allow/block controls (`/app/bots/toggle`)
- Store schema settings — logo, social URLs, search URL template (`/app/pro-settings`)
- Organization & WebSite JSON-LD theme blocks

**Grandfathered / legacy tiers** (CHECK constraint values kept so existing subscriptions reconcile; NOT offered to new merchants):
- `tier='pro'` — old "Shield Max" ($39/mo or $390/yr). 2 live rows on 2026-05-29. Resolves as paid via `hasPaidAccess`.
- `tier='shield'` — old "Shield Pro" ($14/mo or $140/yr). 0 live rows. `hasPaidAccess` returns false — graceful degrade to free-level access without forced demotion.
- `tier='recovery'` — pre-v4 Recovery plan. 0 live rows. Treated as paid via `hasPaidAccess`.

**Live tier distribution 2026-07-28:** `free=52, monitoring=2, pro=0`. (Was `free=28, monitoring=2, pro=2` on 2026-05-29.) The two `pro` rows were `0yzffh-vw` and `sbnjen-ee` — both demoted; `0yzffh-vw` **wrongly**, on a FROZEN event (§4a).

**Do NOT read the tier counts as MRR — they are wrong in both directions:**
- One of the two `monitoring` rows is `shieldkit-test-stor.myshopify.com`, the founder's own dev store. Its charges are all `test: true` and it has `shopify_subscription_id IS NULL`, so `reconcile-subscriptions` can never demote it — a permanent phantom.
- `9973f3-3.myshopify.com` (Wanok Cosmetics, HK) holds an **ACTIVE $29.00 Monitoring subscription in Shopify** (charge `67847094487`, activated 2026-07-25 12:39:20, no cancellation) while sitting at `tier='free'` in this DB. See §4a.

**True position 2026-07-28: 2 real paying merchants (`sex-eshop`, Wanok @ $29 each = $58 MRR), of which one is not being served what they pay for.** The DB reports 2 paid but has the wrong two.

**Source of truth for tier access:** `app/lib/billing/plans.ts`:
- `hasPaidAccess(tier)` → true when tier ∈ `{ 'monitoring', 'recovery', 'pro' }` (single gate; replaces v3's `hasMonitoringAccess` / `hasRecoveryAccess`).
- `PAID_TIERS = ['monitoring','recovery','pro']` — centralised set used by cron queries and tier-filter code.
- `PAID_FEATURES` / `FREE_FEATURES` — canonical feature lists used by the dashboard `PlanStatusCard`.

**Never compare `merchants.tier` to a literal string at a feature-gate call site.** Always route through `hasPaidAccess(tier)`. Remaining literal comparisons are sentinel "is this free or not" checks for upgrade-CTA placement and webhook-payload validation only.

**Prices are NOT rendered in-app (2026-07).** The dashboard (`PlanStatusCard` + upgrade banners) and the Terms page show no dollar figure — the live price is displayed only on Shopify's hosted managed-pricing page (the single source of truth, editable in the Partner Dashboard) after click-through. The `PLANS.*.monthly` / `PLANS.*.annual` constants are retained for billing reconciliation only, never for display. The public marketing landing page (`_index/route.tsx`) still shows prices — deliberately left out of scope for the in-app removal.

---

## 2. Architecture & Tech Stack

### Framework & Runtime
* **React Router v7** with file-based routing via `@react-router/fs-routes`.
* **React 18.3**, **Vite 6.3**.
* **Node.js** `>=20.19 <22 || >=22.12`.
* **TypeScript** ^5.9.3, strict mode.

### Hosting & Deployment
* **Vercel** at `shieldkit.vercel.app`. **Tier: Hobby.** Load-bearing — Hobby caps function duration at 60s, so heavy work is split.
* `vercel.json` defines **3 Vercel Cron jobs** (down from 7 pre-v4). Lowest-frequency-allowed slot on Hobby is daily.
* `react-router.config.ts` uses the `@vercel/react-router` preset.
* `npm run build` → `react-router build`. `npm start` → `react-router-serve ./build/server/index.js`.

### Key Dependencies (production)
| Package | Version | Purpose |
|---------|---------|---------|
| `@shopify/app-bridge-react` | ^4.2.4 | Embedded app shell, toast, navigation |
| `@shopify/shopify-app-react-router` | ^1.1.0 | Auth, billing, webhooks, session management |
| `@supabase/supabase-js` | ^2.47.0 | Postgres client (service role) |
| `cheerio` | ^1.2.0 | Server-side HTML parsing for compliance checks |
| `@anthropic-ai/sdk` | ^0.85.0 | AI policy + appeal-letter (model `claude-sonnet-4-6`) |
| `@sentry/node`, `@sentry/react` | ^10.54.0 | Server-side observability (`@sentry/react` currently dormant; init no-ops when `SENTRY_DSN` unset) |
| `isbot` | ^5.1.31 | Bot detection for streaming SSR |
| `dompurify` | ^3.3.3 | Client-side sanitization for AI-generated policy display |
| `sanitize-html` | ^2.13.0 | Server-side sanitization for AI-generated policy storage (replaced `isomorphic-dompurify` 2026-05-21 to drop `jsdom`) |

### Removed v4
- `resend` and the entire `app/lib/emails/` directory (weekly-digest sender retired).
- `app/components/UpgradeCard.tsx` (replaced by `PlanStatusCard`).
- `app/routes/api.cron.monthly-reset.ts`, `api.cron.weekly-scan.ts`, `api.cron.weekly-digest.ts` (weekly cadence dropped).

### Removed 2026-05-28 cleanup batch
- `app/lib/json-ld-verifier.server.ts` (storefront-fetch verifier produced false negatives for password-protected stores).
- `app/routes/api.cron.verify-json-ld.ts` (cron + handler).

### Folder Structure
```
app/
  routes/                # ~33 RR7 routes
  components/
    AIVisibilityCard.tsx, AuditChecklist.tsx, KpiCards.tsx,
    PlanStatusCard.tsx, PolicyGenerationCard.tsx,
    ScanProgressIndicator.tsx, ScoreBanner.tsx, ScoreTrend.tsx,
    SecurityStatusAside.tsx
    marketing/           # Landing/blog/fix-page UI
  hooks/
    useWebComponentClick.ts    (native DOM events for Polaris web components)
  lib/                    # Server-only business logic
    checks/               # 12 compliance check modules + orchestrator + shared regex constants
      shared/             # html-detectors.server.ts — pure HTML-only detectors for contact/checkout/json-ld, shared by all 3 scan surfaces
    billing/
      plans.ts             (PLANS, PLAN_NAME_TO_TIER, PLAN_NAME_TO_CYCLE,
                            hasPaidAccess, PAID_TIERS, PAID_FEATURES,
                            FREE_FEATURES, TIER_GROUPS, getManagedPricingUrl)
      partner-api.server.ts
    llm/
      appeal-letter.server.ts
    enrichment/
      gtin-enrichment.server.ts
    ai-visibility/
      identify-crawler.server.ts / identify-crawler.ts
    ai-usage.server.ts             (AI_MONTHLY_CAP + checkAndConsumeAiCredit
                                    + windowResetIso)
    policy-validator.server.ts     (validateGeneratedPolicy — shares regex
                                    constants with checks/constants.ts)
    compliance-scanner.server.ts   (barrel re-export from checks/)
    graphql-queries.server.ts, graphql-client.server.ts, shopify-api.server.ts
    policy-generator.server.ts     (Anthropic-powered)
    session-storage.server.ts      (custom Supabase session adapter)
    crypto.server.ts               (AES-256-GCM)
    rate-limiter.server.ts
    json-ld-deep-link.ts           (getJsonLdThemeEditorUrl helper — takes
                                    apiKey as third arg, threaded from loader)
    sentry.server.ts
    types.ts                       (Merchant, Scan, CheckResult, ApiScanResponse)
    constants.ts, scan-helpers.ts, blog.ts, brand.ts
  shopify.server.ts        # Shopify app config, afterAuth hook
  supabase.server.ts       # Supabase client singleton (service-role)
  root.tsx, entry.server.tsx, routes.ts, globals.d.ts, styles.css
scripts/
  outbound-scanner.ts                # Standalone CLI scanner
  backfill-merchant-shop-info.ts     # One-off merchant metadata refresh
  cleanup-orphan-webhooks.ts         # Deletes orphan dev-tunnel subscriptions
  dev-cleanup-subs.ts                # Dev: cancel test subscriptions
  top-criticals.ts                   # Ops query
  validate-partner-api.ts            # Partner-API smoke test
supabase/
  schema.sql           # Cumulative bootstrap snapshot
  migrations/          # Numbered — source of truth for ordering
extensions/
  json-ld-schema/      # Theme extension: Product/Organization/WebSite JSON-LD blocks
tests/                 # Vitest regression suites (14 files, 329 tests on 2026-07-09)
```

---

## 3. Shopify Integration

### App Configuration (`shopify.app.toml`)
* **client_id:** `071fc51ee1ef7f358cdaed5f95922498`
* **embedded:** true
* **application_url:** `https://shieldkit.vercel.app`
* **`automatically_update_urls_on_dev = false`** (prevents dev tunnel from overwriting production webhook URLs)
* **Webhooks API version:** `2026-04`
* **Access scopes (8):** `read_products,read_content,read_legal_policies,write_products,read_shipping,read_locations,read_themes,write_themes`
* **Auth redirect URLs:** `/auth/callback`, `/auth/shopify/callback`, `/api/auth/callback` (all under `shieldkit.vercel.app`)
* **Distribution:** AppStore
* **App Proxy:** `[app_proxy]` registers `/apps/llms-txt` → `/api/proxy/llms-txt`

### App Bridge & Auth (`app/shopify.server.ts`)
* **API Version:** `ApiVersion.October25` (Shopify Admin API `2025-10`)
* **Runtime scopes:** `process.env.SCOPES ?? "read_products,read_content,read_legal_policies"`. Production `SCOPES` is set to the full 8.
* **Session storage:** Custom `SupabaseSessionStorage` (`app/lib/session-storage.server.ts`).
* **Token rotation:** `expiringOfflineAccessTokens` is **OFF** (removed 2026-06-26, commit `138d4aa`). Offline tokens are deliberately LONG-LIVED — ShieldKit is background-heavy (crons, webhooks, enrichment) and those paths have no request context in which to run the token exchange, so expiring tokens killed 42/43 installs' background work ~24h after install. Tokens are still encrypted at rest. **Do not re-enable this flag** — see the comment block at `app/shopify.server.ts:28-38`.
* **Legacy session cohort (as of 2026-07-28):** 38 of 54 `sessions` rows still carry a non-null `expires` from the flag era; all are expired. Those merchants' stored tokens return HTTP 401 to every background call and only recover if the merchant reopens the embedded app (which mints a modern non-expiring token). A 401 for one of these shops is **not** evidence of uninstall.
* **afterAuth hook:** offline sessions only. Upserts the `merchants` row touching ONLY `shopify_domain`, `access_token_encrypted`, `installed_at`, `uninstalled_at`. **`scans_remaining` is intentionally NOT in the payload** — first install gets `1` via DB DEFAULT; reinstall of a soft-deleted row preserves the existing value (typically `0` post-scan). This prevents free-scan farming via uninstall/reinstall loops. Loud regression test in `tests/bug-fixes.test.ts` asserts the payload never grows to include `scans_remaining`.
* **authenticate.admin(request):** Validates App Bridge 4.x JWT on every `/app/*` route.
* **No `billing` config registered.** Managed Pricing — plan registry lives in the Partner Dashboard.

### Webhook Subscriptions
All use `authenticate.webhook(request)` which verifies `X-Shopify-Hmac-Sha256`.

| Topic | Route File | Behaviour |
|-------|-----------|-----------|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Fires `captureEvent(shop, "uninstall", { tier })` FIRST (PostHog is the only churn record that outlives the merchant — see below), then deletes sessions and soft-deletes the merchant. Inserts a `webhook_failures` audit row on Supabase write failure. Always 200. **`reconcile-installs` is NOT a safety net for this** — it never writes `uninstalled_at` (see §7). |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Updates session scope string. |
| `app_subscriptions/update` | `webhooks.app_subscriptions.update.tsx` | Pre-April-28 supplementary reconciliation path. Maps plan name → tier + billing_cycle. **🔴 CONTAINS AN ACTIVE ENTITLEMENT-DESTROYING BUG — see §4a below. Do not treat this handler as safe.** |
| `products/create`, `products/update` | `webhooks.products.update.tsx` | HMAC + merchant lookup. For paid tiers with `write_products` granted: enqueues a `pending_scan_triggers` row (`trigger_type='enrichment'`, payload `{ product_gid, numeric_product_id }`, dedup'd against `schema_enrichments` and the queue). Returns 200 in <1s. |
| ~~`themes/update`, `themes/publish`~~ | — | **REMOVED from `shopify.app.toml` entirely** (commit `288329f`, 2026-06-11). The v4 handler was a pure no-op. Webhook topics are not part of App Store scope review, so dropping them was churn-free. Earlier revisions of this file said they were "kept registered" — that is stale. |
| `customers/data_request` | `webhooks.customers.data_request.tsx` | GDPR. Logs and 200. |
| `customers/redact` | `webhooks.customers.redact.tsx` | GDPR. 200 (no customer PII stored). |
| `shop/redact` | `webhooks.shop.redact.tsx` | GDPR. Hard-deletes merchant row 48h post-uninstall. **All 7 child FKs now CASCADE** after migration `20260528160000_cascade_fks_for_shop_redact.sql` — previously 3 FKs (`enrichment_webhook_log`, `llms_txt_requests`, `pending_scan_triggers`) were `NO ACTION` and silently broke the redact for any merchant who had ever triggered enrichment/llms.txt/scan-trigger queueing. Shopify does NOT retry GDPR redact webhooks on 5xx, so the silent failure was a real GDPR exposure. |

### Billing — Shopify Managed Pricing

Plans defined in the **Partner Dashboard** listing UI, not in code. No `billing` config registered on `shopifyApp({...})`; no `billing.request()` / `billing.cancel()` calls anywhere. Pick-a-plan, switch, and cancel all hosted on `admin.shopify.com`.

**Plan-name strings (must match Partner Dashboard exactly):**

Current offerings:
| Name | Price | DB tier | billing_cycle |
|------|-------|---------|---------------|
| `Monitoring` | $49/mo | `monitoring` | `monthly` |
| `Monitoring Annual` | $449/yr | `monitoring` | `annual` |

Grandfathered (not offered to new merchants; kept for reconciliation):
| Name | Price | DB tier | billing_cycle |
|------|-------|---------|---------------|
| `Shield Pro` | $14/mo | `shield` | `monthly` |
| `Shield Pro Annual` | $140/yr | `shield` | `annual` |
| `Shield Max` | $39/mo | `pro` | `monthly` |
| `Shield Max Annual` | $390/yr | `pro` | `annual` |

**Billing flow:**
1. Merchant clicks an upgrade button → navigates to `/app/upgrade` or `/app/plan-switcher`.
2. The route is a loader + component that returns the managed-pricing URL via `getManagedPricingUrl(session.shop)` and `useEffect`s `window.open(url, "_top")` to escape the embedded iframe (Shopify admin sends `X-Frame-Options: DENY`, so a server-side `redirect()` cannot navigate the parent window). Fallback link for popup-blocker cases.
3. Merchant picks/switches/cancels on Shopify's hosted page.
4. Welcome link redirects back to `${SHOPIFY_APP_URL}/app/billing/confirm`.
5. `app.billing.confirm.tsx` loader calls `getActiveSubscriptionByChargeId(charge_id)` (Partner API — only path; legacy `billing.check()` fallback removed in v3 Fix 1):
   - `active` (+ paid tier) → write tier, billing_cycle, subscription_started_at, shopify_subscription_id, scans_remaining=null → redirect `/app`.
   - `cancelled` / `declined` / `expired` → redirect `/app?billing=cancelled`.
   - `unknown` / `pending` / `frozen` / missing `charge_id` → render "Confirming your subscription…" pending page with a Refresh button. **Never demote on uncertainty.**
6. `APP_SUBSCRIPTIONS_UPDATE` webhook is the backstop pre-April-28 channel.
7. `reconcile-subscriptions` cron (daily 04:00 UTC) walks paid merchants post-April-28 and demotes on terminal Partner-API status.

**Dashboard billing self-heal:** Partner-API reconciliation runs as a post-mount action (`selfHealBilling`) fired from `useEffect`, not in the loader. Once-only `useRef` guard; skipped for free tier. On `healed=true` the component calls `revalidator.revalidate()`. `app.billing.confirm.tsx` keeps inline self-heal because that path is post-approval where a 1–2s wait is acceptable.

`getManagedPricingUrl` throws loudly if `SHOPIFY_APP_HANDLE` is unset.

**Paid features** (gated via `hasPaidAccess`):
- Unlimited re-scans (`scans_remaining = null`)
- AI-written policies (Anthropic `claude-sonnet-4-6`) with self-consistency validator + monthly cap (12/window)
- GMC re-review appeal letter generator (`/app/appeal-letter`), same monthly cap pool
- Bulk GTIN/MPN/brand fill (`/app/gtin-fill`) when `WRITE_METAFIELDS_SCOPE_ENABLED`
- Ongoing per-product enrichment via webhook → queue drainer
- llms.txt App Proxy at `/apps/llms-txt`
- AI bot allow/block toggle (`/app/bots/toggle`)
- Store schema settings (`/app/pro-settings`)
- Organization & WebSite JSON-LD theme blocks
- AI-visibility tracking surfaced via `AIVisibilityCard`

**Free tier:** one scan, no refill. `scans_remaining` starts at `1` (DB DEFAULT) and stays at `0` after use until upgrade.

---

## 4. Database Schema (Supabase)

Project ref: `bhnpcirhutczdorkhibm`. The Supabase project is named "ShieldKit-Dev" in the dashboard but **is the live production database** — single-project setup, real merchants and paying customers.

All tables have RLS enabled; the app uses the `service_role` key which bypasses RLS. Live shape verified 2026-05-29.

### Migrations on live DB (most recent first)
- `20260729???` `catalog_reconcile_state` (Block 4 — per-shop walk cursor; applied 2026-07-29)
- `20260728175811` `install_events` (§4b — the FK-free churn ledger; applied and wired 2026-07-28)
- `20260712125011` `atomic_generation_caps_finalize_regen` (SHIELDKIT-2 — `finalize_policy_regen`)
- `20260712120144` `atomic_generation_caps` (SHIELDKIT-2 — `insert_appeal_letter_if_under_cap`)
- `20260710114046` `audit_rate_limit_rpc`
- `20260604065950` `0004_expiring_offline_tokens` (the flag era; flag itself removed 2026-06-26 — see §3)
- `20260601150914` `grant_service_role_aeo`
- `20260601060729` `0002_takedown_and_views`
- `20260601060535` `0001_aeo_schema`
- `20260528114108` `cascade_fks_for_shop_redact` (cleanup batch §8 — 3 child FKs to `merchants` cascade)
- `20260528082329` `ai_usage_cap` (v4 §5 — `ai_generations_used`, `ai_generations_reset_at`, `consume_ai_credit()` RPC)
- `20260528044014` `enrichment_triggers` (v3 sweep Fix 9)
- `20260528044004` `pending_scan_triggers_idempotency` (Fix 8)
- `20260528043953` `webhook_failures` (Fix 4)
- `20260528043940` `json_ld_verification` (v3 Fix 3 — columns added; v4 cleanup batch §1 DEPRECATED them but did not drop)
- `20260514150228` `widen_tier_for_v3_pricing` (tier CHECK widened to include `monitoring,recovery`)
- `20260511141953` `add_merchant_shop_metadata`
- `20260506024035` `phase_7_quick_wins_and_monitoring`

Local migration files in `supabase/migrations/` are timestamped `20260527192823..20260728120000`; Supabase reassigns versions on push (the local `install_events` file is dated `20260728120000`, the live version is `20260728175811`).

> The three `aeo`/`takedown` migrations created **no objects in the `public` schema** — a live inventory on 2026-07-28 returned exactly the 14 tables documented below and no views. Treat them as inert history, not as undocumented tables.

### Table: `sessions`
Shopify OAuth session storage. Custom `SupabaseSessionStorage` adapter.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Session ID from Shopify |
| `shop` | TEXT NOT NULL | |
| `state` | TEXT NOT NULL | |
| `is_online` | BOOLEAN DEFAULT false | |
| `scope` | TEXT | |
| `expires` | TIMESTAMPTZ | |
| `access_token` | TEXT DEFAULT '' | **Encrypted** (AES-256-GCM) |
| `user_id` | BIGINT | |
| `first_name`, `last_name`, `email` | TEXT | |
| `account_owner` | BOOLEAN | |
| `locale`, `collaborator`, `email_verified` | TEXT / BOOLEAN | |
| `refresh_token` | TEXT | **Encrypted** |
| `refresh_token_expires` | TIMESTAMPTZ | |

Index: `idx_sessions_shop`.

### Table: `merchants`
One row per installed shop. Soft-deleted on uninstall; hard-deleted by `shop/redact` 48h later.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK `gen_random_uuid()` | |
| `shopify_domain` | TEXT NOT NULL UNIQUE | |
| `access_token_encrypted` | TEXT | AES-256-GCM-encrypted offline token |
| `tier` | TEXT NOT NULL DEFAULT 'free' | CHECK `('free','shield','pro','monitoring','recovery')` |
| `scans_remaining` | INTEGER (nullable) DEFAULT 1 | `null` = unlimited (paid); `0` = exhausted; `n>0` = available. **Never auto-refills in v4** — monthly-reset cron retired. |
| `scans_reset_at` | TIMESTAMPTZ DEFAULT now() | Dormant in v4 — no code path writes to it post-monthly-reset deletion. |
| `billing_cycle` | TEXT | CHECK `('monthly','annual')`. NULL on free. |
| `subscription_started_at` | TIMESTAMPTZ | NULL on free. |
| `shopify_subscription_id` | TEXT | GraphQL gid of the active subscription |
| `pro_settings` | JSONB DEFAULT '{}'::jsonb | Paid-tier settings (column name predates v3 rebrand). Holds `logo_url`, `support_email`, social URLs, `search_url_template`, `bot_preferences` (`Record<botId, "allow"\|"block">`) |
| `json_ld_enabled` | BOOLEAN DEFAULT false | **v4 two-state flag** — flips `true` the moment the merchant clicks Enable. The compliance scan's `structured_data_json_ld` check is the authoritative source for whether the block is actually rendering on the storefront. |
| `json_ld_enable_clicked_at` | TIMESTAMPTZ | **DEPRECATED (v4 cleanup §1)** — no code reads or writes. Kept in DB (drop is riskier than leaving). |
| `json_ld_verified_at` | TIMESTAMPTZ | **DEPRECATED (v4 cleanup §1)** — no code reads or writes. |
| `json_ld_verification_attempts` | INT NOT NULL DEFAULT 0 | **DEPRECATED (v4 cleanup §1)** — no code reads or writes. |
| `generated_policies` | JSONB DEFAULT '{}'::jsonb | `{ refund?, shipping?, privacy?, terms? }` from AI generator |
| `policy_regen_used` | JSONB DEFAULT '{}'::jsonb | One regen per policy type (initial + 1 regen). The regen slot is claimed atomically by the `finalize_policy_regen` RPC (SHIELDKIT-2), which sets this flag and writes the new body in one UPDATE. |
| `ai_generations_used` | INT NOT NULL DEFAULT 0 | v4 — counter for the shared monthly AI cap (policies + appeal letters) |
| `ai_generations_reset_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | v4 — start of the current 30-day window |
| `review_prompted` | BOOLEAN DEFAULT false | Set true when merchant dismisses review banner |
| `llms_txt_last_served_at` | TIMESTAMPTZ | Updated fire-and-forget from `api.proxy.llms-txt.ts` on every response |
| `shop_name` | TEXT | Shopify metadata. Refreshed opportunistically inside `runComplianceScan` — but **only since 2026-05-14** (commit `b444795`), and the write is skipped silently when `getShopInfo()` returns null. 18 of 54 rows are NULL: 14 last scanned before the feature shipped, 3 never scanned, 1 hit the silent skip. **11 of those 18 sit at `scans_remaining = 0`, so they can never self-heal** — the only writer is gated behind the quota decrement. `scripts/backfill-merchant-shop-info.ts` is their only path. |
| `shop_owner_name`, `contact_email` | TEXT | |
| `country`, `province`, `city` | TEXT | From `shop.billingAddress` |
| `currency_code`, `shopify_plan`, `primary_domain` | TEXT | |
| `shop_created_at` | TIMESTAMPTZ | |
| `iana_timezone` | TEXT | |
| `shop_metadata_refreshed_at` | TIMESTAMPTZ | |
| `installed_at` | TIMESTAMPTZ DEFAULT now() | |
| `uninstalled_at` | TIMESTAMPTZ | Soft-delete marker |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

RLS Policy: `merchants_shop_isolation` (`shopify_domain = current_setting('app.current_shop', true)`).

CASCADE map after the 2026-05-28 cleanup batch §8 — deleting a merchant cascades to **all** child rows:
`merchants → appeal_letters, digest_emails, enrichment_webhook_log, llms_txt_requests, pending_scan_triggers, scans → violations, schema_enrichments`. (All 7 child FKs verified `CASCADE` on live DB 2026-05-29.)

### Function: `decrement_scan_quota(p_merchant_id UUID)`
Atomic decrement; returns `(new_scans_remaining INTEGER)` or no rows when quota already 0 / NULL. Both scan entry points call it before running the scan.

### Function: `consume_ai_credit(p_merchant_id UUID, p_cap INT)` (v4)
Atomic CASE-branching UPDATE. Resets the 30-day window if `ai_generations_reset_at` is older than the window; otherwise increments `ai_generations_used`. Returns the new used count + the window-reset timestamp. Wrapper `checkAndConsumeAiCredit` in `app/lib/ai-usage.server.ts` handles the RPC call with a non-atomic fallback path for when the RPC isn't present.

### Function: `insert_appeal_letter_if_under_cap(p_merchant_id UUID, p_scan_id UUID, p_cap INT)` (SHIELDKIT-2)
Atomic per-scan appeal-letter cap. `RETURNS TABLE(accepted BOOLEAN, letter_id UUID, used_count INT)`. Takes a per-scan `pg_advisory_xact_lock(hashtext(p_scan_id::text))`, first reclaims abandoned reservations (`generated_letter IS NULL AND created_at < now() - INTERVAL '10 minutes'`), counts the scan's rows, and **reserves** a placeholder row (`generated_letter` NULL) returning its id only when `count < p_cap` — otherwise returns `accepted=false` with no insert. **Reserve → finalize lifecycle:** `app/routes/app.appeal-letter.tsx` calls `reserveAppealSlot` FIRST, then on success fills the row via `finalizeAppealSlot`, or deletes it via `releaseAppealSlot` on any failure path. Wrapper + non-atomic fallback in `app/lib/appeal-letters.server.ts`. Replaced the pre-SHIELDKIT-2 non-atomic count-then-insert (a TOCTOU that generated 5 letters for one scan under concurrent submits).

### Function: `finalize_policy_regen(p_merchant_id UUID, p_type TEXT, p_body TEXT)` (SHIELDKIT-2)
Atomic per-type policy regeneration cap. `RETURNS TABLE(claimed BOOLEAN)`. A single conditional `UPDATE` that **both** writes `generated_policies[p_type] = p_body` AND flips `policy_regen_used[p_type] = true`, guarded by `WHERE regen not yet used AND a base policy exists` — returns one row when claimed, zero rows when another regen already won (the loser is rejected, its output discarded). Called AFTER generation (**claim-after**), so a crash before it leaves the regen unspent and two concurrent regens can't both win. Replaced an earlier claim-before pair (`claim_policy_regen` / `release_policy_regen`, now dropped).

### §4b. Why `install_events` is FK-free

See the §11 doctrine bullet "Churn must never be stored only on the `merchants` row" and the header of `supabase/migrations/20260728120000_install_events.sql`. Short version: all 7 pre-existing child tables declare `REFERENCES merchants(id) ON DELETE CASCADE`, which is precisely why not one of them survived to record any churn. A future "schema tidy-up" migration adding an FK to `install_events` would silently destroy the history on the next redact. The standing check is `SELECT conname FROM pg_constraint WHERE conrelid='install_events'::regclass AND contype='f'` — it must always return zero rows.

### §4a. 🔴 OPEN BUG: `app_subscriptions/update` demotes on a SUPERSEDED subscription id

Found 2026-07-28 investigating a paying merchant who lost entitlement. **Not yet fixed.**

`webhooks.app_subscriptions.update.tsx:136-147` applies its demote-to-free payload with
`.eq("shopify_domain", shop)` and **no check that the payload's `admin_graphql_api_id` matches the
`shopify_subscription_id` currently stored on the row.** Any terminal-status event for *any*
subscription that shop has ever had will strip a live, paying entitlement.

Shopify's Managed Pricing supersedes a plan by cancelling the old subscription and activating the new
one **in the same second**. Partner API events for `9973f3-3.myshopify.com` (Wanok Cosmetics):

```
12:36:12  SUBSCRIPTION_CHARGE_ACTIVATED  charge 67847061719  "Free"        0.00 USD
12:39:20  SUBSCRIPTION_CHARGE_ACTIVATED  charge 67847094487  "Monitoring"  29.00 USD   <- the upgrade
12:39:20  SUBSCRIPTION_CHARGE_CANCELED   charge 67847061719  "Free"        0.00 USD    <- kills it
```

The CANCELED for the superseded **Free** charge processed last and demoted them at
`scans_reset_at = 12:39:22.64`. There is no cancellation for the Monitoring charge — it is still active.

**Second defect in the same handler: `FROZEN` is in `TERMINAL_STATUSES` (`:76-81`).** A freeze is a
recoverable payment/shop state, not a cancellation, and Shopify emits `SUBSCRIPTION_CHARGE_UNFROZEN`
when it clears — which this handler does not handle at all. Confirmed victims: `0yzffh-vw` (FROZEN
2026-06-02, never unfrozen, demoted) and `ygxib5-9s` (FROZEN 2026-06-15 on a $290 Monitoring Annual,
demoted). `sbnjen-ee` was demoted on FROZEN 2026-06-08 and silently under-entitled until UNFROZEN on
2026-06-12.

**The forensic signature of a demotion** — useful because nothing logs it: `scans_reset_at` materially
later than `created_at`. Only two code paths write that column (this handler and
`reconcile-subscriptions:153`), **plus** the deleted `api.cron.monthly-reset.ts` which bulk-wrote it
until `7adea09` (2026-05-28). So clustered identical timestamps before 2026-05-28 are monthly resets,
**not** demotions; isolated timestamps after it are demotions.

**Neither automated path can self-heal any of this.** `reconcile-subscriptions` filters on
`.not("shopify_subscription_id", "is", null)` — and the demote payload NULLs that very column, so a
wrongly-demoted merchant is permanently invisible to the only job that could restore them. Verified:
the reconciler's first-ever real run on 2026-07-28 checked exactly 1 merchant.

### Table: `leads`
Lead collection for retargeting; one row per shop.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT NOT NULL PK | Live shape (drift vs `supabase/schema.sql` which still says UUID) |
| `shop_domain` | TEXT NOT NULL UNIQUE | |
| `email` | TEXT (nullable) | Live shape allows NULL — schema.sql claims NOT NULL |
| `public_risk_score` | INT (nullable) | |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### Table: `scans`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | |
| `scan_type` | TEXT DEFAULT 'manual' | CHECK `('manual','automated')` |
| `compliance_score` | NUMERIC(5,2) | 0–100 |
| `total_checks`, `passed_checks` | INTEGER | |
| `critical_count`, `warning_count`, `info_count` | INTEGER | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

### Table: `violations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `scan_id` | UUID FK → scans(id) ON DELETE CASCADE | |
| `check_name` | TEXT NOT NULL | |
| `passed` | BOOLEAN DEFAULT false | |
| `severity` | TEXT | CHECK `('critical','warning','info','error')` |
| `title`, `description`, `fix_instruction` | TEXT | |
| `raw_data` | JSONB | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Index: `idx_violations_scan_id`, `idx_violations_raw_data` (GIN).

### Table: `scan_rate_limits`
Persistent rate limiting for scan API requests.

### Table: `digest_emails` (DORMANT v4)
Audit log of weekly digest sends. Table retained but no code writes to it since the weekly-digest cron was deleted. Kept to preserve historical data; a future cleanup migration may drop.

### Table: `appeal_letters`
GMC re-review appeal letter generations. Capped at 3 per `scan_id`, enforced atomically by the `insert_appeal_letter_if_under_cap` RPC (SHIELDKIT-2). A row is first **reserved** as a placeholder (`generated_letter` NULL) then **finalized** with the letter, or deleted on failure — so an in-flight/abandoned reservation is a NULL-letter row. The RPC counts reservations for enforcement (and reclaims ones older than 10 min); the dashboard loader's cap-count and saved-letter list **exclude** in-flight reservations (`.not("generated_letter", "is", null)`) so a crash-leaked reservation can't render as an empty card or self-lock the Generate button. Paid-only feature.

### Table: `schema_enrichments`
GTIN/MPN/brand enrichment audit log. UNIQUE per `(merchant_id, product_id)` backs the 24h enrichment dedup.

### Table: `enrichment_webhook_log`
One row per `products/update` webhook delivery. Outcome ∈ `enqueued` / `skip_tier` / `skip_scope` / `skip_dedup` / `skip_already_queued` / `skip_uninstalled` / `skip_no_merchant` / `skip_no_product_id` / `error`. CASCADE FK after cleanup §8.

### Table: `llms_txt_requests`
AI-visibility tracking. One row per llms.txt request served. CASCADE FK after cleanup §8.

### Table: `pending_scan_triggers`
Enrichment queue (v4 — the scan-class trigger types are vestigial; only `enrichment` does meaningful work).

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | (CASCADE after cleanup §8) |
| `trigger_type` | TEXT | `enrichment` is the only live producer in v4; `weekly_scan` / `theme_update` / `theme_publish` / `product_update` accepted by the drainer but no longer enqueued |
| `trigger_at` | TIMESTAMPTZ DEFAULT now() | |
| `processed_at` | TIMESTAMPTZ | NULL = unprocessed |
| `week_iso` | TEXT | v3 Fix 8 — dormant in v4 (weekly-scan producer gone) |
| `payload` | JSONB | For `trigger_type='enrichment'`: `{ product_gid, numeric_product_id }` |

Indexes: `idx_pending_scans_unprocessed (merchant_id, processed_at) WHERE processed_at IS NULL`; `uq_pending_scan_triggers_week (merchant_id, trigger_type, week_iso) WHERE week_iso IS NOT NULL` (partial unique).

### Table: `install_events` (2026-07-28)

Append-only merchant lifecycle ledger. **The only durable churn record this app has.** See §4b for why it exists and the rule that governs it.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `shop_domain` | TEXT NOT NULL | The durable identity — survives the merchant row by design |
| `event_type` | TEXT NOT NULL | CHECK `('install','uninstall','redact')` |
| `tier` | TEXT | Plan tier at the moment of the event. NULL when unknown. This is what makes free-churn vs paid-churn separable. |
| `merchant_id` | UUID | **NOT a foreign key.** Unconstrained on purpose — dangles once the merchant is redacted. |
| `occurred_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `metadata` | JSONB NOT NULL DEFAULT '{}'::jsonb | e.g. `{reinstall, previous_uninstalled_at}` on install, `{merchant_row_existed}` on redact |

Indexes: `idx_install_events_shop (shop_domain, occurred_at DESC)`, `idx_install_events_type_time (event_type, occurred_at)`. RLS enabled (service_role bypasses).

Writers, all via `recordInstallEvent()` in `app/lib/install-events.server.ts` (never throws; failures go to Sentry):
- `afterAuth` → `install`, **gated on "no live merchant row existed"** so the ledger records installs and reinstalls, not the token exchanges afterAuth also fires on.
- `webhooks.app.uninstalled.tsx` → `uninstall`, with the tier, before the soft-delete.
- `webhooks.shop.redact.tsx` → `redact`, **before the hard delete** (after it the tier is unknowable), in its own try/catch so it can never block a GDPR deletion Shopify will not retry.

**No PII.** The table is designed to outlive `shop/redact`, so it stores only a business identifier, the event, a timestamp and the tier. Do not add email/owner/address columns; hash `shop_domain` if a stricter posture is ever needed.

**The 2026-07-28 seam.** The ledger starts empty and pre-seam installs **must not be backfilled from `merchants.created_at`** — every pre-seam churner was already hard-deleted, so a backfill would load survivors only and report 0% churn for every old cohort with authoritative-looking dates. That is the exact illusion the table exists to end. `docs/churn-and-conversion-queries.md` §1c is valid for cohorts from 2026-07-28 forward; earlier periods get the orphan-`leads` floor (~47% recall, no dates).

### Table: `catalog_reconcile_state` (2026-07-29)

One row per shop. The resume cursor for the catalog enrichment reconcile.

| Column | Type | Notes |
|--------|------|-------|
| `shop_domain` | TEXT PK | FK-free, same reasoning as `install_events` |
| `cursor` | TEXT | Resume point for the in-progress cycle. NULL = start at the beginning |
| `cycle_started_at` | TIMESTAMPTZ | A cycle older than 24h restarts instead of resuming |
| `last_completed_at` | TIMESTAMPTZ | **The only timestamp that licenses "the whole catalog has been seen since then."** The parity verdict reads it |
| `pages_walked_this_cycle`, `products_seen_this_cycle` | INT | Accumulated across a cycle's invocations, reset on completion |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**Why it is load-bearing, not an optimisation.** A large catalog does not fit in one 60s invocation: sex-eshop's 7,685 products take ~45s over 31 pages, against a 22s per-shop budget when merchants share a run. Without a persisted cursor the walk restarts at page 1 every cycle, so it reads roughly the first 15 pages **forever** and never reaches the tail — not late, never — and every individual run reports success. A failed read or write of this table degrades to "start from the beginning": a repeated walk, never skipped catalog.

### Table: `webhook_failures`
Audit + retry-queue for webhook deliveries whose side-effect writes failed. Currently only `app/uninstalled` writes here.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `topic` | TEXT NOT NULL | |
| `shop` | TEXT NOT NULL | |
| `payload` | JSONB | |
| `error_message` | TEXT | |
| `resolved_at` | TIMESTAMPTZ | NULL = unresolved hot set |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Indexes: `idx_webhook_failures_unresolved (topic, shop) WHERE resolved_at IS NULL`, `idx_webhook_failures_created_at`.

---

## 5. Scan Engine

### How scans are triggered

**Path A — Dashboard form submit** (`app._index.tsx` action `runScan`):
1. Merchant clicks "Run My Free Compliance Scan" or "Re-Scan My Store" → form POST `action=runScan`.
2. Authenticate, look up merchant, atomically decrement quota via `decrement_scan_quota` RPC.
3. Call `runComplianceScan(merchant.id, shopDomain, "manual")`.
4. On scan failure, refund the decremented quota (compensating transaction).
5. Fire-and-forget lead capture.
6. Return `{ success: true, scanId }` → toast + loader revalidation.

**Path B — API endpoint** (`api.scan.ts`):
1. POST `/api/scan` with App Bridge JWT.
2. Rate-limit (persistent via `scan_rate_limits`), look up merchant.
3. Atomic quota decrement (402 if exhausted).
4. Run scan; same compensating refund on failure.
5. Return full scan + violations + summary JSON.

**Path C — Event-driven (enrichment only in v4)**:
- `webhooks.products.update.tsx` enqueues a `pending_scan_triggers` row with `trigger_type='enrichment'` and payload `{ product_gid, numeric_product_id }` (dedup'd against `schema_enrichments` and the queue).
- `webhooks.themes.update.tsx` is a no-op pass-through; the v3 theme-update → re-scan path was retired with the weekly cron infra.
- `api.cron.process-scan-triggers.ts` (daily 12:00 UTC + GitHub Actions every 6h) drains `BATCH_SIZE=10` per invocation, runs `enrichProductMetafields` for enrichment rows, marks `processed_at`.

### AI usage cap (v4)
Shared 12-generation rolling 30-day window across `generatePolicy` and `generateAppealLetter`. `checkAndConsumeAiCredit(merchantId)` is called BEFORE the Anthropic API hit so a cap-reached request never burns a model call. The internal validator-retry path in `generatePolicy` does NOT consume a second credit — two model calls count as one generation from the merchant's perspective. Reset date surfaced in the cap-reached error message.

### Policy self-consistency validator (v4)
`app/lib/policy-validator.server.ts` exports `validateGeneratedPolicy(policyType, htmlBody)` which reuses the same regex constants the compliance checks use (`RETURN_WINDOW_RE`, `ITEM_CONDITION_RE`, `REFUND_METHOD_RE`, `TIMELINE_RE`, `COST_RE`, `PLACEHOLDER_RE` in `app/lib/checks/constants.ts`). If the first Anthropic generation fails the validator, the route appends a "missing signals" instruction and retries once. Best-of-two policy text is saved; a soft warning surfaces when the retry also fails.

### Scan execution (`app/lib/checks/index.server.ts`)
`runComplianceScan(merchantId, shopifyDomain, scanType)`:
1. Build admin GraphQL client via `createAdminClient(shopifyDomain)`.
2. Fetch shop data concurrently: `getShopInfo()`, `getShopPolicies()`, `getProducts(50)`, `getPages(20)`.
3. Opportunistic merchant metadata refresh (fire-and-forget).
4. Pre-fetch homepage + up to 3 product pages via `fetchPublicPage()` (SSRF-protected DNS pre-check).
5. Run all 12 checks in two concurrent `Promise.all` batches via `safeCheck()` (exceptions become severity `"error"`, scan continues).
6. Calculate score: `(passedChecks / scorableTotal) * 100`. Errored checks excluded from denominator.
7. Persist: INSERT `scans` + bulk INSERT `violations` rows.

### The 12 Compliance Checks
Adding a new check: import in `index.server.ts`, add to one of the two `Promise.all` batches, add to the destructured array, add to `checkResults`. **No auto-discovery.** Severities below reflect the **2026-07 false-positive remediation** (see `docs/scan-reliability-audit.md`); the checks are all retained (12-point count intact), several were re-scoped toward false negatives because a false accusation churns a non-technical merchant.

1. `contact_information` (**warning**) — **1-of-N**: passes on ANY single contact method (email/`mailto:`, phone/`tel:`, physical address, contact page/form link, or a social business profile), searched across page bodies + homepage markup + the Shopify store contact email. Demoted from critical + 2-of-3 (Google requires only one form of contact since Aug 2021).
2. `refund_return_policy` (critical) — Settings → Policies first; Pages fallback (Fix 2). Page-fallback PASS surfaces `info` advisory.
3. `shipping_policy` (critical) — same Page-fallback pattern.
4. `privacy_and_terms` (critical/warning) — Privacy + Terms independently. Privacy missing = critical; Terms missing alone = warning.
5. `product_data_quality` (warning) — flag short descriptions, missing images, bad pricing, missing SKUs.
6. `checkout_transparency` (**info**) — payment-method advertising is a **trust best-practice, not a GMC requirement** (Google removed that rule in 2021), so this check is informational and **never fails a store**. Detection is broad: SVG `<title>`/`id`/`aria-labelledby` (`pi-*`), `data-enabled-payment-types`, footer payment classes, Shop Pay / dynamic-checkout markup, `PAYMENT_KEYWORDS`.
7. `storefront_accessibility` (critical) — detect password protection + verify product-page HTTP 200.
8. `structured_data_json_ld` (**warning** when present-but-malformed / **info** when absent) — validates Product JSON-LD (`offers` accepted as a single object, an array of per-variant Offers, or an AggregateOffer with `lowPrice`/`highPrice`). When NO Product schema is in the static HTML it reports INFO "not verified" (themes often inject via JS), never a confident WARNING. Still the authoritative signal for whether structured data renders on the storefront.
9. `page_speed` (**info**) — Google PageSpeed Insights mobile score + full-screen pop-up ("intrusive interstitial") detection. A measured-but-slow result is INFO, not WARNING (page speed isn't a GMC suspension criterion); a timed-out/unmeasurable result degrades to non-scorable INFO and is excluded from the score. Severity + timeout-exclusion are now consistent across the authenticated, public `/scan`, and CLI scanners (2026-07).
10. `business_identity_consistency` (info) — Jaccard similarity 60% domain + 40% about-page.
11. `hidden_fee_detection` (**critical**, retained) — flags a genuine **undisclosed positive fee** only: a fee term asserting an actual charge (currency/%/“applies”/“we charge”) that is NOT negated ("no"/"never"/"zero"/"without"/"no hidden"/…) nearby AND NOT disclosed in the fetched refund/shipping policy. Negation-aware so reassurance copy ("no restocking fee") passes.
12. `image_hosting_audit` (**warning** advisory) — dropshipper-host regex over `src/srcset/data-src`. Demoted from critical; accusatory "dropshipper/misrepresentation" framing dropped — GMC does not evaluate the image CDN host, only the feed `image_link` quality (overlays/watermarks, resolution, not placeholder), which the copy now points to.

**Merchant-facing check copy is benefit-driven / de-jargoned (2026-07).** Every check's `title` / `description` / `fix_instruction` avoids mechanism jargon in the strings a merchant reads (no "JSON-LD", "structured data", "schema", "CDN", "image_link", "priceCurrency", "AggregateOffer", "GTIN/MPN", "interstitial", "Non-200", raw bot/host names) and leads with the outcome; Shopify admin paths + step accuracy are preserved. The technical mechanism terms in THIS section's descriptions are intentional dev reference, not merchant-facing. Notably, Check 8's title is now "Google Product Listings" (not "Structured Data (JSON-LD)"), and Check 8's "missing details" list maps internal field tokens (e.g. `offers.priceCurrency`) to plain labels (price, currency) before display.

**Shared HTML detectors (2026-07 dedupe).** The pure HTML-only detection for checks 1, 6, and 8 lives in **`app/lib/checks/shared/html-detectors.server.ts`** (`detectContactSignals`, `detectPaymentSignals`, `findProductSchema` / `normalizeOffers` / `offerHasPrice` / `missingRequiredProductFields` / `evaluateStructuredDataPages`). All three scan surfaces consume it — the authenticated checks (`app/lib/checks/*`) layer Admin-API augmentation on top of it, and the public `/scan` scanner (`public-scanner.server.ts`) uses it directly. Shared constants `PAYMENT_KEYWORDS`, `PAYMENT_STRUCTURAL_SIGNALS`, and `SOCIAL_RE` live in `constants.ts`. **Rule: fix these three checks' detection in the shared module, never re-copy per surface** — the pre-dedupe triple-copy is what caused the 2026-07 incident. The CLI (`scripts/outbound-scanner.ts`) keeps a self-contained MIRROR (it must run standalone via `node --experimental-strip-types`, which can't resolve the app's extensionless imports, and a runner/bundler would add a dependency); its header flags the shared module as source of truth — keep the two in sync.

---

## 6. Results Delivery

### Dashboard layout (`app._index.tsx`)
After a scan, loader revalidates and renders (in order, inside `<s-page>`):
- **Primary-action `<s-button>` slot** — "Re-Scan My Store" (paid or quota remaining) or "Manage plan" (free + exhausted)
- **Scan error banner** (when `scanError` truthy)
- **Billing cancellation banner** (when `?billing=cancelled` URL param)
- **Onboarding wizard** (when `latestScan === null`) — see §6.1
- **Dashboard block** (when latestScan exists):
  - `ScanProgressIndicator` (during scan)
  - `ScoreBanner` — includes post-fix reassurance line (v4 §8) when last scan is clean
  - `ScoreTrend` (30-day sparkline)
  - `KpiCards` (Passed / Critical / Warnings / Skipped)
  - Review request banner
  - Inline upgrade banner (free only — v4 collapsed the Monitoring→Recovery upsell since there's only one paid tier)
  - `AuditChecklist` (12-point, sorted failed-first by severity)
- **Aside (always)**:
  - `PlanStatusCard` — two-state value box. Paid → "Your ShieldKit coverage" reassurance with every paid feature checked; the JSON-LD row is display-only (`checked` when on, muted `off` otherwise). Free → "Fix it now — and stay protected." with locked items + $49/$449 CTA.
  - `SecurityStatusAside`
  - `PolicyGenerationCard` (when paid)
  - `AIVisibilityCard` (when paid + data exists)
  - **Free JSON-LD Structured Data card** — two-state: On (green tick + "JSON-LD Active" + Manage button) / Off (Enable button + "Opens your theme editor — add the Product Schema block and click Save."). This is the **sole control surface** for JSON-LD on the dashboard; `PlanStatusCard`'s row is display-only to avoid competing actions.
  - About ShieldKit

### 6.1 Onboarding wizard (v4 cleanup §3 — 3 steps)
Trigger: `showOnboarding = latestScan === null`. **3 static info cards** + one primary CTA.

| # | Title | Content |
|---|-------|---------|
| 1 | Welcome to ShieldKit | Describes the **12-point audit** |
| 2 | Why GMC Compliance Matters | Explainer about Misrepresentation suspensions |
| 3 | Run Your Free Compliance Scan | Pre-CTA copy |

Primary CTA below all three: `<s-button submit="">Run My Free Compliance Scan →</s-button>`. **No JSON-LD enablement step** — that lives only on the home dashboard aside card after the merchant runs their first scan, giving the wizard a single primary action.

### Lead collection
On first scan, shop owner email collected via GraphQL (`shop { email }`) and upserted into `leads`. Fire-and-forget. No email send at this point — leads are for retargeting.

---

## 7. Route Map

### Authenticated app routes (gated by `authenticate.admin` in `app.tsx`)

| Route File | URL Path | Behaviour |
|-----------|----------|-----------|
| `app.tsx` | `/app` (layout) | Wraps `/app/*`. NavMenu: Dashboard + Manage plan always; Pro Settings + AI bot toggle + Appeal letter + GTIN auto-filler when `hasPaidAccess(tier)` (GTIN additionally requires `WRITE_METAFIELDS_SCOPE_ENABLED`). |
| `app._index.tsx` | `/app` | Onboarding wizard OR dashboard. Actions: `runScan`, `generatePolicy`, `dismissReview`, `enableJsonLd` (flips `json_ld_enabled=true`), `selfHealBilling`. **No `verifyJsonLdNow` in v4** — verifier removed in cleanup batch §1. |
| `app.upgrade.tsx` | `/app/upgrade` | Loader + Component. `window.open(managedPricingUrl, "_top")` from `useEffect` to escape the embedded iframe. |
| `app.billing.confirm.tsx` | `/app/billing/confirm` | Welcome-link landing post-managed-pricing approval. Partner-API-only path; pending page on uncertain status. |
| `app.plan-switcher.tsx` | `/app/plan-switcher` | Same iframe-escape pattern as `/app/upgrade`. |
| `app.appeal-letter.tsx` | `/app/appeal-letter` | Paid only. Plain-language intro line. 3 generations per scan (enforced atomically by `insert_appeal_letter_if_under_cap` — reserve BEFORE the AI credit → finalize/release) + AI monthly cap. Claude Sonnet via `app/lib/llm/appeal-letter.server.ts`. |
| `app.pro-settings.tsx` | `/app/pro-settings` | Paid only. Plain-language intro line. Logo, support email, social URLs, search-URL template — persisted to `merchants.pro_settings`. |
| `app.bots.toggle.tsx` | `/app/bots/toggle` | Paid only. Plain-language intro line. 11 AI crawler allow/block toggles + live `robots.txt` snippet. |
| `app.gtin-fill.tsx` | `/app/gtin-fill` | Paid + scope-gated. Plain-language intro line. Bulk fill on existing catalog. **Surfaces a "Nothing to write" info banner when the action succeeds with 0 candidates** (cleanup batch §7). |

### API routes

| Route File | URL Path | Method | Behaviour |
|-----------|----------|--------|-----------|
| `api.scan.ts` | `/api/scan` | POST | Authenticated scan endpoint. Rate-limited + atomic quota. Returns full scan JSON. GET → 405. |
| `api.cron.process-scan-triggers.ts` | `/api/cron/process-scan-triggers` | **GET + POST** | Drains the queue. `BATCH_SIZE=100` rows selected, bounded by `TIME_BUDGET_MS=45000` and drained by a pool of `ENRICH_CONCURRENCY=5`. GitHub Actions every 6h + Vercel Cron daily 12:00 UTC. Bearer `CRON_SECRET`. |
| `api.cron.reconcile-subscriptions.ts` | `/api/cron/reconcile-subscriptions` | **GET + POST** | Vercel Cron daily 04:00 UTC. Walks paid merchants, queries Partner API, demotes on terminal status. Never demotes on `unknown`. |
| `api.cron.reconcile-catalog.ts` | `/api/cron/reconcile-catalog` | **GET + POST** | Block 4. Walks each paid merchant's catalog 250 products/page and decides enrichment need from the paged data — no per-product round trip. `mode=observe` (default) writes nothing; `mode=enqueue` inserts `pending_scan_triggers` rows. Resumes from `catalog_reconcile_state.cursor`. Also emits the parity report vs `enrichment_webhook_log`. Bearer `CRON_SECRET`. GH Actions `reconcile-catalog-observe.yml` every 6h, pinned to `observe` on schedule. |
| `api.cron.reconcile-installs.ts` | `/api/cron/reconcile-installs` | **GET + POST** | Vercel Cron daily 03:00 UTC. Probes Shopify Admin API for still-installed merchants. **Strictly NON-DESTRUCTIVE since 2026-06-26** — a 401/403 records a non-persisted `auth_stale` signal only. It NEVER writes `uninstalled_at`, NEVER deletes sessions, and NEVER writes `webhook_failures`. |

> **Cron HTTP method — read before touching a cron route.** Vercel Cron invokes a scheduled path with **GET**, which React Router dispatches to the `loader`. All three routes were previously POST-only behind a 405 loader, so **the Vercel crons had never executed** — `process-scan-triggers` ran only because `.github/workflows/process-scan-triggers.yml` passes `--request POST`, and `reconcile-subscriptions` (the only code path that demotes a cancelled subscription) had never run at all. Fixed 2026-07-28: each route exports a thin `loader` and `action` that both delegate to a shared `run(request)`. **Authorisation is the bearer `CRON_SECRET` check inside `run()`, never the HTTP verb** — do not "restore" a method guard.
| `api.proxy.llms-txt.ts` | `/api/proxy/llms-txt` | GET | App Proxy endpoint, HMAC verified by `authenticate.public.appProxy`. Paid only. Generates llms.txt from shop name/description/email + policies + first 50 published products. Per-process 24h in-memory cache. |

**Removed in v4:** `api.cron.weekly-scan.ts`, `api.cron.weekly-digest.ts`, `api.cron.monthly-reset.ts`.
**Removed in 2026-05-28 cleanup batch §1:** `api.cron.verify-json-ld.ts`.

### Public routes

| Route File | URL Path | Behaviour |
|-----------|----------|-----------|
| `_index/route.tsx` | `/` | Landing page. Two paid plan cards (Monitoring $49/mo or $449/yr) + Free. Emits Organization + FAQPage JSON-LD. Redirects to `/app` when `?shop` present. |
| `scan.tsx` | `/scan` | Public 8-point compliance scanner. Emits WebApplication JSON-LD. POST runs scan; second POST (`intent=unlock`) captures lead email. |
| `explainer.tsx` | `/explainer` | GMC misrepresentation explainer (Article JSON-LD). |
| `blog._index.tsx` | `/blog` | Listing from `app/content/blog/*.mdx`. |
| `blog.$slug.tsx` | `/blog/:slug` | BlogPosting JSON-LD. |
| `fix._index.tsx` | `/fix` | Fix Library index (ItemList JSON-LD). |
| `fix.$slug.tsx` | `/fix/:slug` | Programmatic-SEO fix page per entry in `app/content/fixes.ts`. HowTo + FAQPage JSON-LD. |
| `auth.login/route.tsx` | `/auth/login` | Shop domain form. |
| `auth.$.tsx` | `/auth/*` | Catch-all OAuth callback. |
| `privacy.tsx`, `terms.tsx` | `/privacy`, `/terms` | App Store listing required. |
| `sitemap[.]xml.tsx` | `/sitemap.xml` | Generated from static pages + blog + fix registries. |
| `robots[.]txt.tsx` | `/robots.txt` | Allow marketing crawlers; disallow `/app`, `/api`, `/auth`, `/webhooks`. |
| `llms[.]txt.tsx` | `/llms.txt` | Curated markdown content map for AI crawlers (marketing site). |

---

## 8. Server Utilities

### Encryption (`app/lib/crypto.server.ts`)
* AES-256-GCM with `scryptSync(TOKEN_ENCRYPTION_KEY, "shieldkit-token-v1", 32)`. 12-byte random IV, 128-bit auth tag. Ciphertext format `<hex_iv>:<hex_authTag>:<hex_ciphertext>`. `TOKEN_ENCRYPTION_KEY` must be ≥32 chars.

### Session Storage (`app/lib/session-storage.server.ts`)
Custom Supabase adapter implementing Shopify's `SessionStorage`. Encrypts `accessToken` + `refreshToken`; graceful fallback on decrypt failure (re-auth).

### Shopify GraphQL API (`app/lib/shopify-api.server.ts` + split modules)
API Version `2025-10`. Queries: `SHOP_INFO_QUERY`, `SHOP_POLICIES_QUERY`, `PRODUCTS_QUERY` (paginated up to 250), `PAGES_QUERY` (paginated up to 100). Retry: max 3, 500ms base, exponential backoff. THROTTLED-error aware. Executor factories: `wrapAdminClient()` for routes; `createAdminClient()` for background jobs.

### Rate Limiter (`app/lib/rate-limiter.server.ts`)
Persistent via Supabase `scan_rate_limits` (10/hour/shop). In-memory `Map` fallback. Cleanup of >1h-old records fire-and-forget per check.

### Policy Generator (`app/lib/policy-generator.server.ts`)
Model `claude-sonnet-4-6`. Types: refund, shipping, privacy, terms. Output: HTML → server-sanitized via `sanitize-html` → stored in `merchants.generated_policies` JSONB → client-sanitized via `dompurify` before render. Per-type cap: 2 (initial + 1 regen) tracked in `policy_regen_used`; the regen is claimed atomically by the `finalize_policy_regen` RPC (claim-after — see §4).

### Policy Validator (`app/lib/policy-validator.server.ts`) — v4
`validateGeneratedPolicy(policyType, htmlBody)` reuses regex constants from `app/lib/checks/constants.ts`. Returns `{ valid, missing[] }`. The route uses it to drive a single retry against Anthropic when the first generation fails self-consistency; no second AI credit consumed for that retry.

### AI Usage Cap (`app/lib/ai-usage.server.ts`) — v4
`AI_MONTHLY_CAP = 12`. `checkAndConsumeAiCredit(merchantId)` calls the `consume_ai_credit` RPC atomically; falls back to non-atomic read+update if the RPC isn't deployed. Returns `{ allowed, remaining, resetAt }`. `windowResetIso(resetAt)` formats the next-reset date for user-facing messages.

### Appeal Letter Generator (`app/lib/llm/appeal-letter.server.ts`)
Same Anthropic backbone as the policy generator. Paid-only feature.

### GTIN Enrichment (`app/lib/enrichment/gtin-enrichment.server.ts`)
Per-product enrichment of `metafields.custom.{gtin,mpn,brand}`. Brand fallback chain: `existing brand metafield → product.vendor → shop.name`. Equivalent to the Liquid block's resolution order. Called from the queue drainer only (Fix 9), never inline in the webhook hot path.

### JSON-LD Deep Link (`app/lib/json-ld-deep-link.ts`)
`getJsonLdThemeEditorUrl(shopDomain, block = 'product-schema', apiKey)` returns `https://{shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/${block}`. `apiKey` is threaded from the loader (Vite does not expose `process.env` to the browser).

### Sentry (`app/lib/sentry.server.ts`)
Initialised at server-module load via side-effect import in `entry.server.tsx`. `sendDefaultPii: false`. No-op when `SENTRY_DSN` unset — `addBreadcrumb` and `captureException` remain safe to call. Wired into `app.billing.confirm.tsx`, `api.cron.reconcile-installs.ts`, `webhooks.app.uninstalled.tsx`.

### Supabase Client (`app/supabase.server.ts`)
Singleton (dev caches on `global` for hot-reload survival). `service_role` key — bypasses RLS. Auth features disabled.

---

## 9. Scripts

| Script | Purpose |
|--------|---------|
| `scripts/outbound-scanner.ts` | Standalone CLI compliance scanner against any public Shopify storefront — no OAuth. SSRF-protected. Cannot check billingAddress, policy bodies, or product data quality (no Admin API). |
| `scripts/backfill-merchant-shop-info.ts` | Walks every installed merchant and refreshes metadata columns via `getShopInfo()`. 250ms pacing. |
| `scripts/cleanup-orphan-webhooks.ts` | Deletes orphan webhook subscriptions pointing at dead trycloudflare dev tunnels. |
| `scripts/dev-cleanup-subs.ts` | Cancels test subscriptions. |
| `scripts/top-criticals.ts` | Ops query for hottest critical check failures. |
| `scripts/prune-enrichment-log.ts` | **Manual only, never wired to a cron.** Deletes `enrichment_webhook_log` rows older than `RETENTION_DAYS` (default 30). That table is 230k rows / 50 MB (~91% of the DB) of write-only telemetry with no reader. A first bulk delete must be batched + VACUUMed, and wants a `created_at` index — a single DELETE will hit a statement timeout. |
| `scripts/purge-free-scan-triggers.ts` | Removes free-tier rows from `pending_scan_triggers` out-of-band. |
| `scripts/backfill-product-webhooks.ts` | Re-asserts per-shop `products/*` subscriptions for paid merchants (added `288329f`, 2026-06-11). |
| `scripts/audit-product-webhooks.ts` | Read-only audit of per-shop `products/*` subscriptions. |

**Standalone-script gotcha:** `tsx` is NOT a declared dependency and `dotenv` is only transitive. Run these with `node --experimental-strip-types`, matching the convention `scripts/outbound-scanner.ts` documents — do not assume `npx tsx` works.
| `scripts/validate-partner-api.ts` | Smoke test for Partner API plumbing. |

---

## 10. UI & Styling Rules

* **Polaris Only:** native Shopify Polaris web components (`<s-page>`, `<s-card>`, `<s-button>`, `<s-banner>`, `<s-badge>`, etc.). No raw HTML/CSS for layout.
* **Brand Color:** "Security Blue" `#0F172A`.
* **Score colors:** Green `#1a9e5c` (≥80), Orange `#e8820c` (≥50), Red `#e51c00` (<50).
* **Threat levels:** Minimal `#1a9e5c`, Low `#6aad81`, Elevated `#e8820c`, High `#d82c0d`, Critical `#c00000`.
* **Check statuses:** Passed `#1a9e5c`, Critical `#e51c00`, Warning `#e8820c`, Info `#5c6ac4`, Error `#8c9196`.

---

## 11. Architecture Decisions & Patterns

* **No Prisma/SQLite** — all persistence via Supabase JS with service_role.
* **`maybeSingle()` not `single()`** — prevents 406 errors on missing rows.
* **Atomic scan quota** — `decrement_scan_quota` RPC; both scan entry points decrement before scan + refund on failure.
* **Atomic AI credit** — `consume_ai_credit` RPC; checked + consumed before the Anthropic call so cap-reached requests never burn a model hit. Validator-retry path doesn't double-consume.
* **Atomic appeal cap** (SHIELDKIT-2) — `insert_appeal_letter_if_under_cap` RPC: per-scan advisory lock + reserve-if-under-cap. The route **reserves BEFORE** consuming an AI credit (an over-cap attempt never burns a credit or a model call), finalizes the reserved row on success, and releases it on every failure path. Replaced a route-level count-then-insert TOCTOU. **Never re-add a non-atomic count-then-insert for this cap.**
* **Atomic policy regen** (SHIELDKIT-2) — `finalize_policy_regen` RPC: one conditional UPDATE claims the per-type regen slot AND writes the body, **after** generation (claim-after), so a crash can't burn the regen and concurrent regens can't both win. No claim-before/release RPCs. Scan quota + AI credit caps unchanged.
* **Persistent rate limiting** — `scan_rate_limits` survives cold starts; in-memory fallback.
* **safeCheck() wrapper** — every compliance check wrapped so exceptions become severity `"error"` results instead of failing the whole scan.
* **Polaris web component type gaps** — props like `submit`, `loading` work at runtime but aren't in TS type defs. Codebase uses `@ts-ignore` or spread patterns. Expected; do not "fix".
* **Embedded app navigation** — must go through App Bridge or React Router. Raw `<a>` tags trigger full page reloads that break the iframe.
* **useWebComponentClick hook** — React's synthetic `onClick` does NOT fire on Polaris web components. All click handlers on `<s-button>` use `useWebComponentClick` (native DOM listener via ref). Takes an optional `disabled` flag (SHIELDKIT-2) that no-ops the click while an action is in flight.
* **Button single-flight guard** (SHIELDKIT-2) — every mutating button wraps its handler with `useSingleFlight(fn, busy)` (a synchronous re-entrancy ref that resets when `busy` returns to idle), passes the busy flag to `useWebComponentClick(handler, disabled)`, and sets the `<s-button>` `loading`/`disabled` attrs while busy. Covers run/re-scan, policy generate/regenerate, appeal generate, GTIN auto-fill, enable-JSON-LD, and upgrade/plan-switcher. The atomic caps are the real backstop; this stops the concurrent POSTs at the source (mashing had fired 5 appeal-letter submits). Busy source: `useFetcher().state` for fetcher actions, `useNavigation().state` for `<Form>`/`navigate()` buttons.
* **s-banner / `<button>` dismiss** — same web-component gap. Use a native `<button>` inside the banner.
* **SSRF protection** — `fetchPublicPage()` in `helpers.server.ts` validates DNS records against private IP ranges before fetching.
* **Streaming SSR** — `entry.server.tsx` uses `renderToPipeableStream`; bots get `onAllReady`, humans get `onShellReady`. 5s timeout.
* **Server-side HTML sanitization** — AI-generated policy HTML sanitized with `sanitize-html` server-side, `dompurify` client-side. **Never reintroduce `jsdom` / `isomorphic-dompurify`** — the 2026-05-21 outage was caused by the latter's `jsdom` ESM tree being incompatible with Vercel's runtime.
* **Reproducible builds on Vercel** — `vercel.json` sets `installCommand: "npm ci"`. **Never edit `package.json` without committing the regenerated lockfile.**
* **Theme block name 25-char limit** — Shopify rejects theme block `name` strings longer than 25 chars.
* **Brand fallback chain (JSON-LD)** — `product.metafields.custom.brand` → `product.vendor` → `shop.name`. Implemented in both `extensions/json-ld-schema/blocks/product-schema.liquid` and `app/lib/enrichment/gtin-enrichment.server.ts`. Keep both sites in sync.
* **Single paid gate** — `hasPaidAccess(tier)` is the only feature-gate helper in v4. Never compare `merchants.tier` to a literal at a feature-gate call site.
* **Shopify Managed Pricing** — plans defined in Partner Dashboard; codebase does not register a `billing` config or call `billing.request()`. Plan-name strings must match `PLAN_NAME_TO_TIER` / `PLAN_NAME_TO_CYCLE` keys exactly.
* **Iframe-escape redirect pattern** — `app.upgrade.tsx` and `app.plan-switcher.tsx` are loader + component routes that `window.open(url, "_top")` from `useEffect`. Server-side `redirect()` can't navigate the parent frame (Shopify admin sends `X-Frame-Options: DENY`).
* **JSON-LD = click = on** (v4 cleanup §1) — `merchants.json_ld_enabled` flips `true` on click; no verifier, no probing. The compliance scan's `structured_data_json_ld` check is the authoritative source for whether the block is rendering on the storefront. A storefront-fetch verifier can't reach password-protected or pre-launch stores and produced false negatives.
* **One JSON-LD control on the dashboard** (v4 cleanup §4) — the aside JSON-LD card is the sole enable surface. `PlanStatusCard`'s row is display-only (no `Turn on` action) to avoid competing controls.
* **Onboarding = 3 steps, one CTA** (v4 cleanup §3) — JSON-LD enablement moved out of the wizard so first-time users have a single primary action ("Run Scan").
* **GTIN button surfaces zero-work outcome** (v4 cleanup §7) — the success banner is gated on `succeeded > 0`; an additional info-tone banner renders on `ok=true && succeeded=0 && failed=0` so the merchant sees feedback when no candidate qualified.
* **`scans_remaining` preserved on reinstall** (v4 cleanup §6) — afterAuth's upsert never includes `scans_remaining` in the payload. First install: DB DEFAULT 1. Reinstall: preserved (typically 0 post-scan). Prevents free-scan farming. Regression test in `tests/bug-fixes.test.ts` asserts the payload never includes the column.
* **All child FKs to `merchants` CASCADE** (v4 cleanup §8) — `enrichment_webhook_log`, `llms_txt_requests`, `pending_scan_triggers` were `ON DELETE NO ACTION` and silently broke GDPR `shop/redact` for any merchant who had ever triggered enrichment / served llms.txt / queued a scan trigger. Migration `20260528160000_cascade_fks_for_shop_redact.sql` made them CASCADE.
* **Webhook reliability** — `app/uninstalled` records `webhook_failures` rows on Supabase write errors. **There is no cron backstop**: `reconcile-installs` is non-destructive and never writes `uninstalled_at`. `webhook_failures` being empty means "no Supabase write ever errored", NOT "no webhook ever failed" — it is not a delivery log.
* **An unbounded Supabase `.select()` is a bug on any table that can exceed 1,000 rows** — instance 4 of the pattern in §11a (2026-07-28, three separate reads). PostgREST silently caps a response at 1,000 rows — no error, no flag. It bit the Block 4 parity read (reported 777 distinct products where the window held 4,250 rows / 2,941 distinct, making the gate look **cleaner** than the data supported), the reconcile's catalog-size hint, and the reconcile's `alreadyQueued` read (which re-enqueued everything past row 1,000 and inflated the enrichment queue from ~4,700 to 15,559 duplicate rows). **Paginate with `.range(offset, offset + PAGE - 1)`, stop on a short page, and report the row count actually read.** When an incomplete read would cause a bad write, suppress the write rather than proceed on a partial view (see `enqueue_suppressed`). Remaining unbounded reads are on `merchants` (55 rows) and per-scan `violations` (~12) — safe by size, not by construction.
* **A Shopify THROTTLED reply is HTTP 200 with `errors[]` and NO `data`** — instance 3 of the pattern in §11a (2026-07-28). Never read `json?.data?.X` and treat undefined as a fact about the store. That single collapse silently discarded ~5,800 products of a paying merchant's enrichment: the read returned `product_not_found` for a rate limit, and the write returned `ok: true` with a populated `written` list for fields it never wrote — then wrote a `schema_enrichments` anchor claiming success, which also suppressed the product from the dedup meant to retry it. `EnrichmentResult.unavailable` now means "could not look / could not write"; `product_not_found` is returned **only** when `data` is present and `product` is explicitly null. Background callers must route through `executeWithRetry` (`createAdminClient` returns a bare fetch wrapper with no rate-limit handling), defer unavailable work by re-enqueueing with a bounded `attempt` counter rather than consuming the queue row, and report SUCCESSES rather than attempts.
* **Measured Shopify enrichment concurrency (2026-07-28):** concurrency 5 → 183 succeeded/46s; 10 → 384/47s, zero deferrals; 16 → 278 + 28 deferred. **10 is the sustainable ceiling**; the earlier "24 is linear" reading was an artefact of the broken counters, where failures looked like speed. Drainer defaults stay 150/5/45s; `?batch=`, `?concurrency=`, `?budget_ms=` are bounded operator overrides for burn-down only.
* **The catalog reconcile must NOT dedup against `schema_enrichments`** (2026-07-28). The webhook path has to, because it only knows a product was *edited*. The reconcile reads live metafields off the catalog page, so an anchor can only ever override ground truth — and did: ~838 products carried anchors claiming success while still needing work, and a dedup would have classified exactly those as `dedup_fresh` and refused to re-enqueue the work the anchor was wrong about. Re-enqueue pressure is bounded by the pending-queue check instead, which is self-limiting with no clock involved.
* **Churn must never be stored only on the `merchants` row** (audit 2026-07-28) — `webhooks.shop.redact.tsx:45-48` hard-deletes the merchant 48h after uninstall and all 7 child FKs CASCADE, so `uninstalled_at` has a 48-hour half-life and a point-in-time query can essentially never observe it. ~40 real uninstalls left no trace this way; they were only reconstructable from orphaned `leads` rows (that table has no FK, which is the sole reason it survived). Durable churn goes to PostHog (`uninstall` event) and to the FK-free `install_events` ledger. **Never add a foreign key to `install_events`, and never prune `leads` on redact until `install_events` has replaced it as the historical record.**
* **GTIN enrichment off the webhook hot path** — webhook enqueues `trigger_type='enrichment'`; drainer runs the work with the 60s function ceiling instead of the ~5s webhook ACK window.
* **Billing self-heal off the critical render path** — moved to a post-mount action so dashboard paint doesn't block on Partner API latency.

---

---

## 11a. THE NAMED PATTERN: "could not look" must never become "is not there"

**Four instances found in one day, 2026-07-28. Two of them were introduced by the
same work that fixed the other two.** If you are reading this file because
something reported a confident negative, start here.

### The shape

A read fails. The failure is *structurally indistinguishable* from a successful
read that found nothing — an `undefined`, a `null`, an empty array — and the code
treats it as a fact about the world:

```
"the fetch failed"           becomes  "the store has no refund policy"
"Shopify rate-limited us"    becomes  "that product does not exist"
"the response carried no data" becomes "there were no errors, so it worked"
"the page returned 1,000 rows" becomes "there are exactly 1,000 rows"
```

Every instance shares three properties, and all three are why it survives review:

1. **It looks like correct defensive coding.** `?.`, `?? []`, `if (!x) break` are
   all idiomatic. The bug is not the operator, it is that the fallback asserts
   something.
2. **It fails silently and confidently.** No throw, no log, no error counter. The
   caller gets a plausible answer and acts on it.
3. **It fails in the direction that looks like success.** Fewer findings, an empty
   queue, a clean gate, a green count. Nobody investigates good news.

### The rule

**A failed read has three possible answers, not two, and the third one must be
representable.**

| | Meaning | Correct handling |
|---|---|---|
| `ok` | We looked, here is what is there | Act on it |
| `absent` | We looked, it is genuinely not there | A real finding |
| `unavailable` | **We could not look** | Degrade, defer, or refuse — never assert |

`absent` must be *narrowly* proven (an explicit `404`/`410`, a `data` key present
with `null` inside it). Everything else is `unavailable`. If you cannot tell the
two apart from the response, you have the bug.

### The four sites

| # | Site | The collapse | Consequence | Fixed |
|---|---|---|---|---|
| 1 | `checks/public-scanner.server.ts`, `checks/storefront-accessibility.server.ts`, `scripts/outbound-scanner.ts` | `res?.status === 200 ? html : null` — a 404 and a 429/503/timeout became the same `null` | Three fabricated CRITICALs on the public `/scan` lead-gen funnel — the first number a prospect ever sees. Fired on `normae-shop.com` from a single HTTP 503 | Block 1 — `classifyFetch` / `fetchPageChecked` / `degradeUnverifiable` |
| 2 | `shopify-api.server.ts` `getShopPolicies` / `getPages` | A GraphQL `errors` body returned an all-null result, identical to "this shop has no policies" | Four simultaneous CRITICALs on paying merchants' dashboards; scores flipped 91.67↔58.33 with no store change. Three paying merchants churned | Phase A / Block 1 — `available: boolean` + bounded retry |
| 3 | `enrichment/gtin-enrichment.server.ts` (read **and** write) + `api.cron.process-scan-triggers.ts` | A THROTTLED reply is **HTTP 200 with `errors[]` and no `data`**. The read's `json?.data?.product` → undefined → `product_not_found`. The write's `userErrors ?? []` → `[]` → **`ok: true` with a populated `written` list for fields it never wrote** | ~5,800 products of a paying merchant's enrichment silently discarded while the drainer reported `0 errors`; ~838 products stamped with success anchors that then suppressed their own retry | 2026-07-28 — `unavailable` flag, `executeWithRetry`, defer-and-requeue |
| 4 | `api.cron.reconcile-catalog.ts` (parity read) and `enrichment/catalog-reconcile.server.ts` (`alreadyQueued`) — **both mine** | PostgREST silently caps a response at 1,000 rows. A short page was read as "that is all of them" | The parity read reported 777 distinct products where the window held 2,941 — **making the gate look cleaner than the data supported**, the most dangerous direction. `alreadyQueued` re-enqueued everything past row 1,000, inflating the queue from ~4,700 to 15,559 duplicate rows | 2026-07-28 — `.range()` pagination, `webhook_log_rows_read`, `enqueue_suppressed` |

Also worth knowing about site 4: the merchant-facing `/app/gtin-fill` carried the
same pair (a throttled page read as end-of-catalog, a throttled write counted as
success) — worse than the others because the drainer misled an *operator* while
that button misled the *customer*.

### Two facts about Shopify that cause site 3 and will cause the next one

* **A THROTTLED Admin API reply is `HTTP 200`.** Body: `{errors: [{message:
  "Throttled", extensions: {code: "THROTTLED"}}], extensions: {cost: {...}}}` and
  **no `data` key**. Checking `response.ok` tells you nothing. Never read
  `json?.data?.X` and treat `undefined` as a statement about the store.
* **`createAdminClient` returns a BARE fetch wrapper with no rate-limit
  handling.** `executeWithRetry` is what implements the THROTTLED backoff, and
  every background caller must route through it. Site 3 existed because
  `makeAdminLike` wrapped the bare executor.

### How each one was actually caught

Not by review, in any of the four cases:

* Site 1 — a scoped audit that asked "where else does this exact expression appear".
* Site 2 — a post-mortem correlating `critical_count = 4` against
  `shop_info_unavailable` (9/17 vs 0/98 elsewhere).
* Site 3 — draining the queue to zero and then **asking Shopify whether the work
  had landed**, instead of trusting the queue depth. It had not.
* Site 4 — cross-checking the route's own output against a direct SQL
  `count(DISTINCT ...)`.

**The generalisable move: never verify a system against its own bookkeeping.** An
empty queue is not completed work. A zero error count is not an absence of
failure. Ask the external system what is true.

## 12. Known Issues / Limitations

* **JSON-LD enablement is intent-only** — `merchants.json_ld_enabled` records intent (the click) without probing the storefront. If a merchant enables and then removes the block from their theme without re-scanning, the flag stays true. The compliance scan's `structured_data_json_ld` check is the place merchants discover that mismatch.
* **`scans_reset_at` column dormant** — monthly-reset cron removed in v4; no code path writes to the column. Harmless; pending future cleanup migration.
* **`digest_emails` table dormant** — weekly-digest cron removed in v4; no inserts since. Table kept to preserve historical send audit data.
* **DEPRECATED v3 JSON-LD verifier columns dormant** — `json_ld_enable_clicked_at`, `json_ld_verified_at`, `json_ld_verification_attempts` retained in DB after cleanup batch §1 but never read or written. Marked DEPRECATED in `supabase/schema.sql`. A future cleanup migration will drop.
* **`@sentry/react` dependency installed but dormant** — server-side `@sentry/node` is wired; the React side has no client-side import. Safe to remove if no client-side telemetry is planned.
* **`leads` table shape drift vs `supabase/schema.sql`** — live DB has `id BIGINT NOT NULL` and `email TEXT NULL`; schema.sql still documents `id UUID` and `email TEXT NOT NULL`. Cosmetic; runtime never relies on the drifted shape.
* **`merchants`/`scans`/`violations` index drift vs `schema.sql`** — three indexes claimed by `schema.sql` (`idx_merchants_active`, `idx_scans_created_at`, `idx_violations_severity`) do not exist on the live DB. Harmless at runtime; only affects bootstrap-from-scratch parity.
* **In-memory llms.txt cache is effectively dead code on Vercel serverless** — the per-process `Map` in `api.proxy.llms-txt.ts` is lost on cold start; the downstream `Cache-Control: public, max-age=86400` header is what actually caches.
* **`themes/update` / `themes/publish` webhook handlers are no-ops in v4** — kept registered to avoid scope-review churn, but the v3 theme-change → re-scan trigger path was retired with the weekly cron infra.
* **npm audit dev-dep vulnerabilities** — ~25 known issues in ESLint / GraphQL codegen / Sentry transitive deps. No production runtime impact. No non-breaking fixes available.

---

## 13. Environment Variables & External Dependencies

### Required
| Variable | Used By | Purpose |
|----------|---------|---------|
| `SHOPIFY_API_KEY` | `shopify.server.ts`, `app.tsx`, `json-ld-deep-link.ts` (via loader) | Shopify app client ID. Threaded into theme-editor deep links from the loader. |
| `SHOPIFY_API_SECRET` | `shopify.server.ts` | Webhook HMAC verification, OAuth |
| `SHOPIFY_APP_URL` | `shopify.server.ts`, `vite.config.ts` | App base URL |
| `SCOPES` | `shopify.server.ts`, multiple gates | OAuth scopes (production: the toml's 8 scopes) |
| `SUPABASE_URL` | `supabase.server.ts` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase.server.ts` | Admin-level DB access (bypasses RLS) |
| `TOKEN_ENCRYPTION_KEY` | `crypto.server.ts` | AES-256-GCM key material (≥32 chars) |
| `SHOPIFY_APP_HANDLE` | `plans.ts` (`getManagedPricingUrl`) | App slug from Partner Dashboard. Throws if unset. |
| `CRON_SECRET` | All `api.cron.*.ts` handlers | Bearer token for Vercel + GitHub Actions cron invocations |

### Optional
| Variable | Used By | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `policy-generator.server.ts`, `appeal-letter.server.ts` | AI policy + appeal generation |
| `GOOGLE_PAGESPEED_API_KEY` | `page-speed.server.ts` | Higher quota on PageSpeed API |
| `SENTRY_DSN` | `sentry.server.ts` | Server-side Sentry. Unset → no-ops; SDK still initialises. |
| `SHOP_CUSTOM_DOMAIN` | `shopify.server.ts` | Custom Shopify domain support |
| `PORT` | `vite.config.ts` | Server port (default 3000) |
| `NODE_ENV` | Various | Supabase singleton caching, etc. |

**Removed v4:** `RESEND_API_KEY` was used by `app/lib/emails/send.server.ts` + weekly-digest cron — both deleted. Safe to remove from Vercel env.

### Feature flags
* **`WRITE_METAFIELDS_SCOPE_ENABLED`** — derived at module load from `process.env.SCOPES.includes("write_products")`. Currently **true** in production. Consumers: `app/routes/app.tsx` (NavMenu visibility for `/app/gtin-fill`), `app/routes/app.gtin-fill.tsx` (route gate), `app/routes/webhooks.products.update.tsx` (enrichment gate `skip_scope`).

### External Services
| Service | Purpose | Endpoint |
|---------|---------|----------|
| Supabase | PostgreSQL (project `bhnpcirhutczdorkhibm`) | `bhnpcirhutczdorkhibm.supabase.co` |
| Shopify Admin API | GraphQL data | `{shop}/admin/api/2025-10/graphql.json` |
| Shopify Partner API | Subscription reconciliation (canonical post-Apr-28) | `partners.shopify.com/api/<version>/graphql.json` |
| Google PageSpeed Insights | Mobile performance scoring | `googleapis.com/pagespeedonline/v5/runPagespeed` |
| Anthropic API | AI policy + appeal generation | `@anthropic-ai/sdk` (`claude-sonnet-4-6`) |
| Sentry | Server-side observability | When `SENTRY_DSN` set |

---

## 14. Testing

* **Framework:** Vitest ^4.1.2.
* **Run:** `npm test` → `vitest run`.
* **Files (14):** the nine listed below plus the 2026-07 false-positive suites — `scan-fp-fixes.test.ts` (authenticated checks) and `public-scanner-fp.test.ts` (/scan), which exercise the real modules and are biased to false negatives (reassurance copy / JS-rendered content / valid-but-unusual schemas must PASS): `bug-fixes.test.ts` (large regression suite), `partner-api.test.ts`, `phase-7-ai-visibility.test.ts`, `phase-7-dashboard.test.ts`, `phase-7-enrichment.test.ts`, `phase-7-monitoring.test.ts`, `phase-7-quick-wins.test.ts`, `reconcile-subscriptions.test.ts`, `v3-pricing.test.ts`.
* **Count on 2026-07-09:** **329 / 329 passing** (255 pre-v4-pricing → +FP-remediation + shared-detector suites). The 2026-07 shared-detector extraction (`shared/html-detectors.server.ts`) was a zero-behavior-change refactor: every pre-existing test passed unchanged.
* **Style:** Most tests are file-content assertions (regex / string matching) to avoid needing env vars for module initialisation. Trade-off: brittle when implementation details rotate; rebalance toward behaviour tests if maintenance burden grows.

---

## 15. Deployment & Build

### Vercel (current)
* App URL: `https://shieldkit.vercel.app`
* **Tier: Hobby.** Function duration capped at 60s; daily is the minimum cron cadence.
* **`vercel.json` defines 3 Vercel Cron jobs** (down from 7 pre-v4 / 4 mid-cleanup-batch):
  - `/api/cron/reconcile-subscriptions` — daily 04:00 UTC (Partner-API demote)
  - `/api/cron/reconcile-installs` — daily 03:00 UTC (Admin-API uninstall probe)
  - `/api/cron/process-scan-triggers` — daily 12:00 UTC (failsafe drainer — primary is GH Actions every 6h)
* `vercel.json` also defines edge-level 308 `redirects` for known scanner paths (`/wp-admin/*`, `/.env`, `/xmlrpc.php`, etc.) so bot probes don't cold-start serverless functions, plus long-cache headers on static brand assets.
* **App Proxy:** `[app_proxy]` in `shopify.app.toml` registers `/apps/llms-txt` → `/api/proxy/llms-txt`; HMAC verified by `authenticate.public.appProxy(request)`.
* **`react-router.config.ts`** uses the `@vercel/react-router` preset.
* **Build:** `react-router build`. **Serve:** `react-router-serve ./build/server/index.js`.

### Scan trigger drain (Hobby-compatible)

The 12-point compliance scan takes ~10–15s per merchant. In v4 the weekly-scan fan-out + drain pipeline was removed; only the enrichment-trigger path remains:

1. **`webhooks.products.update.tsx`** enqueues `trigger_type='enrichment'` with payload `{ product_gid, numeric_product_id }`. 24h-dedup against `schema_enrichments` and the queue.
2. **`api.cron.process-scan-triggers.ts`** drains up to `BATCH_SIZE=10` enrichment rows per invocation (~2s each), staying well within the 60s Hobby function ceiling.
3. **`.github/workflows/process-scan-triggers.yml`** — GitHub Actions cron every 6h (`0 */6 * * *`) curls the endpoint with bearer `CRON_SECRET`. Cadence cut from `*/30` to `0 */6` on 2026-05-28 to reduce Vercel Hobby Fluid Active CPU now that only enrichment work remains.
4. **Vercel Cron failsafe** — daily 12:00 UTC same endpoint, same `Authorization: Bearer $CRON_SECRET` header.

**Setup required when first wiring up the workflow:**
- GitHub repo → Settings → Secrets → Actions → New repository secret named `CRON_SECRET` matching the Vercel env var of the same name.

### Docker (alternative)
`Dockerfile` exists (Node 20-alpine, port 3000) but Vercel is canonical.

### Vite Config (`vite.config.ts`)
* Plugins: `reactRouter()`, `tsconfigPaths()`
* HMR: WebSocket localhost:64999 (dev) or wss://{host}:443 (production)
* Assets inline limit: 0
* Optimized deps: `@shopify/app-bridge-react`

### Shopify CLI
* `npm run dev` → `shopify app dev`
* `npm run deploy` → `shopify app deploy`
* `npm run typecheck` → `react-router typegen && tsc --noEmit`

### Database Migrations
Numbered migrations in `supabase/migrations/` are source of truth. Apply migration to live DB BEFORE deploying code that depends on the new shape. Live history listed in §4.

---

## 16. Next Priorities

_(Intentionally left for the founder to populate.)_

Open follow-ups noted during the cleanup batch but not actioned:
- Drop the 3 dormant v3 verifier columns from `merchants` once enough time has passed to be confident no rollback is needed (`json_ld_enable_clicked_at`, `json_ld_verified_at`, `json_ld_verification_attempts`).
- Drop the `digest_emails` table (or repurpose).
- Drop the `scans_reset_at` column.
- Remove `@sentry/react` dev-dep if no client-side telemetry is planned.
- Manually delete legacy plans (Recovery, Shield Pro, Shield Pro Annual, Shield Max, Shield Max Annual) from the Partner Dashboard pricing UI; set Monitoring to $49/$449 if not yet done.
