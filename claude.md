# ShieldKit — Complete Project Reference

_Last rewritten 2026-05-28 from current code + live DB inspection after the May 27 audit/sweep + four migrations applied._

## 1. Project Overview

ShieldKit is a B2B SaaS Shopify Embedded App that scans Shopify stores for Google Merchant Center (GMC) compliance issues and surfaces AI-search visibility tools.

* **Module A (Current):** 12-point automated compliance scanner. Identifies suspension risks and provides plain-English fix instructions.
* **Module B (Future/Hidden):** Automated DMCA Takedown Legal Engine. All DMCA features are deferred indefinitely — placeholder route was removed on 2026-05-14.

**Pricing (current — what new merchants see on the landing page):**
- **Free** — $0/mo: 1 compliance scan per month, fix instructions for top findings, JSON-LD theme extension. DB tier `'free'`.
- **Monitoring** — $30/month or $290/year. DB tier `'monitoring'`. Plan-name strings: `"Monitoring"` and `"Monitoring Annual"`. Weekly automated compliance scans, weekly health digest email, AI bot allow/block toggle, llms.txt at `/apps/llms-txt`, ongoing GTIN enrichment on newly-created products, AI-visibility tracking.
- **Recovery** — $150/year annual-only. DB tier `'recovery'`. Plan-name string: `"Recovery"`. Everything in Monitoring, plus: GMC re-review appeal letter generator, AI policy rewrites, bulk GTIN/MPN/brand fill on existing catalog, unlimited on-demand compliance scans.

(Landing page copy lives in `app/routes/_index/route.tsx`.)

**Legacy / grandfathered tiers** (kept in DB constraint, plan maps, and access helpers so existing subscriptions keep working — NOT offered to new merchants):
- **Shield Pro** ($14/mo or $140/yr, DB tier `'shield'`) — old v2 plan; live merchant rows on 2026-05-28: 0.
- **Shield Max** ($39/mo or $390/yr, DB tier `'pro'`) — old v2 plan; live merchant rows on 2026-05-28: 2.

Live tier distribution on 2026-05-28 from the DB: `free=38, monitoring=1, pro=2`. No `shield` or `recovery` rows yet.

**Source of truth for tier access:** `app/lib/billing/plans.ts`:
- `hasMonitoringAccess(tier)` → true when tier ∈ `{ 'monitoring', 'recovery', 'pro' }`
- `hasRecoveryAccess(tier)` → true when tier ∈ `{ 'recovery', 'pro' }`

`'shield'` returns false on both helpers — grandfathered Shield Pro rows degrade gracefully to free-level access without a forced downgrade. `'pro'` (grandfathered Shield Max) passes both so the 2 live customers retain their full v2 feature set.

**Never compare `merchants.tier` to a literal string at a feature-gate call site.** Always route through the helpers. The only call-site literal comparisons that remain are sentinel "is this free or not" checks in upgrade-CTA placement and webhook-payload validation; everything that gates a feature uses the helpers.

---

## 2. Architecture & Tech Stack

### Framework & Runtime
* **React Router v7** with file-based routing via `@react-router/fs-routes`. All routes defined by convention in `app/routes/`.
* **React 18.3**, **Vite 6.3**.
* **Node.js** `>=20.19 <22 || >=22.12` (enforced in `package.json` engines).
* **TypeScript** ^5.9.3, strict mode.

### Hosting & Deployment
* **Vercel** at `shieldkit.vercel.app`. **Tier: Hobby.** Load-bearing — Hobby caps function duration at 60s, so heavy work must be split.
* `vercel.json` defines 7 Vercel Cron jobs (see Section 7). The lowest-frequency-allowed slot on Hobby is daily.
* `react-router.config.ts` uses the `@vercel/react-router` preset for serverless deployment.
* `Dockerfile` exists for alternative deployment (Node 20-alpine, port 3000) but Vercel is canonical.
* `npm run build` → `react-router build`. `npm start` → `react-router-serve ./build/server/index.js`.

### Key Dependencies (production)
| Package | Version | Purpose |
|---------|---------|---------|
| `@shopify/app-bridge-react` | ^4.2.4 | Embedded app shell, toast, navigation |
| `@shopify/shopify-app-react-router` | ^1.1.0 | Auth, billing, webhooks, session management |
| `@supabase/supabase-js` | ^2.47.0 | Postgres client (service role) |
| `cheerio` | ^1.2.0 | Server-side HTML parsing for compliance checks |
| `@anthropic-ai/sdk` | ^0.85.0 | AI policy generation + appeal-letter (model `claude-sonnet-4-20250514`) |
| `@sentry/node`, `@sentry/react` | ^10.54.0 | Server-side observability — init from `entry.server.tsx`, no-op when `SENTRY_DSN` unset |
| `resend` | ^6.12.2 | Weekly digest email send |
| `isbot` | ^5.1.31 | Bot detection for streaming SSR |
| `dompurify` | ^3.3.3 | Client-side HTML sanitization for AI-generated policy display |
| `sanitize-html` | ^2.13.0 | Server-side sanitization for AI-generated policy storage (replaced `isomorphic-dompurify` on 2026-05-21 to drop `jsdom` from the server bundle — see §11) |

### Key Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.9.3 | Type checking |
| `vitest` | ^4.1.2 | Test runner |
| `vite` | ^6.3.6 | Build toolchain |
| `@vercel/react-router` | ^1.2.6 | Vercel serverless adapter |
| `@shopify/polaris-types` | ^1.0.1 | Polaris web component types |
| `@mdx-js/react`, `@mdx-js/rollup` | ^3.1.1 | Blog post MDX |
| `eslint`, `prettier` | various | Lint / format |

### Folder Structure
```
app/
  routes/                # All RR7 routes (~37 files)
  components/            # Dashboard UI components
    AIVisibilityCard.tsx, AuditChecklist.tsx, KpiCards.tsx,
    PolicyGenerationCard.tsx, ScanProgressIndicator.tsx,
    ScoreBanner.tsx, ScoreTrend.tsx, SecurityStatusAside.tsx,
    UpgradeCard.tsx
    marketing/           # Landing/blog/fix-page UI
      Button.tsx, HeroMock.tsx, JsonLd.tsx,
      MarketingArticleLayout.tsx, MarketingLayout.tsx
  hooks/
    useWebComponentClick.ts    (native DOM events for Polaris web components)
  lib/                    # Server-only business logic
    checks/               # 12 compliance check modules + helpers + orchestrator
      types.ts, constants.ts, helpers.server.ts, safe-check.server.ts
      contact-information.server.ts, refund-return-policy.server.ts,
      shipping-policy.server.ts, privacy-and-terms.server.ts,
      product-data-quality.server.ts, checkout-transparency.server.ts,
      storefront-accessibility.server.ts, structured-data-json-ld.server.ts,
      page-speed.server.ts, business-identity-consistency.server.ts,
      hidden-fee-detection.server.ts, image-hosting-audit.server.ts,
      index.server.ts        (orchestrator + re-exports)
      public-scanner.server.ts (used by the public /scan route)
    billing/
      plans.ts             (PLANS, PLAN_NAME_TO_TIER, PLAN_NAME_TO_CYCLE,
                            hasMonitoringAccess, hasRecoveryAccess,
                            getManagedPricingUrl)
      partner-api.server.ts (Partner API client + getActiveSubscriptionByChargeId)
    llm/
      appeal-letter.server.ts (Anthropic-powered GMC appeal letter)
    enrichment/
      gtin-enrichment.server.ts (GTIN/MPN/brand metafield enricher)
    ai-visibility/
      identify-crawler.server.ts / identify-crawler.ts
    emails/
      send.server.ts, weekly-digest.ts
    compliance-scanner.server.ts   (barrel re-export from checks/)
    graphql-queries.server.ts      (GraphQL strings + response types)
    graphql-client.server.ts       (client infra, retry, executors)
    shopify-api.server.ts          (public API: getShopInfo, getShopPolicies, etc.)
    policy-generator.server.ts     (Anthropic-powered policy generation)
    session-storage.server.ts      (custom Supabase session adapter)
    crypto.server.ts               (AES-256-GCM encrypt/decrypt)
    rate-limiter.server.ts         (persistent rate limiting via Supabase, in-mem fallback)
    json-ld-verifier.server.ts     (Fix 3 — confirms storefront block renders)
    json-ld-deep-link.ts           (Fix 7 — getJsonLdThemeEditorUrl helper)
    sentry.server.ts               (Sentry wrapper; init runs at module load)
    types.ts                       (shared UI types: Merchant, Scan, etc.)
    constants.ts, scan-helpers.ts, blog.ts, brand.ts
  shopify.server.ts        # Shopify app config, afterAuth hook
  supabase.server.ts       # Supabase client singleton (service-role)
  root.tsx, entry.server.tsx, routes.ts, globals.d.ts, styles.css
scripts/
  outbound-scanner.ts                # Standalone CLI scanner (no OAuth)
  backfill-merchant-shop-info.ts     # One-off merchant metadata refresh
  cleanup-orphan-webhooks.ts         # Deletes orphan webhook subscriptions from old dev tunnels
  dev-cleanup-subs.ts                # Dev helper to cancel test subscriptions
  top-criticals.ts                   # Ops query on hot critical checks
  validate-partner-api.ts            # Smoke test for Partner API plumbing
supabase/
  schema.sql           # Cumulative bootstrap snapshot (Fix 10 rebuild on 2026-05-27)
  migrations/          # Numbered migrations — source of truth for ordering
extensions/
  json-ld-schema/      # Theme extension: Product/Organization/WebSite JSON-LD blocks
tests/                 # Vitest regression suites (9 files, 233 tests on 2026-05-28)
```

---

## 3. Shopify Integration

### App Configuration (`shopify.app.toml`)
* **client_id:** `071fc51ee1ef7f358cdaed5f95922498`
* **App type:** Embedded (`embedded = true`)
* **application_url:** `https://shieldkit.vercel.app`
* **Build setting:** `automatically_update_urls_on_dev = false` (prevents `shopify app dev` from overwriting production webhook URLs with dev tunnel URLs)
* **Webhooks API version:** `2026-04`
* **Access scopes (8):** `read_products,read_content,read_legal_policies,write_products,read_shipping,read_locations,read_themes,write_themes`. The `write_products`, `write_themes`, `read_themes`, `read_shipping`, `read_locations` additions are intentional and unlock GTIN auto-fill + theme/shipping/location reads — not drift, despite the read-only history of the app.
* **Auth redirect URLs:**
  - `https://shieldkit.vercel.app/auth/callback`
  - `https://shieldkit.vercel.app/auth/shopify/callback`
  - `https://shieldkit.vercel.app/api/auth/callback`
* **Distribution:** AppStore
* **App Proxy:** `[app_proxy]` block registers `/apps/llms-txt` → `/api/proxy/llms-txt` (prefix `apps`, subpath `llms-txt`).

### App Bridge & Auth (`app/shopify.server.ts`)
* **API Version:** `ApiVersion.October25` (Shopify Admin API `2025-10`)
* **Runtime scopes:** `process.env.SCOPES ?? "read_products,read_content,read_legal_policies"`. In production `SCOPES` is set from the toml string, so the granted set is all 8.
* **Session storage:** Custom `SupabaseSessionStorage` class (`app/lib/session-storage.server.ts`); replaces the SDK's Prisma/SQLite default.
* **Token rotation:** `expiringOfflineAccessTokens: true` — refresh tokens stored encrypted in `sessions`.
* **afterAuth hook:** Fires on every OAuth completion (install + re-auth). For offline sessions only: upserts a `merchants` row, encrypts `access_token`, sets `installed_at`, clears `uninstalled_at`.
* **authenticate.admin(request):** Validates App Bridge 4.x JWT on every `/app/*` route.
* **No `billing` config registered.** Under managed pricing the plan registry lives in the Partner Dashboard. `billing.request()` / `billing.cancel()` are not called anywhere.

### Webhook Subscriptions
Declared in `shopify.app.toml` and handled by route files. All use `authenticate.webhook(request)` which verifies `X-Shopify-Hmac-Sha256`; invalid HMAC auto-returns 401.

| Topic | Route File | Behaviour |
|-------|-----------|-----------|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Deletes sessions, soft-deletes merchant (`uninstalled_at = NOW()`). On Supabase write failure, inserts a `webhook_failures` audit row (best-effort try/catch around that too — webhook ACK is never blocked). Always returns 200. The daily `reconcile-installs` cron is the durable safety net for lost deliveries. |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Updates session scope string. |
| `app_subscriptions/update` | `webhooks.app_subscriptions.update.tsx` | Pre-April-28 supplementary path: maps plan name → tier + billing_cycle via `PLAN_NAME_TO_TIER` / `PLAN_NAME_TO_CYCLE`. On `ACTIVE` persists tier/billing_cycle/subscription_started_at/shopify_subscription_id; on terminal statuses resets to free with `scans_remaining=1`. Post-April-28 the Partner API path is canonical. |
| `products/create`, `products/update` | `webhooks.products.update.tsx` | HMAC + merchant lookup. For monitoring-access tiers: enqueues a `pending_scan_triggers` row (`trigger_type='product_update'`, 24h-deduped) plus, when `write_products` is granted, enqueues a second row (`trigger_type='enrichment'`, payload `{ product_gid, numeric_product_id }`, dedup'd against `schema_enrichments` and the queue) for the drainer to run enrichment off the hot path. Returns 200 in <1s. |
| `themes/update`, `themes/publish` | `webhooks.themes.update.tsx` | HMAC + merchant lookup. For monitoring-access tiers: inserts a `pending_scan_triggers` row (`trigger_type='theme_update'` or `'theme_publish'`, 24h-deduped). Always 200. |
| `customers/data_request` | `webhooks.customers.data_request.tsx` | GDPR. Logs and 200 (no customer PII stored). |
| `customers/redact` | `webhooks.customers.redact.tsx` | GDPR. 200 (no customer PII to delete). |
| `shop/redact` | `webhooks.shop.redact.tsx` | GDPR. Hard-deletes merchant row 48h post-uninstall (CASCADE to scans → violations). |

### Billing — Shopify Managed Pricing

Plans are defined in the **Partner Dashboard** listing UI, not in code. The codebase does not register a `billing` config on `shopifyApp({...})` and does not call `billing.request()` / `billing.cancel()`. Pick-a-plan, switch, and cancel are all hosted on `admin.shopify.com`.

**Plan name strings registered in the Partner Dashboard** (must match the keys in `PLAN_NAME_TO_TIER` / `PLAN_NAME_TO_CYCLE`):

Current offerings:
| Name | Price | DB tier | billing_cycle |
|------|-------|---------|---------------|
| `Monitoring` | $30/mo | `monitoring` | `monthly` |
| `Monitoring Annual` | $290/yr | `monitoring` | `annual` |
| `Recovery` | $150/yr | `recovery` | `annual` |

Grandfathered (not offered to new merchants, kept so existing subscriptions reconcile):
| Name | Price | DB tier | billing_cycle |
|------|-------|---------|---------------|
| `Shield Pro` | $14/mo | `shield` | `monthly` |
| `Shield Pro Annual` | $140/yr | `shield` | `annual` |
| `Shield Max` | $39/mo | `pro` | `monthly` |
| `Shield Max Annual` | $390/yr | `pro` | `annual` |

**Billing flow (Fix 1 — 2026-05-27):**
1. Merchant clicks an upgrade button → navigates to `/app/upgrade` (or `/app/plan-switcher`).
2. The route is a loader + component that returns the managed-pricing URL via `getManagedPricingUrl(session.shop)` and `useEffect`s `window.open(url, "_top")` to escape the embedded iframe (Shopify admin sends `X-Frame-Options: DENY`, so a server-side `redirect()` cannot navigate the parent window). Fallback link rendered for popup-blocker cases.
3. Merchant picks/switches/cancels on Shopify's hosted page.
4. After approval/decline, Shopify redirects to the Welcome link configured in the Partner Dashboard (`${SHOPIFY_APP_URL}/app/billing/confirm`).
5. `app.billing.confirm.tsx` loader calls `getActiveSubscriptionByChargeId(charge_id)` (Partner API — the only path; legacy `billing.check()` fallback was removed in Fix 1). Status handling:
   - `active` (+ paid tier) → write `tier`, `billing_cycle`, `subscription_started_at`, `shopify_subscription_id`, `scans_remaining=null` → redirect `/app`.
   - `cancelled` / `declined` / `expired` → redirect `/app?billing=cancelled`.
   - `unknown` / `pending` / `frozen` / missing `charge_id` → render the "Confirming your subscription…" pending page with a Refresh button. **Never demote on uncertainty.**
6. `APP_SUBSCRIPTIONS_UPDATE` webhook (pre-April-28) is a backstop reconciliation channel.
7. `reconcile-subscriptions` cron (daily 04:00 UTC) post-April-28 walks paid merchants and demotes on terminal Partner-API status.

**Dashboard billing self-heal (Fix 6 — 2026-05-27):** The Partner API reconciliation call was moved off the dashboard loader (was blocking every paid-merchant render on an external GraphQL roundtrip). It now runs once on dashboard mount via a `selfHealBilling` action fired from a `useEffect` (skipped for free tier; once-only `useRef` guard). On `healed=true` the component calls `revalidator.revalidate()`. `app.billing.confirm.tsx` keeps its inline self-heal because that path is user-facing post-approval where a 1–2s wait is the right UX.

**`getManagedPricingUrl`** throws loudly if `SHOPIFY_APP_HANDLE` is unset.

**Paid tier features** (gated via `hasMonitoringAccess` / `hasRecoveryAccess`):

Monitoring access (`hasMonitoringAccess` — Monitoring + Recovery + grandfathered Shield Max `'pro'`):
- Unlimited re-scans (`scans_remaining = null`)
- Automated weekly compliance scans (`MONITORING_TIERS = ('monitoring','recovery','pro')`)
- Weekly health digest email via Resend
- AI bot allow/block toggle (`/app/bots/toggle`)
- llms.txt App Proxy at `/apps/llms-txt`
- Pro Settings form (`/app/pro-settings`) — logo, support email, social URLs, search-URL template
- Organization & WebSite JSON-LD theme blocks
- Ongoing GTIN/MPN/brand enrichment on newly-created products (via `products/update` webhook → `enrichment` trigger → drainer)
- AI-visibility tracking

Recovery access (`hasRecoveryAccess` — Recovery + grandfathered Shield Max `'pro'`):
- GMC re-review appeal letter generator (`/app/appeal-letter`)
- AI policy generation (Anthropic `claude-sonnet-4-20250514`)
- Bulk GTIN/MPN/brand fill on existing catalog (`/app/gtin-fill`)

**Free tier:** 1 scan. Resets monthly via Vercel Cron (`/api/cron/monthly-reset`).

---

## 4. Database Schema (Supabase)

Project ref: `bhnpcirhutczdorkhibm`. The project is named "ShieldKit-Dev" in the Supabase dashboard but **is the live production database** — single-project setup, no dev/prod split, real merchants and paying customers.

All tables have RLS enabled; the app uses the `service_role` key which bypasses RLS. Live shape verified 2026-05-28.

### Table: `sessions`
Shopify OAuth session storage. Replaces the default Prisma adapter.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Session ID from Shopify |
| `shop` | TEXT NOT NULL | e.g. `mystore.myshopify.com` |
| `state` | TEXT NOT NULL | OAuth state param |
| `is_online` | BOOLEAN DEFAULT false | Online (user) vs offline (merchant) session |
| `scope` | TEXT | Comma-separated granted scopes |
| `expires` | TIMESTAMPTZ | Session expiry |
| `access_token` | TEXT DEFAULT '' | **Encrypted** (AES-256-GCM) |
| `user_id` | BIGINT | Online session user fields |
| `first_name`, `last_name`, `email` | TEXT | |
| `account_owner` | BOOLEAN DEFAULT false | |
| `locale`, `collaborator`, `email_verified` | TEXT / BOOLEAN | |
| `refresh_token` | TEXT | **Encrypted**. For token rotation. |
| `refresh_token_expires` | TIMESTAMPTZ | |

Index: `idx_sessions_shop` on `(shop)`.

### Table: `merchants`
One row per installed shop. Soft-deleted on uninstall; hard-deleted by `shop/redact` 48h later.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK `gen_random_uuid()` | |
| `shopify_domain` | TEXT NOT NULL UNIQUE | e.g. `mystore.myshopify.com` |
| `access_token_encrypted` | TEXT | AES-256-GCM-encrypted offline token |
| `tier` | TEXT NOT NULL DEFAULT 'free' | CHECK constraint: `('free','shield','pro','monitoring','recovery')` |
| `scans_remaining` | INTEGER (nullable) DEFAULT 1 | `null` = unlimited (paid), `0` = exhausted, `n>0` = available |
| `scans_reset_at` | TIMESTAMPTZ DEFAULT now() | Free-tier quota refill timestamp |
| `billing_cycle` | TEXT | CHECK: `('monthly','annual')`. NULL on free. |
| `subscription_started_at` | TIMESTAMPTZ | NULL on free. |
| `shopify_subscription_id` | TEXT | GraphQL gid of the active subscription. |
| `pro_settings` | JSONB DEFAULT '{}'::jsonb | Monitoring-access settings (column name predates v3 rebrand). Holds logo_url, support_email, social URLs, search_url_template, bot_preferences (Record<botId, "allow"\|"block">). |
| `json_ld_enabled` | BOOLEAN DEFAULT false | **Verified state** — flipped true **only by the verifier** after positive storefront confirmation (Fix 3 — 2026-05-27). |
| `json_ld_enable_clicked_at` | TIMESTAMPTZ | Set when merchant clicks "Enable JSON-LD" (intent, not state). |
| `json_ld_verified_at` | TIMESTAMPTZ | Set by `json-ld-verifier.server.ts` on positive confirmation. |
| `json_ld_verification_attempts` | INT NOT NULL DEFAULT 0 | Bounded retry budget. After 5 attempts OR 7 days, verifier resets `clicked_at = NULL` so the UI re-prompts. |
| `generated_policies` | JSONB DEFAULT '{}'::jsonb | `{ refund?, shipping?, privacy?, terms? }` from AI generator. |
| `policy_regen_used` | JSONB DEFAULT '{}'::jsonb | One regen per policy type. |
| `review_prompted` | BOOLEAN DEFAULT false | Set true when merchant dismisses review banner. |
| `llms_txt_last_served_at` | TIMESTAMPTZ | Fire-and-forget update from `api.proxy.llms-txt.ts` on every response. Drives the digest's AI Readiness Score freshness term. |
| `shop_name` | TEXT | Shopify metadata (opportunistically refreshed every scan) |
| `shop_owner_name`, `contact_email` | TEXT | |
| `country`, `province`, `city` | TEXT | From `shop.billingAddress` |
| `currency_code`, `shopify_plan`, `primary_domain` | TEXT | |
| `shop_created_at` | TIMESTAMPTZ | `shop.createdAt` — store age signal |
| `iana_timezone` | TEXT | |
| `shop_metadata_refreshed_at` | TIMESTAMPTZ | Set on every successful metadata refresh |
| `installed_at` | TIMESTAMPTZ DEFAULT now() | |
| `uninstalled_at` | TIMESTAMPTZ | Soft-delete marker |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Indexes verified on the live DB: `merchants_pkey`, `merchants_shopify_domain_key`, `idx_merchants_domain (shopify_domain)`, `idx_merchants_country (country) WHERE uninstalled_at IS NULL`. **Note:** the `idx_merchants_active` index claimed in `supabase/schema.sql` does NOT exist on the live DB — schema.sql drift, harmless (only affects bootstrap-from-scratch parity).

RLS Policy: `merchants_shop_isolation` (`shopify_domain = current_setting('app.current_shop', true)`).

CASCADE: deleting a merchant cascades to scans → violations.

### Table: `leads`
Lead collection for retargeting; one row per shop.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT NOT NULL PK | _Live shape — `supabase/schema.sql` documents UUID; that's drift._ |
| `shop_domain` | TEXT NOT NULL UNIQUE | |
| `email` | TEXT (nullable) | _Live shape allows NULL — schema.sql claims NOT NULL._ |
| `public_risk_score` | INT (nullable) | Persisted by `/scan` public route. |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### Table: `scans`
One row per compliance scan run.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | |
| `scan_type` | TEXT DEFAULT 'manual' | CHECK: `('manual','automated')` |
| `compliance_score` | NUMERIC(5,2) | 0–100 |
| `total_checks`, `passed_checks` | INTEGER | |
| `critical_count`, `warning_count`, `info_count` | INTEGER | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Indexes verified live: `scans_pkey`, `idx_scans_merchant_id`. **Note:** `idx_scans_created_at (created_at DESC)` claimed by schema.sql does NOT exist on the live DB — schema.sql drift.

### Table: `violations`
Individual check results per scan.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `scan_id` | UUID FK → scans(id) ON DELETE CASCADE | |
| `check_name` | TEXT NOT NULL | e.g. `contact_information` |
| `passed` | BOOLEAN DEFAULT false | |
| `severity` | TEXT | CHECK: `('critical','warning','info','error')` |
| `title`, `description`, `fix_instruction` | TEXT | Human-readable |
| `raw_data` | JSONB | Machine-readable check details |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Indexes verified live: `violations_pkey`, `idx_violations_scan_id`, `idx_violations_raw_data (GIN)`. **Note:** `idx_violations_severity` claimed by schema.sql does NOT exist on the live DB — schema.sql drift.

### Table: `scan_rate_limits`
Persistent rate limiting for scan API requests.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `shop` | TEXT NOT NULL | |
| `requested_at` | TIMESTAMPTZ DEFAULT now() | |

Index: `idx_rate_limits_shop_time (shop, requested_at)`.

### Function: `decrement_scan_quota(p_merchant_id UUID)`
Atomic decrement; returns `(new_scans_remaining INTEGER)` or no rows when quota already 0 / NULL. Both scan entry points call this to avoid races.

### Table: `digest_emails`
Audit log of weekly digest sends — one row per attempt.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | |
| `sent_at` | TIMESTAMPTZ DEFAULT now() | |
| `scan_id` | UUID FK → scans(id) | |
| `new_issues_count`, `fixes_confirmed_count` | INTEGER | |
| `email_provider_id` | TEXT | Resend message id on success; `'FAILED:<reason>'` (including `'FAILED:no_email_on_file'`) on failure. Optionally suffixed `|src=shopify_owner` when the shop-owner email fallback was used. |

Index: `idx_digest_merchant_time (merchant_id, sent_at DESC)`.

### Table: `appeal_letters`
GMC re-review appeal letter generations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | |
| `scan_id` | UUID FK → scans(id) | Capped at 3 per scan_id by row counting at the route. |
| `suspension_reason` | TEXT | Merchant-supplied form input |
| `generated_letter` | TEXT | Claude Sonnet output |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

### Table: `schema_enrichments`
GTIN/MPN/brand enrichment audit log.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | |
| `product_id` | BIGINT NOT NULL | UNIQUE per `(merchant_id, product_id)` — backs the 24h enrichment dedup in `webhooks.products.update.tsx` and `api.cron.process-scan-triggers.ts`. |
| `enriched_fields` | TEXT[] | e.g. `['gtin','mpn','brand']` |
| `metafield_values` | JSONB | Currently always written as `{}` (values not persisted) |
| `enriched_at` | TIMESTAMPTZ DEFAULT now() | |

Indexes: `schema_enrichments_pkey`, `schema_enrichments_merchant_id_product_id_key (UNIQUE)`, `idx_schema_enrich_merchant (merchant_id, enriched_at DESC)`.

### Table: `enrichment_webhook_log`
One row per products/update webhook delivery for diagnostics.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `merchant_id` | UUID FK → merchants(id) | |
| `product_id` | TEXT | |
| `topic` | TEXT | |
| `outcome` | TEXT | `enqueued` (Fix 9 — was `enriched` / `noop` before) / `skip_tier` / `skip_scope` / `skip_dedup` / `skip_already_queued` / `skip_uninstalled` / `skip_no_merchant` / `skip_no_product_id` / `error` |
| `written_keys` | TEXT[] | |
| `error_message` | TEXT | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Index: `idx_enrichment_log_merchant_created (merchant_id, created_at DESC)`.

### Table: `llms_txt_requests`
AI-visibility tracking — one row per llms.txt request served.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `shop_domain` | TEXT NOT NULL | |
| `merchant_id` | UUID FK → merchants(id) | |
| `user_agent` | TEXT | |
| `crawler_name` | TEXT | Normalised via `identifyCrawler()` |
| `ip_hash` | TEXT | sha256 of IP with last octet (v4) / 64 bits (v6) stripped before hashing |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Index: `idx_llms_requests_shop_created (shop_domain, created_at DESC)`.

### Table: `pending_scan_triggers`
Storefront-monitoring + enrichment queue. Inserted by `webhooks.themes.update`, `webhooks.products.update`, and the weekly-scan cron. Drained by `api.cron.process-scan-triggers.ts`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `merchant_id` | UUID FK → merchants(id) | |
| `trigger_type` | TEXT | One of `weekly_scan`, `theme_update`, `theme_publish`, `product_update`, `enrichment`. |
| `trigger_at` | TIMESTAMPTZ DEFAULT now() | |
| `processed_at` | TIMESTAMPTZ | NULL = unprocessed |
| `week_iso` | TEXT | Fix 8 — set only by the weekly-scan cron (e.g. `"2026-W22"`). Event-driven inserts leave NULL. |
| `payload` | JSONB | Fix 9 — currently only set for `trigger_type='enrichment'` as `{ product_gid, numeric_product_id }`. |

Indexes verified live: `pending_scan_triggers_pkey`, `idx_pending_scans_unprocessed (merchant_id, processed_at) WHERE processed_at IS NULL`, `uq_pending_scan_triggers_week (merchant_id, trigger_type, week_iso) WHERE week_iso IS NOT NULL` (Fix 8 partial unique — makes weekly-cron retries no-ops).

### Table: `webhook_failures` (Fix 4 — 2026-05-27)
Audit + retry-queue for webhook deliveries whose side-effect writes failed.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `topic` | TEXT NOT NULL | Today only `app/uninstalled` writes here |
| `shop` | TEXT NOT NULL | |
| `payload` | JSONB | Raw webhook payload |
| `error_message` | TEXT | |
| `resolved_at` | TIMESTAMPTZ | NULL = unresolved hot set; populated by reconciler when it back-fills |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Indexes: `idx_webhook_failures_unresolved (topic, shop) WHERE resolved_at IS NULL`, `idx_webhook_failures_created_at (created_at DESC)`.

---

## 5. Scan Engine

### How scans are triggered

**Path A — Dashboard form submit** (`app._index.tsx` action `runScan`):
1. Merchant clicks "Run My Free Compliance Scan" → form POST `action=runScan`
2. Action authenticates, looks up merchant, atomically decrements quota via `decrement_scan_quota` RPC
3. Calls `runComplianceScan(merchant.id, shopDomain, "manual")`
4. On scan failure, refunds the decremented quota (compensating transaction)
5. Fire-and-forget lead capture (Shopify `shop { email }` → `leads` table)
6. Returns `{ success: true, scanId }`. Fetcher state change triggers toast + loader revalidation.

**Path B — API endpoint** (`api.scan.ts`):
1. POST `/api/scan` with App Bridge JWT
2. Authenticates, rate-limits (persistent via `scan_rate_limits`), looks up merchant
3. Atomic quota decrement (402 if exhausted)
4. Runs scan; same compensating refund on failure
5. Returns full scan + violations + summary JSON

**Path C — Weekly cron + drainer**:
1. Vercel Cron Mondays 08:00 UTC hits `/api/cron/weekly-scan`. Bearer `CRON_SECRET`. Fetches all active merchants with `tier IN MONITORING_TIERS` and upserts one trigger per merchant `(trigger_type='weekly_scan', week_iso=<this ISO week>)` with `onConflict=(merchant_id,trigger_type,week_iso) ignoreDuplicates=true` (Fix 8). Idempotent within the week.
2. GitHub Actions cron (`.github/workflows/process-scan-triggers.yml`) curls `/api/cron/process-scan-triggers` every 30 minutes (primary drain path). Vercel Cron also hits the same endpoint daily 12:00 UTC as a documented safety net (restored 2026-05-28 after audit).
3. The drainer pulls `BATCH_SIZE=1` unprocessed row, splits scan-class vs `enrichment` triggers, runs the appropriate work, and marks `processed_at`.

**Path D — Event-driven triggers**:
- `webhooks.products.update.tsx` enqueues `product_update` (24h dedup) + `enrichment` (per-product dedup against `schema_enrichments` and the queue).
- `webhooks.themes.update.tsx` enqueues `theme_update` or `theme_publish` (24h dedup).

### Scan execution (`app/lib/checks/index.server.ts`)

`runComplianceScan(merchantId, shopifyDomain, scanType)`:

1. **Build admin GraphQL client** via `createAdminClient(shopifyDomain)` — reads offline session token first (always fresh), falls back to encrypted `merchants.access_token_encrypted`.
2. **Fetch Shopify data** concurrently: `getShopInfo()`, `getShopPolicies()`, `getProducts(50)`, `getPages(20)`.
3. **Opportunistic metadata refresh** (fire-and-forget): UPDATE merchant row with shop_name, shop_owner_name, contact_email, country/province/city, currency_code, shopify_plan, primary_domain, shop_created_at, iana_timezone, shop_metadata_refreshed_at.
4. **Pre-fetch public storefront pages** (concurrent): homepage + up to 3 product pages via `fetchPublicPage()` (SSRF-protected DNS pre-check).
5. **Run all 12 checks** in two concurrent batches via `Promise.all`, each wrapped in `safeCheck()` (exceptions → severity `"error"`, scan continues).
6. **Calculate score**: `(passedChecks / scorableTotal) * 100`. Errored checks excluded from denominator.
7. **Persist**: INSERT `scans` row, bulk INSERT `violations` rows with `raw_data` JSONB.

Adding a new check: import in `index.server.ts`, add to one of the two `Promise.all` batches, add to the destructured array, add to `checkResults`. **No auto-discovery** — manual registry.

### The 12 Compliance Checks

#### Check 1: `contact_information` (severity: critical)
**What:** Verifies the store publicly displays at least 2 of 3 contact methods: phone number, store-domain email, physical street address.
**How:** Scans HTML of contact/about pages from Shopify Pages GraphQL. Also checks `shopInfo.billingAddress` as fallback. Regex patterns; flags PO Boxes.
**Pass:** ≥2 methods publicly visible.

#### Check 2: `refund_return_policy` (severity: critical)
**Detection order (Fix 2 — 2026-05-27):**
1. Settings → Policies → Refund Policy (canonical)
2. **Fallback:** search the merchant's online-store Pages for handle/title matching `/refund|return/i` and treat that page's body as policy content
3. If neither produces content → fail
**Content signals:** return window regex, item condition regex, refund method regex, placeholder-text detector.
**Pass:** ≥1 source produces a body that passes all three content regex; the Page-fallback path passes with severity `info` and an advisory pointing the merchant to register the policy in Settings → Policies (so it lands in the footer for GMC reviewers).

#### Check 3: `shipping_policy` (severity: critical)
Same Page-fallback pattern with pattern `/shipping|delivery/i`. Content regex: TIMELINE_RE + COST_RE.
**Pass:** Both signals present from policy OR page; page-fallback PASS surfaces an `info` advisory.

#### Check 4: `privacy_and_terms` (severity: critical/warning)
**Detection order (Fix 2):** Privacy and Terms evaluated independently. For each: Settings → Policies first, then Pages search (`/privacy/i` for privacy, `/terms|tos|conditions/i` for terms). Body just needs to be non-blank to count as present.
**Pass:** both present. Privacy missing → critical. Terms missing alone → warning. When either side was found via the Page fallback, the PASS result emits an `info` advisory.

#### Check 5: `product_data_quality` (severity: warning)
Iterates fetched products (up to 50). Flags products with short descriptions, zero images, bad pricing, missing SKUs.
**Pass:** <20% flagged.

#### Check 6: `checkout_transparency` (severity: warning)
Cheerio search of pre-fetched homepage HTML for 26 payment keywords across img/SVG/CSS classes/aria-labels/data attributes.
**Pass:** ≥1 payment icon found.

#### Check 7: `storefront_accessibility` (severity: critical)
Detects password protection on the homepage HTML. Verifies HTTP status of up to 3 sampled product pages.
**Pass:** not password-protected AND all sampled products return 200.

#### Check 8: `structured_data_json_ld` (severity: warning)
Parses pre-fetched product page HTML. Validates Product JSON-LD required fields (name, image, description, offers with price/currency/availability).
**Pass:** all scanned pages have valid Product schema.

#### Check 9: `page_speed` (severity: warning)
Google PageSpeed Insights API, mobile strategy. Extracts performance score; flags intrusive interstitials.
**Pass:** performance score ≥50 AND no intrusive interstitials.

#### Check 10: `business_identity_consistency` (severity: info)
Jaccard similarity (60% domain + 40% about-page) with stop-word removal. Threshold 0.3.

#### Check 11: `hidden_fee_detection` (severity: critical)
Cheerio-stripped visible text scan over up to 5 product pages + `/cart` (fetched at run time, SSRF-protected) + homepage. Each detected fee term checked against shipping + refund policy bodies; undisclosed terms fail.

#### Check 12: `image_hosting_audit` (severity: critical)
Samples first 20 products. Regex over `src/srcset/data-src` URLs against the dropshipper-host list (cjdropshipping, alicdn, alibaba, aliexpress, codepen, netease, uupingo).
**Pass:** zero matches.

---

## 6. Results Delivery

### Dashboard
After a scan, `app._index.tsx` loader revalidates and renders (in order, inside `<s-page>`):
- **Primary-action `<s-button>` slot** — "Re-Scan My Store" (paid or quota remaining) or "Manage plan" (free + exhausted)
- **Scan error banner** (when `scanError` truthy)
- **Billing cancellation banner** (when `?billing=cancelled` URL param)
- **Onboarding wizard** (when `latestScan === null`) — see §6.1
- **Dashboard block** (when latestScan exists):
  - `ScanProgressIndicator` (during scan)
  - `ScoreBanner`
  - `ScoreTrend` (30-day sparkline)
  - `KpiCards` (Passed / Critical / Warnings / Skipped)
  - Review request banner
  - Inline upgrade banner (free → "See plans"; monitoring → "See Recovery")
  - `AuditChecklist` (12-point, sorted failed-first by severity)
- **Aside (always)**:
  - `SecurityStatusAside`
  - `UpgradeCard` (when `!showRecovery`)
  - `PolicyGenerationCard` (when `showRecovery`)
  - `AIVisibilityCard` (when `showMonitoring` and `aiVisibility` data exists)
  - Free JSON-LD Structured Data card (three-state UI from `clicked_at` / `verified_at`)
  - About ShieldKit

### 6.1 Onboarding wizard (Fix 5 — 2026-05-27)

Trigger: `showOnboarding = latestScan === null`. The wizard is **4 static info cards** + a primary CTA. There is no `onboarding_step` persistence — re-opening the app before the first scan re-renders the same cards from scratch every time.

| # | Title | Content |
|---|-------|---------|
| 1 | Welcome to ShieldKit | Describes the **12-point audit** |
| 2 | Enable Free Structured Data | "Adds Google-required Product schema to every product page." CTA: "Enable JSON-LD on my theme" — wires to `enableJsonLd` action + opens the theme editor via `getJsonLdThemeEditorUrl(shopDomain)`. State badge: never_clicked → CTA button, clicked → "Pending verification…", verified → "Enabled ✓" |
| 3 | Why GMC Compliance Matters | Explainer about Misrepresentation suspensions |
| 4 | Run Your Free Compliance Scan | Pre-CTA copy |

Primary CTA below all four: `<s-button submit="">Run My Free Compliance Scan →</s-button>`. The merchant can skip step 2 and still scan — the scan flow doesn't depend on JSON-LD state.

After a successful scan, the loader revalidates and the dashboard renders in place — no redirect, same `/app` route.

### Lead collection
On first scan, the shop owner email is collected via GraphQL (`shop { email }`) and upserted into `leads`. Fire-and-forget. No email is sent at this point — leads are for retargeting.

---

## 7. Route Map

### Authenticated app routes (all gated by `authenticate.admin` in `app.tsx`)

| Route File | URL Path | Type | Behaviour |
|-----------|----------|------|-----------|
| `app.tsx` | `/app` (layout) | Layout | Wraps `/app/*`. NavMenu: Dashboard + Manage plan always; Pro Settings + AI bot toggle when `hasMonitoringAccess(tier)`; Appeal letter + GTIN auto-filler when `hasRecoveryAccess(tier)` AND `WRITE_METAFIELDS_SCOPE_ENABLED`. |
| `app._index.tsx` | `/app` | Loader + Action + Component | Onboarding wizard OR dashboard, depending on whether any scan exists. Actions: `runScan`, `generatePolicy`, `dismissReview`, `enableJsonLd`, `verifyJsonLdNow`, `selfHealBilling`. |
| `app.upgrade.tsx` | `/app/upgrade` | Loader + Component | Returns the managed-pricing URL via `getManagedPricingUrl(shopDomain)`; component `useEffect`s `window.open(url, "_top")` to escape the embedded iframe. Renders fallback link for popup-blocker cases. _Not a loader-only redirect — Shopify admin sends `X-Frame-Options: DENY` so server `redirect()` cannot navigate the parent frame._ |
| `app.billing.confirm.tsx` | `/app/billing/confirm` | Loader (+ component for pending state) | Welcome-link landing post-managed-pricing approval. Partner-API-only path; on uncertain status renders a pending page (Fix 1) rather than redirecting to `?billing=cancelled`. |
| `app.plan-switcher.tsx` | `/app/plan-switcher` | Loader + Component | Same iframe-escape pattern as `/app/upgrade` — opens managed pricing in `_top`. |
| `app.appeal-letter.tsx` | `/app/appeal-letter` | Loader + Action + Component | Recovery access required. GMC re-review letter generator. 3 generations per scan cap. Claude Sonnet via `app/lib/llm/appeal-letter.server.ts`. |
| `app.pro-settings.tsx` | `/app/pro-settings` | Loader + Action + Component | Monitoring access required. Logo, support email, social URLs, search-URL template — persisted to `merchants.pro_settings`. |
| `app.bots.toggle.tsx` | `/app/bots/toggle` | Loader + Action + Component | Monitoring access required. 11 AI crawler allow/block toggles. Renders live `robots.txt` snippet. |
| `app.gtin-fill.tsx` | `/app/gtin-fill` | Loader + Action + Component | Recovery access required. Bulk fill on existing catalog. Currently enabled in production because `WRITE_METAFIELDS_SCOPE_ENABLED` is true (the toml grants `write_products`). |

### API routes

| Route File | URL Path | Method | Behaviour |
|-----------|----------|--------|-----------|
| `api.scan.ts` | `/api/scan` | POST | Authenticated scan endpoint. Rate-limited + atomic quota. Returns full scan JSON. GET → 405. |
| `api.cron.weekly-scan.ts` | `/api/cron/weekly-scan` | POST | Vercel Cron Mon 08:00 UTC. Bearer `CRON_SECRET`. Upserts one `pending_scan_triggers` row per monitoring-access merchant with `week_iso` — idempotent within the week. |
| `api.cron.process-scan-triggers.ts` | `/api/cron/process-scan-triggers` | POST | Drains the queue, `BATCH_SIZE=1`, splits scan-class vs enrichment. Hit by GitHub Actions every 30 min (primary) AND Vercel Cron daily 12:00 UTC (failsafe — restored 2026-05-28). Bearer `CRON_SECRET` (identical for both callers). |
| `api.cron.weekly-digest.ts` | `/api/cron/weekly-digest` | POST | Vercel Cron Mon 13:00 UTC. Pulls last 2 scans per merchant, diffs failed-violation sets, sends digest via Resend, writes `digest_emails` row. No-op if `RESEND_API_KEY` unset. Per-merchant try/catch + 150ms pacing. |
| `api.cron.monthly-reset.ts` | `/api/cron/monthly-reset` | POST | Vercel Cron 1st of month 00:00 UTC. Refills `scans_remaining=1` for free-tier merchants whose `scans_reset_at` is >30 days old. |
| `api.cron.reconcile-subscriptions.ts` | `/api/cron/reconcile-subscriptions` | POST | Vercel Cron daily 04:00 UTC. Walks paid merchants, queries Partner API, demotes on terminal status. Never demotes on `unknown` (fail-safe). |
| `api.cron.verify-json-ld.ts` | `/api/cron/verify-json-ld` | POST | Vercel Cron every 2h (`0 */2 * * *`). Pulls up to 30 merchants with `clicked_at NOT NULL AND verified_at IS NULL AND attempts < 5`, oldest click first; runs `verifyJsonLdForMerchant` against each with 1s pacing. |
| `api.cron.reconcile-installs.ts` | `/api/cron/reconcile-installs` | POST | Vercel Cron daily 03:00 UTC. Walks `merchants.uninstalled_at IS NULL`, probes Shopify Admin API with `{ shop { id } }`. HTTP 401/403 or "No access token" → mark uninstalled + delete sessions + insert audit row in `webhook_failures` (resolved_at=now()). 500ms pacing. |
| `api.proxy.llms-txt.ts` | `/api/proxy/llms-txt` | GET | App Proxy endpoint, HMAC verified by `authenticate.public.appProxy`. Monitoring access required. Generates llms.txt from shop name/description/email + policies + first 50 published products. Per-process 24h in-memory cache. |

#### Weekly digest `aiReadinessScore`
Formula: `60% schema coverage + 30% llms.txt freshness + 10% bot config completeness`. All three inputs wired (schema from `schema_enrichments`, freshness from `merchants.llms_txt_last_served_at` ≤ 7d, bot config from `merchants.pro_settings.bot_preferences`). **Do not change the formula or remove the score without explicit founder approval.**

### Public routes

| Route File | URL Path | Behaviour |
|-----------|----------|-----------|
| `_index/route.tsx` | `/` | Landing page with 3 pricing cards (Free, Monitoring $30/mo or $290/yr, Recovery $150/yr). H1: "Fix Your Google Merchant Center Suspension Before It Costs You Sales." Emits Organization + FAQPage JSON-LD. Redirects to `/app` when `?shop` present. |
| `scan.tsx` | `/scan` | Public 8-point compliance scanner. Emits WebApplication JSON-LD. POST runs scan; second POST (`intent=unlock`) captures lead email. |
| `explainer.tsx` | `/explainer` | Long-form GMC misrepresentation explainer (Article JSON-LD). |
| `blog._index.tsx` | `/blog` | Listing pulled from `app/content/blog/*.mdx`. |
| `blog.$slug.tsx` | `/blog/:slug` | Individual blog post (BlogPosting JSON-LD). |
| `fix._index.tsx` | `/fix` | Fix Library index — 7 categories of programmatic-SEO fix pages. Emits ItemList JSON-LD. |
| `fix.$slug.tsx` | `/fix/:slug` | Programmatic-SEO fix page per entry in `app/content/fixes.ts`. HowTo + FAQPage JSON-LD. |
| `auth.login/route.tsx` | `/auth/login` | Shop domain form. |
| `auth.$.tsx` | `/auth/*` | Catch-all OAuth callback. |
| `privacy.tsx` | `/privacy` | App Store listing required. |
| `terms.tsx` | `/terms` | App Store listing required. |
| `sitemap[.]xml.tsx` | `/sitemap.xml` | Generated from static pages + blog MDX registry + fix registry. Static entries omit `<lastmod>`. |
| `robots[.]txt.tsx` | `/robots.txt` | Allow marketing crawlers; disallow `/app`, `/api`, `/auth`, `/webhooks`. |
| `llms[.]txt.tsx` | `/llms.txt` | Curated markdown content map for AI crawlers (marketing site). |

### Webhook routes
See §3 for full details.

---

## 8. Server Utilities

### Encryption (`app/lib/crypto.server.ts`)
* **Algorithm:** AES-256-GCM (authenticated encryption)
* **Key derivation:** `scryptSync(TOKEN_ENCRYPTION_KEY, "shieldkit-token-v1", 32)`; salt is static/public for key versioning
* **IV:** 12 bytes random per encryption; **Auth tag:** 128-bit
* **Ciphertext format:** `<hex_iv>:<hex_authTag>:<hex_ciphertext>`
* **Key requirement:** `TOKEN_ENCRYPTION_KEY` env var ≥32 characters

### Session Storage (`app/lib/session-storage.server.ts`)
Custom class implementing Shopify's `SessionStorage` interface. Encrypts `accessToken` and `refreshToken` before storage; decrypts on load with graceful fallback on decrypt failure (triggers re-auth).

### Shopify GraphQL API (`app/lib/shopify-api.server.ts` + split modules)
* **API Version:** `2025-10`
* **Queries:** `SHOP_INFO_QUERY`, `SHOP_POLICIES_QUERY`, `PRODUCTS_QUERY` (paginated, up to 250), `PAGES_QUERY` (paginated, up to 100)
* **Retry logic:** max 3 retries, 500ms base delay, exponential backoff. Detects THROTTLED errors.
* **Executor factories:** `wrapAdminClient()` for route handlers (uses request-scoped admin); `createAdminClient()` for background jobs (reads offline session token first, falls back to merchant token).

### Rate Limiter (`app/lib/rate-limiter.server.ts`)
* **Primary:** Persistent via Supabase `scan_rate_limits` table. 10 requests per hour per shop.
* **Fallback:** In-memory `Map` if DB table not deployed.
* **Cleanup:** Deletes records older than 1 hour on each check (fire-and-forget).

### Policy Generator (`app/lib/policy-generator.server.ts`)
* **Model:** `claude-sonnet-4-20250514`
* **Types:** refund, shipping, privacy, terms
* **Output:** HTML policy text → server-sanitized via `sanitize-html` → stored in `merchants.generated_policies` JSONB → client-sanitized again via `dompurify` before rendering
* **Limits:** 2 generations per policy type (initial + 1 regen), tracked in `policy_regen_used`

### Appeal Letter Generator (`app/lib/llm/appeal-letter.server.ts`)
Same Anthropic backbone; Recovery-only feature.

### GTIN Enrichment (`app/lib/enrichment/gtin-enrichment.server.ts`)
Per-product enrichment of `metafields.custom.{gtin,mpn,brand}`. Brand fallback chain: `existing brand metafield → product.vendor → shop.name`. Equivalent to the Liquid block's resolution order (`metafields.custom.brand → product.vendor → shop.name`); when missing, the server writes vendor/shop.name into the metafield so the Liquid template's metafield branch wins on the next page render.

After Fix 9 (2026-05-27) the enricher is called **only from the queue drainer** (`api.cron.process-scan-triggers.ts`) when a `trigger_type='enrichment'` row is processed — no longer inline in the webhook hot path.

### JSON-LD Verifier (`app/lib/json-ld-verifier.server.ts` — Fix 3)
`verifyJsonLdForMerchant(merchantId, shopifyDomain, primaryDomain)`:
1. Fetch homepage via `fetchPublicPage` (SSRF-protected, 8s timeout). Extract one `/products/<handle>` URL via regex; fetch that too.
2. Grep both HTML bodies for the `<!-- shieldkit-jsonld-v1 -->` marker emitted by `extensions/json-ld-schema/blocks/product-schema.liquid` AND confirm at least one `<script type="application/ld+json">` containing `"@type": "Product"`.
3. Positive: set `json_ld_verified_at = now()`, `json_ld_enabled = true`.
4. Negative: increment `json_ld_verification_attempts`. After 5 attempts OR `clicked_at` >7 days old, reset `clicked_at = NULL` so the UI re-prompts. **v1 does not tear down `json_ld_enabled` if a previously-verified merchant later removes the block — see Known Issues.**

### JSON-LD Deep Link (`app/lib/json-ld-deep-link.ts` — Fix 7)
`getJsonLdThemeEditorUrl(shopDomain, block = 'product-schema')` returns `https://{shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${SHOPIFY_API_KEY}/${block}`. Throws if `SHOPIFY_API_KEY` is unset. Replaces three previously-hard-coded literal client_id usages in `app._index.tsx`.

### Sentry (`app/lib/sentry.server.ts` — added 2026-05-27)
Initialised at server-module load via a side-effect import in `entry.server.tsx`. No-op when `SENTRY_DSN` unset — `addBreadcrumb` and `captureException` are still safe to call. Wired into `app.billing.confirm.tsx`, `api.cron.reconcile-installs.ts`, `webhooks.app.uninstalled.tsx`, and `json-ld-verifier.server.ts`; sprinkle more as needed.

### Supabase Client (`app/supabase.server.ts`)
Singleton pattern: dev caches on `global` to survive hot reload. Uses `service_role` key (admin access, bypasses RLS). Auth features disabled.

---

## 9. Scripts

| Script | Purpose |
|--------|---------|
| `scripts/outbound-scanner.ts` | Standalone CLI compliance scanner against any public Shopify storefront — no OAuth. SSRF-protected. Cannot check billingAddress, policy bodies, or product data quality (no Admin API). |
| `scripts/backfill-merchant-shop-info.ts` | Walks every installed merchant and refreshes the metadata columns via `getShopInfo()`. 250ms pacing. |
| `scripts/cleanup-orphan-webhooks.ts` | Deletes orphan webhook subscriptions pointing at dead trycloudflare dev tunnels. |
| `scripts/dev-cleanup-subs.ts` | Dev helper: cancels test subscriptions. |
| `scripts/top-criticals.ts` | Ops query for the hottest critical check failures. |
| `scripts/validate-partner-api.ts` | Smoke test for the Partner API plumbing. |

---

## 10. UI & Styling Rules

* **Polaris Only:** Use native Shopify Polaris web components (`<s-page>`, `<s-card>`, `<s-button>`, `<s-banner>`, `<s-badge>`, etc.). No raw HTML/CSS for layout.
* **Brand Color:** "Security Blue" `#0F172A`.
* **Score colors:** Green `#1a9e5c` (≥80), Orange `#e8820c` (≥50), Red `#e51c00` (<50).
* **Threat level colors:** Minimal `#1a9e5c`, Low `#6aad81`, Elevated `#e8820c`, High `#d82c0d`, Critical `#c00000`.
* **Check status colors:** Passed `#1a9e5c`, Critical `#e51c00`, Warning `#e8820c`, Info `#5c6ac4`, Error `#8c9196`.

---

## 11. Architecture Decisions & Patterns

* **No Prisma/SQLite** — all persistence via Supabase JS client with service_role key.
* **`maybeSingle()` not `single()`** — prevents 406 errors on missing rows.
* **Atomic scan quota** — `decrement_scan_quota` Supabase RPC prevents races. Both scan entry points call it before running the scan; both refund on scan failure (compensating transaction).
* **Persistent rate limiting** — `scan_rate_limits` table survives cold starts. In-memory fallback if table absent.
* **Two scan entry points** — Dashboard form (`app._index.tsx` action) and `api.scan.ts`. Both use atomic quota decrement + refund.
* **safeCheck() wrapper** — every individual compliance check is wrapped so exceptions become severity `"error"` results instead of failing the whole scan.
* **Polaris web component type gaps** — props like `submit`, `loading` work at runtime but aren't in TS type defs. Codebase uses `@ts-ignore` or spread patterns. Expected; do not "fix".
* **Embedded app navigation** — must go through App Bridge or React Router. Raw `<a>` tags trigger full page reloads that break the iframe. Use `NavMenu` for sidebar nav, `useNavigate()` in-app.
* **useWebComponentClick hook** — React's synthetic `onClick` does NOT fire on Polaris web components. All click handlers on `<s-button>` use `useWebComponentClick` which attaches a native DOM listener via ref.
* **s-banner onDismiss** — same web-component gap as onClick. Use a native `<button>` inside the banner for dismiss actions.
* **SSRF protection** — `fetchPublicPage()` in `helpers.server.ts` validates DNS records against private IP ranges before fetching. Both the in-app scanner and outbound scanner use this.
* **Streaming SSR** — `entry.server.tsx` uses `renderToPipeableStream`. Bots get `onAllReady` (full render), humans get `onShellReady` (early streaming). 5s timeout.
* **Server-side HTML sanitization** — AI-generated policy HTML sanitized with `sanitize-html` server-side (in `policy-generator.server.ts`) before storage, then `dompurify` client-side before render. On 2026-05-21 we switched off `isomorphic-dompurify` after a prod outage caused by its `jsdom` transitive ESM tree being incompatible with Vercel's Rust runtime. **Never reintroduce `jsdom` or any `isomorphic-*` package that wraps it** — use `sanitize-html` or a pure regex sanitizer instead.
* **Reproducible builds on Vercel** — `vercel.json` sets `installCommand: "npm ci"` so Vercel respects `package-lock.json` exactly. Without this, `npm install` re-resolves caret ranges on every build (which is how the 2026-05-21 outage happened). **Never edit `package.json` without committing the regenerated lockfile.**
* **Theme block name 25-char limit** — Shopify validation rejects theme block `name` strings longer than 25 chars. Count before deploy.
* **Brand fallback chain (JSON-LD)** — `product.metafields.custom.brand` → `product.vendor` → `shop.name`. Implemented in both `extensions/json-ld-schema/blocks/product-schema.liquid` and (server-side) `app/lib/enrichment/gtin-enrichment.server.ts`. Keep both call sites in sync.
* **Paid nav links tier-gated** — `app/routes/app.tsx` loader reads `merchants.tier` and conditionally renders NavMenu entries via `hasMonitoringAccess` / `hasRecoveryAccess`. Route-level guards in those files remain the source of truth on enforcement.
* **Shopify Managed Pricing** — plans defined in Partner Dashboard listing UI; codebase does not register a `billing` config and does not call `billing.request()` / `billing.cancel()`. Plan-name strings must match Partner Dashboard config exactly so reconciliation maps them through `PLAN_NAME_TO_TIER` / `PLAN_NAME_TO_CYCLE`.
* **Iframe-escape redirect pattern** — `app.upgrade.tsx` and `app.plan-switcher.tsx` are loader + component routes that `window.open(url, "_top")` from `useEffect`. A server-side `redirect()` cannot navigate the parent frame because Shopify admin sends `X-Frame-Options: DENY` on the managed-pricing page.
* **JSON-LD intent vs state** — `merchants.json_ld_enabled` reflects **verified state only**. Click writes `json_ld_enable_clicked_at`; the verifier (cron + on-demand action) is the only writer of `json_ld_verified_at` and `json_ld_enabled`. Three-state UI everywhere it's displayed.
* **Billing self-heal off the critical render path** — moved to a post-mount action in Fix 6 to stop blocking dashboard paint on Partner API latency.
* **Webhook reliability** — `app/uninstalled` records `webhook_failures` rows on Supabase write errors; the daily `reconcile-installs` cron is the durable backstop for any failure mode (including webhooks Shopify never delivered).
* **Weekly-scan idempotency** — `pending_scan_triggers.week_iso` + partial unique index `(merchant_id, trigger_type, week_iso)` makes Vercel retries / manual replays a no-op within the same ISO week. Event-driven inserts leave `week_iso` NULL so the partial constraint doesn't touch them.
* **GTIN enrichment off the webhook hot path** — `webhooks.products.update.tsx` enqueues `trigger_type='enrichment'` with payload `{ product_gid, numeric_product_id }`. The drainer handles the work with the full 60s function ceiling instead of trying to fit it into the ~5s webhook ACK window.

---

## 12. Known Issues / Limitations

* **JSON-LD verifier is positive-only (v1)** — if a merchant verifies, then later removes the block from their theme, `json_ld_enabled` stays true until manual intervention. Tear-down detection is deliberately deferred. Re-verification only fires while `clicked_at IS NOT NULL AND verified_at IS NULL` so verified rows aren't re-probed.
* **`leads` table shape drift vs `supabase/schema.sql`** — live DB has `id BIGINT NOT NULL` and `email TEXT NULL`; `schema.sql` documents `id UUID` and `email TEXT NOT NULL`. The runtime code never writes a NULL email and never reads `leads.id` for app logic, so this is cosmetic — but the schema file would build the wrong shape on a fresh bootstrap.
* **`merchants`/`scans`/`violations` index drift vs `schema.sql`** — three indexes claimed by `schema.sql` (`idx_merchants_active`, `idx_scans_created_at`, `idx_violations_severity`) do not exist on the live DB. Runtime performance has been fine without them. Same cosmetic risk on bootstrap.
* **In-memory llms.txt cache is effectively dead code on Vercel serverless** — the per-process `Map` in `api.proxy.llms-txt.ts` is lost on cold start; the downstream `Cache-Control: public, max-age=86400` header is what actually caches. Leaving the in-memory layer as a no-op safety net.
* **`stripHtml` collapses newlines into single spaces** — for pathologically structured policy bodies this can change placeholder-detection regex outcomes. Low risk, noted for awareness.
* **npm audit dev-dep vulnerabilities** — ~25 known issues in ESLint / GraphQL codegen / Sentry transitive deps. No production runtime impact. No non-breaking fixes available.

---

## 13. Environment Variables & External Dependencies

### Required
| Variable | Used By | Purpose |
|----------|---------|---------|
| `SHOPIFY_API_KEY` | `shopify.server.ts`, `app.tsx`, `json-ld-deep-link.ts` | Shopify app client ID. Also embedded into theme-editor deep links. |
| `SHOPIFY_API_SECRET` | `shopify.server.ts` | Webhook HMAC verification, OAuth |
| `SHOPIFY_APP_URL` | `shopify.server.ts`, `vite.config.ts`, `weekly-digest` | App base URL |
| `SCOPES` | `shopify.server.ts`, multiple gates | OAuth scopes (production value mirrors the toml: 8 scopes including `write_products`) |
| `SUPABASE_URL` | `supabase.server.ts` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase.server.ts` | Admin-level DB access (bypasses RLS) |
| `TOKEN_ENCRYPTION_KEY` | `crypto.server.ts` | AES-256-GCM key material (≥32 chars) |
| `SHOPIFY_APP_HANDLE` | `plans.ts` (`getManagedPricingUrl`) | App slug from Partner Dashboard listing URL. Used to build the managed-pricing redirect. Throws loudly if unset. |
| `CRON_SECRET` | All `api.cron.*.ts` handlers | Bearer token for all Vercel + GitHub Actions cron invocations |

### Optional
| Variable | Used By | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `policy-generator.server.ts`, `appeal-letter.server.ts` | Required for AI policy + appeal generation (Recovery feature) |
| `GOOGLE_PAGESPEED_API_KEY` | `page-speed.server.ts` | Higher quota on PageSpeed API |
| `RESEND_API_KEY` | `emails/send.server.ts`, weekly-digest cron | Required for the weekly digest send. Cron is a no-op when missing. |
| `SENTRY_DSN` | `sentry.server.ts` | Server-side Sentry. Unset → all `addBreadcrumb` / `captureException` calls are no-ops; SDK still initialises. |
| `SHOP_CUSTOM_DOMAIN` | `shopify.server.ts` | Custom Shopify domain support |
| `PORT` | `vite.config.ts` | Server port (default 3000) |
| `NODE_ENV` | Various | Supabase singleton caching, etc. |

### Feature flags
* **`WRITE_METAFIELDS_SCOPE_ENABLED`** — derived at module load from `process.env.SCOPES.includes("write_products")`. Currently **true** in production because the toml grants `write_products`. Consumers: `app/routes/app.tsx` (NavMenu visibility for `/app/gtin-fill`), `app/routes/app.gtin-fill.tsx` (route gate), `app/routes/webhooks.products.update.tsx` (enrichment gate `skip_scope`).

### External Services
| Service | Purpose | Endpoint |
|---------|---------|----------|
| Supabase | PostgreSQL database (project `bhnpcirhutczdorkhibm`) | `https://bhnpcirhutczdorkhibm.supabase.co` |
| Shopify Admin API | GraphQL data | Per-store `https://{shop}/admin/api/2025-10/graphql.json` |
| Shopify Partner API | Subscription reconciliation (canonical post-Apr-28) | `partners.shopify.com/api/<version>/graphql.json` |
| Google PageSpeed Insights | Mobile performance scoring | `googleapis.com/pagespeedonline/v5/runPagespeed` |
| Anthropic API | AI policy + appeal generation | `@anthropic-ai/sdk` (`claude-sonnet-4-20250514`) |
| Resend | Weekly digest email | `resend` SDK |
| Sentry | Server-side observability | When `SENTRY_DSN` set |

---

## 14. Testing

* **Framework:** Vitest ^4.1.2. Config in `vitest.config.ts`.
* **Run:** `npm test` → `vitest run`.
* **Files (9):** `bug-fixes.test.ts` (regression suite, expanded heavily during the May 27 sweep), `partner-api.test.ts`, `phase-7-ai-visibility.test.ts`, `phase-7-dashboard.test.ts`, `phase-7-enrichment.test.ts`, `phase-7-monitoring.test.ts`, `phase-7-quick-wins.test.ts`, `reconcile-subscriptions.test.ts`, `v3-pricing.test.ts`.
* **Count on 2026-05-28:** 233 / 233 passing.
* **Style:** Most tests are file-content assertions (regex / string matching) to avoid needing env vars for module initialisation. Trade-off: assertions can become brittle when implementation details rotate; rebalance toward behaviour tests if maintenance burden grows.

---

## 15. Deployment & Build

### Vercel (current)
* App URL: `https://shieldkit.vercel.app`
* **Tier: Hobby.** Function duration capped at 60s; daily is the minimum cron cadence.
* **`vercel.json`** defines **7 Vercel Cron jobs**:
  - `/api/cron/weekly-scan` — Mon 08:00 UTC (enqueues weekly triggers)
  - `/api/cron/weekly-digest` — Mon 13:00 UTC (Resend digest)
  - `/api/cron/monthly-reset` — 1st 00:00 UTC (free-tier quota refill)
  - `/api/cron/reconcile-subscriptions` — daily 04:00 UTC (Partner-API demote)
  - `/api/cron/reconcile-installs` — daily 03:00 UTC (Admin-API probe; Fix 4)
  - `/api/cron/verify-json-ld` — every 2h (storefront probe; Fix 3)
  - `/api/cron/process-scan-triggers` — daily 12:00 UTC (failsafe drainer — restored 2026-05-28; primary driver is GitHub Actions every 30 min)
* `vercel.json` also defines edge-level 308 `redirects` for known scanner paths (`/wp-admin/*`, `/.env`, `/xmlrpc.php`, etc.) so bot probes don't cold-start serverless functions, plus long-cache headers on static brand assets.
* **App Proxy:** `[app_proxy]` block in `shopify.app.toml` registers `/apps/llms-txt` → `/api/proxy/llms-txt`; HMAC verified by `authenticate.public.appProxy(request)`.
* **`react-router.config.ts`** uses the `@vercel/react-router` preset.
* **Build:** `react-router build` (Vite). **Serve:** `react-router-serve ./build/server/index.js`.

### Weekly scan execution model (Hobby-compatible)

The 12-point compliance scan takes ~10–15s per merchant — too slow to run everyone in a single Vercel function call on Hobby. So the work is split:

1. **`api.cron.weekly-scan.ts`** (Vercel Cron Mon 08:00 UTC) — fans out: upserts one row per monitoring-access merchant into `pending_scan_triggers` with `trigger_type='weekly_scan'` and `week_iso=<this ISO week>`. The partial unique index `(merchant_id, trigger_type, week_iso) WHERE week_iso IS NOT NULL` makes re-firing within the same week a no-op. Completes in 1–3s.
2. **`api.cron.process-scan-triggers.ts`** — drains the queue **one merchant per invocation** (`BATCH_SIZE=1`). Splits scan-class vs enrichment trigger types; for enrichment, runs `enrichProductMetafields` with the payload's product gid. Each invocation runs ~12s.
3. **`.github/workflows/process-scan-triggers.yml`** — GitHub Actions cron every 30 min curls the endpoint with bearer `CRON_SECRET`. 48 invocations/day clears the weekly enqueue burst within a day or two. `workflow_dispatch:` enabled for manual replay.
4. **Vercel Cron failsafe** — also hits `/api/cron/process-scan-triggers` daily 12:00 UTC with the same `Authorization: Bearer $CRON_SECRET` header. If GitHub Actions is unavailable for an extended period, the daily Vercel hit keeps the queue moving (manual `workflow_dispatch:` or `curl` remains the immediate fallback).

**Capacity planning:** at 30-min GH-Actions cadence × 1 merchant per tick = 48 merchants/day. When the paid base outgrows that, drop the cadence toward `*/5` (288/day ceiling). Beyond ~288 merchants in a single weekly burst, upgrade to Vercel Pro (300s function ceiling → batch ~20 merchants per invocation).

**Setup required when first wiring up the workflow:**
- GitHub repo → Settings → Secrets → Actions → New repository secret
- Name: `CRON_SECRET`
- Value: same string as the `CRON_SECRET` env var set on Vercel (so the Vercel cron failsafe and GH Actions both authenticate identically)

### Docker (alternative)
```dockerfile
FROM node:20-alpine
EXPOSE 3000
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN npm run build
CMD ["npm", "run", "docker-start"]
```

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
Numbered migrations in `supabase/migrations/` are the source of truth. After deploying code that depends on a new column/table, apply the migration to the live DB before traffic hits the new code path. Live migration history on 2026-05-28 (most recent first):
- `20260528044014_enrichment_triggers`
- `20260528044004_pending_scan_triggers_idempotency`
- `20260528043953_webhook_failures`
- `20260528043940_json_ld_verification`
- `20260514150228_widen_tier_for_v3_pricing`
- `20260511141953_add_merchant_shop_metadata`
- `20260506024035_phase_7_quick_wins_and_monitoring`

Local migration files in `supabase/migrations/` are timestamped `20260527192823..20260527194459` (the source filenames); Supabase reassigned versions on push (`20260528...`).

---

## 16. Next Priorities

_(Intentionally left for the founder to populate post-sweep.)_
