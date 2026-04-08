# ShieldKit — Complete Project Reference

## 1. Project Overview

ShieldKit is a B2B SaaS Shopify Embedded App that scans Shopify stores for Google Merchant Center (GMC) compliance issues.

* **Module A (Current MVP):** A 10-point automated compliance scanner. Identifies suspension risks and provides plain-English fix instructions.
* **Module B (Future/Hidden):** Automated DMCA Takedown Legal Engine. All DMCA features are deferred. `app/routes/app.dmca-takedowns.tsx` redirects to `/app`.

**Business model:** Free + Pro ($29 one-time). Free tier gets 1 full scan + JSON-LD theme extension. Pro tier gets unlimited re-scans, AI-powered policy generation (Anthropic Claude), and automated weekly compliance monitoring.

---

## 2. Architecture & Tech Stack

### Framework & Runtime
* **React Router v7** (file-based routing via `@react-router/fs-routes`). Routes defined by convention in `app/routes/`.
* **React 18.3**, **Vite 6.3** build toolchain.
* **Node.js** >= 20.19 < 22 or >= 22.12 (enforced in `package.json` engines).
* **TypeScript** ^5.9.3, strict mode.

### Hosting & Deployment
* **Vercel** at `shieldkit.vercel.app`.
* **`vercel.json`** defines a Vercel Cron job: `POST /api/cron/weekly-scan` every Monday at 08:00 UTC.
* **`react-router.config.ts`** uses `@vercel/react-router` preset for serverless deployment.
* **Dockerfile** provided (Node 20-alpine, port 3000) for alternative deployment.
* `npm run build` -> `react-router build`. `npm start` -> `react-router-serve ./build/server/index.js`.

### Key Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `@shopify/app-bridge-react` | ^4.2.4 | Embedded app shell, toast, navigation |
| `@shopify/shopify-app-react-router` | ^1.1.0 | Auth, billing, webhooks, session management |
| `@supabase/supabase-js` | ^2.47.0 | PostgreSQL client (service role) |
| `cheerio` | ^1.2.0 | Server-side HTML parsing for compliance checks |
| `@anthropic-ai/sdk` | latest | AI policy generation (Pro feature, model: `claude-sonnet-4-20250514`) |
| `isbot` | ^5.1.31 | Bot detection for streaming SSR |
| `isomorphic-dompurify` | latest | HTML sanitization for AI-generated policy content |
| `vite-tsconfig-paths` | ^5.1.4 | TypeScript path aliases |

### Key Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.9.3 | Type checking |
| `vitest` | ^4.1.2 | Test runner |
| `vite` | ^6.3.6 | Build toolchain |
| `@vercel/react-router` | ^1.2.6 | Vercel serverless adapter |
| `eslint` | ^8.57.1 | Linting |
| `prettier` | ^3.6.2 | Formatting |

### Folder Structure
```
app/
  routes/              # All RR7 routes (17 files)
  components/          # Extracted UI components from app._index.tsx
    ScoreBanner.tsx, KpiCards.tsx, ScanProgressIndicator.tsx,
    UpgradeCard.tsx, PolicyGenerationCard.tsx,
    AuditChecklist.tsx, SecurityStatusAside.tsx
  hooks/               # Custom React hooks
    useWebComponentClick.ts    (native DOM events for web components)
  lib/                 # Server-only business logic
    checks/            # Individual compliance check modules
      types.ts, constants.ts, helpers.server.ts, safe-check.server.ts
      contact-information.server.ts, refund-return-policy.server.ts,
      shipping-policy.server.ts, privacy-and-terms.server.ts,
      product-data-quality.server.ts, checkout-transparency.server.ts,
      storefront-accessibility.server.ts, structured-data-json-ld.server.ts,
      page-speed.server.ts, business-identity-consistency.server.ts,
      index.server.ts        (orchestrator + re-exports)
    compliance-scanner.server.ts   (barrel re-export from checks/)
    graphql-queries.server.ts      (GraphQL query strings + response types)
    graphql-client.server.ts       (client infra, retry, executors)
    shopify-api.server.ts          (public API: getShopInfo, etc. + re-exports)
    policy-generator.server.ts     (Anthropic-powered policy generation)
    session-storage.server.ts      (custom Supabase session adapter)
    crypto.server.ts               (AES-256-GCM encrypt/decrypt)
    rate-limiter.server.ts         (persistent rate limiting via Supabase, in-memory fallback)
    types.ts                       (shared UI types: Merchant, Scan, etc.)
    constants.ts                   (shared UI color constants)
    scan-helpers.ts                (pure helper functions for dashboard)
  shopify.server.ts   # Shopify app config, billing plans, afterAuth hook
  supabase.server.ts  # Supabase client singleton
  root.tsx, entry.server.tsx, routes.ts, globals.d.ts, styles.css
scripts/
  outbound-scanner.ts       # Standalone CLI scanner (no OAuth)
  cleanup-orphan-webhooks.ts # One-off: deletes orphan webhook subscriptions from old dev tunnels
supabase/
  schema.sql           # Database DDL
public/
  favicon.ico, logo-main.png
extensions/
  json-ld-schema/      # Theme extension: Product JSON-LD structured data block
tests/
  bug-fixes.test.ts    # Regression tests (60 tests)
```

---

## 3. Shopify Integration

### App Configuration (`shopify.app.toml`)
* **client_id:** `071fc51ee1ef7f358cdaed5f95922498`
* **App type:** Embedded (`embedded = true`)
* **application_url:** `https://shieldkit.vercel.app`
* **Build setting:** `automatically_update_urls_on_dev = false` (prevents `shopify app dev` from overwriting production webhook URLs with dev tunnel URLs)
* **Webhooks API version:** `2026-04`
* **Access scopes:** `read_products,read_content,read_legal_policies` (read-only -- app never writes to merchant stores)
* **Auth redirect URLs:**
  - `https://shieldkit.vercel.app/auth/callback`
  - `https://shieldkit.vercel.app/auth/shopify/callback`
  - `https://shieldkit.vercel.app/api/auth/callback`
* **Distribution:** AppStore

### App Bridge & Auth (`app/shopify.server.ts`)
* **API Version:** `ApiVersion.October25` (October 2025)
* **Scopes at runtime:** `process.env.SCOPES ?? "read_products,read_content,read_legal_policies"` -- matches `shopify.app.toml`.
* **Session storage:** Custom `SupabaseSessionStorage` class (not Prisma/SQLite).
* **Token rotation:** `expiringOfflineAccessTokens: true` -- refresh tokens stored in sessions table.
* **afterAuth hook:** Fires on every OAuth completion (install + re-auth). For offline sessions only, upserts a `merchants` row: sets `shopify_domain`, encrypts `access_token`, sets `installed_at`, clears `uninstalled_at`.
* **authenticate.admin(request):** Validates App Bridge 4.x JWT on every `/app/*` route.
* **Exports:** `authenticate`, `login`, `registerWebhooks`, `sessionStorage`, `addDocumentResponseHeaders`, `unauthenticated`, `apiVersion`, `PLAN_PRO`, `PlanName`.

### Webhook Subscriptions
Declared in `shopify.app.toml` and handled by route files:

| Topic | Route File | Behavior |
|-------|-----------|----------|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Deletes all sessions for shop, soft-deletes merchant (`uninstalled_at = NOW()`). |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Updates session scope string in Supabase. |
| `app_subscriptions/update` | `webhooks.app_subscriptions.update.tsx` | Maps plan name to tier, writes to merchants. One-time charge -- no cancellation/downgrade flow. |
| `customers/data_request` | `webhooks.customers.data_request.tsx` | GDPR. Logs and returns 200 (app stores no customer PII). |
| `customers/redact` | `webhooks.customers.redact.tsx` | GDPR. Logs and returns 200 (no customer PII to delete). |
| `shop/redact` | `webhooks.shop.redact.tsx` | GDPR. Hard-deletes merchant row (CASCADE to scans, violations). Fires 48h after uninstall. |

All webhooks use `authenticate.webhook(request)` which verifies `X-Shopify-Hmac-Sha256`. Invalid HMAC -> automatic 401.

### Billing (`app/shopify.server.ts`, `app.upgrade.tsx`, `app.billing.confirm.tsx`)

**Single paid plan:**
| Constant | Plan Name | Price | Interval |
|----------|-----------|-------|----------|
| `PLAN_PRO` | `"Pro"` | $29.00 USD | One-time |

**Billing flow:**
1. Merchant clicks upgrade link -> GET `/app/upgrade?plan=Pro`
2. `app.upgrade.tsx` loader calls `billing.check()` -- if already subscribed, redirects to `/app`
3. If no active subscription, calls `billing.request()` for the Pro plan with `isTest: NODE_ENV !== 'production'`
4. Shopify redirects merchant to hosted approval page
5. Return URL: `/app/billing/confirm` (relative path -- Shopify library converts to full embedded admin URL)
6. `app.billing.confirm.tsx` loader calls `billing.check()`, maps `"Pro"` -> `"pro"` tier
7. Updates merchants table: `tier = 'pro', scans_remaining = null` (null = unlimited)
8. Redirects to `/app` (dashboard)
9. On decline: redirects to `/app?billing=cancelled` -> dashboard shows dismissible warning banner
10. On billing error: redirects to `/app?billing=error`

**Billing self-heal:** Dashboard loader checks `billing.check()` against Shopify and syncs tier to Supabase when stale. Webhook is backup.

**Pro tier features:**
- Unlimited re-scans (`scans_remaining = null`)
- AI policy generation (Anthropic Claude) -- generates store policies from failed checks
- Automated weekly compliance scans via Vercel Cron
- Free tier gets 1 scan, then sees upgrade CTA

---

## 4. Database Schema (Supabase)

Project ID: `bhnpcirhutczdorkhibm`. All tables have RLS enabled. App uses `service_role` key which bypasses RLS.

### Table: `sessions`
Shopify OAuth session storage. Replaces default Prisma adapter.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Session ID from Shopify |
| `shop` | TEXT NOT NULL | e.g. `mystore.myshopify.com` |
| `state` | TEXT NOT NULL | OAuth state param |
| `is_online` | BOOLEAN DEFAULT false | Online (user) vs offline (merchant) session |
| `scope` | TEXT | Comma-separated granted scopes |
| `expires` | TIMESTAMPTZ | Session expiry |
| `access_token` | TEXT DEFAULT '' | **Encrypted** (AES-256-GCM) |
| `user_id` | BIGINT | Online session user fields... |
| `first_name`, `last_name`, `email` | TEXT | |
| `account_owner` | BOOLEAN DEFAULT false | |
| `locale` | TEXT | |
| `collaborator` | BOOLEAN | |
| `email_verified` | BOOLEAN | |
| `refresh_token` | TEXT | **Encrypted**. For token rotation. |
| `refresh_token_expires` | TIMESTAMPTZ | |

* **Index:** `idx_sessions_shop` on (`shop`)

### Table: `merchants`
One row per installed shop. Soft-deleted on uninstall, hard-deleted by GDPR shop/redact 48h later.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK (gen_random_uuid) | |
| `shopify_domain` | TEXT NOT NULL UNIQUE | e.g. `mystore.myshopify.com` |
| `access_token_encrypted` | TEXT | AES-256-GCM encrypted token |
| `tier` | TEXT DEFAULT 'free' CHECK ('free', 'pro') | Free or Pro tier |
| `scans_remaining` | INTEGER DEFAULT 1 | null = unlimited (paid), 0 = exhausted, n > 0 = available |
| `json_ld_enabled` | BOOLEAN DEFAULT false | Whether merchant has enabled JSON-LD theme extension |
| `generated_policies` | JSONB DEFAULT '{}' | Keyed by policy type: `{ refund?: string, shipping?: string, privacy?: string, terms?: string }` |
| `policy_regen_used` | JSONB DEFAULT '{}' | Tracks regeneration: `{ refund?: boolean, ... }` -- one regen per type |
| `review_prompted` | BOOLEAN DEFAULT false | Set true when merchant dismisses review banner; never shown again. |
| `installed_at` | TIMESTAMPTZ DEFAULT now() | |
| `uninstalled_at` | TIMESTAMPTZ | Soft-delete marker |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

* **Indexes:** `idx_merchants_domain`, `idx_merchants_active` (WHERE `uninstalled_at IS NULL`)
* **RLS Policy:** `merchants_shop_isolation` -- row accessible only when `shopify_domain = current_setting('app.current_shop')`
* **CASCADE:** Deleting a merchant cascades to scans, then to violations.

### Table: `leads`
Lead collection for future retargeting. One row per shop.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `shop_domain` | TEXT NOT NULL UNIQUE | |
| `email` | TEXT NOT NULL | Shop owner email (from GraphQL `shop { email }`) |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

### Table: `scans`
One row per compliance scan run.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK -> merchants(id) ON DELETE CASCADE | |
| `scan_type` | TEXT DEFAULT 'manual' CHECK IN ('manual','automated') | |
| `compliance_score` | NUMERIC(5,2) | 0-100 |
| `total_checks`, `passed_checks` | INTEGER | |
| `critical_count`, `warning_count`, `info_count` | INTEGER | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

* **Indexes:** `idx_scans_merchant_id`, `idx_scans_created_at` (DESC)

### Table: `violations`
Individual check results per scan.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `scan_id` | UUID FK -> scans(id) ON DELETE CASCADE | |
| `check_name` | TEXT NOT NULL | e.g. `contact_information` |
| `passed` | BOOLEAN DEFAULT false | |
| `severity` | TEXT CHECK IN ('critical','warning','info','error') | |
| `title`, `description`, `fix_instruction` | TEXT | Human-readable results |
| `raw_data` | JSONB | Machine-readable check details |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

* **Indexes:** `idx_violations_scan_id`, `idx_violations_severity`, `idx_violations_raw_data` (GIN)

### Table: `scan_rate_limits`
Persistent rate limiting for scan API requests.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `shop` | TEXT NOT NULL | Shop domain |
| `requested_at` | TIMESTAMPTZ DEFAULT now() | |

* **Index:** `idx_rate_limits_shop_time` on (`shop`, `requested_at`)

### Function: `decrement_scan_quota`
Atomically decrements `scans_remaining` for a merchant. Returns the new value, or no rows if quota was already exhausted. Used by both scan entry points to prevent race conditions.

```sql
decrement_scan_quota(p_merchant_id UUID) RETURNS TABLE(new_scans_remaining INTEGER)
```

---

## 5. Scan Engine

### How scans are triggered

**Path A -- Dashboard form submit** (`app._index.tsx` action):
1. Merchant clicks "Run My Free Compliance Scan" -> form POST with `action=runScan`
2. Action authenticates, looks up merchant, atomically decrements quota via `decrement_scan_quota` RPC
3. Calls `runComplianceScan(merchant.id, shopDomain, "manual")`
4. Returns `{ success: true, scanId }`. Fetcher state change triggers toast + loader revalidation.

**Path B -- API endpoint** (`api.scan.ts` action):
1. POST `/api/scan` with App Bridge JWT
2. Authenticates, rate-limits (persistent), looks up merchant
3. Atomically decrements quota via `decrement_scan_quota` RPC (402 if exhausted)
4. Calls `runComplianceScan(merchant.id, shopDomain, "manual")`
5. Returns full scan + violations + summary as JSON

**Path C -- Weekly cron** (`api.cron.weekly-scan.ts`):
1. POST `/api/cron/weekly-scan` with `CRON_SECRET` bearer token (triggered by Vercel Cron)
2. Fetches all active Pro merchants
3. Runs scans sequentially with 2s delay between merchants
4. Persists results as `scan_type = 'automated'`

### Scan execution flow (`app/lib/checks/index.server.ts`)

`runComplianceScan(merchantId, shopifyDomain, scanType)`:

1. **Build admin GraphQL client** via `createAdminClient(shopifyDomain)` -- reads the offline session token from `sessions` table first (always fresh), falls back to `merchants.access_token_encrypted`. Decrypts and creates fetch-based executor.
2. **Fetch Shopify data** (concurrent): `getShopInfo()`, `getShopPolicies()`, `getProducts(first=50)`, `getPages(first=20)`.
3. **Pre-fetch public storefront pages** (concurrent): Homepage + up to 3 product pages. All fetches go through `fetchPublicPage()` which includes SSRF protection (DNS resolution + private IP blocking).
4. **Run all 10 checks** in two concurrent batches via `Promise.all`, each wrapped in `safeCheck()` (catches exceptions, returns severity "error" so scan continues).
5. **Calculate score:** `(passedChecks / scorableTotal) * 100`. Errored checks excluded from denominator.
6. **Persist results:** INSERT into `scans` table, then bulk INSERT all violations with `raw_data` JSONB.
7. **Return:** `{ scan, violations }`.

### The 10 Compliance Checks

#### Check 1: `contact_information` (severity: critical)
**What:** Verifies the store publicly displays at least 2 of 3 contact methods: phone number, store-domain email, physical street address.
**How:** Scans HTML of contact/about pages fetched via Shopify Pages GraphQL. Also checks `shopInfo.billingAddress` as fallback for physical address. Uses regex patterns for phone, email, address. Flags PO Boxes.
**Pass:** >= 2 methods publicly visible.

#### Check 2: `refund_return_policy` (severity: critical)
**What:** Validates the store has a refund/return policy with substantive content.
**How:** Reads `REFUND_POLICY` from `getShopPolicies()`. Checks for 3 content signals: return window, item condition, refund method. Flags placeholder text.
**Pass:** Policy present + 3 content signals, no placeholders.

#### Check 3: `shipping_policy` (severity: critical)
**What:** Validates the store has a shipping policy with delivery timeline and cost info.
**How:** Reads `SHIPPING_POLICY` from `getShopPolicies()`. Searches for timeline and cost keywords.
**Pass:** Both timeline AND cost info present.

#### Check 4: `privacy_and_terms` (severity: critical)
**What:** Checks that both privacy policy and terms of service exist.
**How:** Reads `PRIVACY_POLICY` and `TERMS_OF_SERVICE` from `getShopPolicies()`.
**Pass:** Both present. Warning if only ToS missing.

#### Check 5: `product_data_quality` (severity: warning)
**What:** Evaluates product listings for description length, images, pricing, and SKUs.
**How:** Iterates fetched products (up to 50). Flags products with short descriptions, zero images, bad pricing, or missing SKUs.
**Pass:** < 20% flagged.

#### Check 6: `checkout_transparency` (severity: warning)
**What:** Detects payment method icons on the storefront homepage.
**How:** Uses Cheerio to search pre-fetched homepage HTML for 26 payment keywords in img, SVG, CSS classes, aria-labels, and data attributes.
**Pass:** >= 1 payment icon found.

#### Check 7: `storefront_accessibility` (severity: critical)
**What:** Detects password protection and verifies product pages are reachable.
**How:** Analyzes pre-fetched homepage HTML for password signals. Checks HTTP status of up to 3 sampled product pages.
**Pass:** Not password-protected AND all sampled products return HTTP 200.

#### Check 8: `structured_data_json_ld` (severity: warning)
**What:** Validates Product JSON-LD structured data on product pages.
**How:** Parses pre-fetched product page HTML. Extracts `<script type="application/ld+json">` blocks, validates required fields (name, image, description, offers with price/currency/availability).
**Pass:** All scanned pages have valid Product schema.

#### Check 9: `page_speed` (severity: warning)
**What:** Mobile performance score via Google PageSpeed Insights API.
**How:** Calls PageSpeed API with `strategy=mobile`. Extracts performance score. Checks for intrusive interstitials.
**Pass:** Performance score >= 50 AND no intrusive interstitials.

#### Check 10: `business_identity_consistency` (severity: info)
**What:** Checks if shop name, primary domain, and about page content are consistent.
**How:** Jaccard word-set similarity with stop-word removal. Weighted: 60% domain + 40% about-page. Threshold: 0.3.
**Pass:** Consistency score >= 0.3.

---

## 6. Results Delivery

### Dashboard display
After a scan completes, the `app._index.tsx` loader revalidates and renders:
- **Score banner:** Large percentage display (color-coded green/orange/red at 80/50 thresholds)
- **4 KPI cards:** Checks Passed, Critical Threats, Warnings, Skipped
- **Review request banner:** Shown after scan. Two buttons: "Leave a Review" (opens Shopify app reviews) and "Dismiss" (POSTs `action=dismissReview`, sets `review_prompted = true`, never shown again).
- **10-point checklist:** Sorted (failed first, by severity). Each check expandable with description + "Resolution Guide" box. Pro merchants see policy generation guidance for checks 2/3/4.
- **Aside:** Security Status card, Upgrade card (free tier), Policy Generation card (Pro), JSON-LD extension card, About ShieldKit card.

### Lead collection
On first scan, the merchant's email is collected via GraphQL (`shop { email }`) and upserted into the `leads` table. No email is sent -- leads are collected for future retargeting only. Fire-and-forget, silent on failure.

---

## 7. Route Map

### Authenticated app routes (all gated by `authenticate.admin` in `app.tsx`)

| Route File | URL Path | Type | Behavior |
|-----------|----------|------|----------|
| `app.tsx` | `/app` (layout) | Layout | Wraps all `/app/*` routes. Provides `AppProvider` with API key, renders sidebar nav via `NavMenu` (Dashboard only), `<Outlet />` for children. |
| `app._index.tsx` | `/app` | Loader + Action + Component | **Onboarding:** Logo + 3-step wizard + "Run Free Scan" CTA. **Dashboard:** Score banner, 4 KPI cards, 10-point checklist, aside with threat level + policy gen + JSON-LD. **Actions:** `runScan`, `generatePolicy`, `dismissReview`, `enableJsonLd`. |
| `app.upgrade.tsx` | `/app/upgrade?plan=Pro` | Loader only | Pre-checks billing, redirects to Shopify approval page. |
| `app.billing.confirm.tsx` | `/app/billing/confirm` | Loader only | Confirms billing, syncs tier to Supabase, redirects to `/app`. |
| `app.dmca-takedowns.tsx` | `/app/dmca-takedowns` | Loader only | Redirects to `/app`. DMCA deferred. |

### API routes

| Route File | URL Path | Method | Behavior |
|-----------|----------|--------|----------|
| `api.scan.ts` | `/api/scan` | POST | Authenticated scan endpoint. Enforces rate limit + quota (atomic). Returns full scan results JSON. GET returns 405. |
| `api.cron.weekly-scan.ts` | `/api/cron/weekly-scan` | POST | Bearer token auth via `CRON_SECRET`. Scans all active Pro merchants sequentially. Triggered by Vercel Cron (Monday 08:00 UTC). GET returns 405. |

### Public routes

| Route File | URL Path | Behavior |
|-----------|----------|----------|
| `_index/route.tsx` | `/` | Landing page with pricing cards (Free vs Pro $29). If `?shop` param present, redirects to `/app`. Login form submits to `/auth/login`. |
| `auth.login/route.tsx` | `/auth/login` | Shop domain form. Uses `login()` from shopify.server. |
| `auth.$.tsx` | `/auth/*` | Catch-all OAuth callback. |

### Webhook routes (all use `authenticate.webhook` for HMAC verification)
See Section 3 for full details.

---

## 8. Server Utilities

### Encryption (`app/lib/crypto.server.ts`)
* **Algorithm:** AES-256-GCM (authenticated encryption)
* **Key derivation:** `scryptSync(TOKEN_ENCRYPTION_KEY, "shieldkit-token-v1", 32)`. Salt is static/public -- exists for key versioning. Derived key cached after first call.
* **IV:** 12 bytes (96-bit), random per encryption
* **Auth tag:** 128-bit
* **Ciphertext format:** `<hex_iv>:<hex_authTag>:<hex_ciphertext>`
* **Key requirement:** `TOKEN_ENCRYPTION_KEY` env var must be >= 32 characters

### Session Storage (`app/lib/session-storage.server.ts`)
Custom class implementing Shopify's `SessionStorage` interface. Encrypts `accessToken` and `refreshToken` before storage. Decrypts on load with graceful fallback on decrypt failure (triggers re-auth).

### Shopify GraphQL API (`app/lib/shopify-api.server.ts` + split modules)
* **API Version:** `2025-10`
* **Queries:** `SHOP_INFO_QUERY`, `SHOP_POLICIES_QUERY`, `PRODUCTS_QUERY` (paginated, up to 250), `PAGES_QUERY` (paginated, up to 100)
* **Retry logic:** Max 3 retries, 500ms base delay (exponential backoff). Detects THROTTLED errors.
* **Executor factories:** `wrapAdminClient()` for route handlers, `createAdminClient()` for background jobs (reads session token first, falls back to merchant token).

### Rate Limiter (`app/lib/rate-limiter.server.ts`)
* **Primary:** Persistent via Supabase `scan_rate_limits` table. 10 requests per hour per shop.
* **Fallback:** In-memory `Map` if DB table not yet deployed.
* **Cleanup:** Deletes records older than 1 hour on each check (fire-and-forget).

### Policy Generator (`app/lib/policy-generator.server.ts`)
* **Model:** `claude-sonnet-4-20250514`
* **Types:** refund, shipping, privacy, terms
* **Per-type instructions** with detailed section requirements
* **Output:** HTML policy text stored in `merchants.generated_policies` JSONB
* **Limits:** 2 generations per policy type (initial + 1 regeneration), tracked in `policy_regen_used`

### Supabase Client (`app/supabase.server.ts`)
* Singleton pattern: dev caches on `global` to survive hot reload.
* Uses `service_role` key (admin access, bypasses RLS).
* Auth features disabled.

---

## 9. Outbound Scanner (`scripts/outbound-scanner.ts`)

Standalone CLI tool that runs a subset of compliance checks against any public Shopify storefront without OAuth.

**Usage:**
```bash
npx tsx scripts/outbound-scanner.ts https://example.myshopify.com
```

**Checks run:** contact_information, shipping_policy, privacy_and_terms, checkout_transparency, storefront_accessibility, structured_data_json_ld, page_speed.

**Key difference from in-app scanner:** No Shopify Admin API access. Cannot check billingAddress fallback, policy bodies via API, or product data quality.

**SSRF Protection:** DNS resolution + private IP blocking (same protection as in-app scanner).

### Cleanup Script (`scripts/cleanup-orphan-webhooks.ts`)

One-off utility to delete orphaned webhook subscriptions from old `shopify app dev` tunnel sessions. Fetches all webhooks via GraphQL, filters those pointing to dead trycloudflare.com URLs, deletes them.

---

## 10. UI & Styling Rules

* **Polaris Only:** Use native Shopify Polaris web components (`<s-page>`, `<s-card>`, `<s-button>`, `<s-banner>`, `<s-badge>`, etc.). Do not use raw HTML/CSS for layout.
* **Brand Color:** "Security Blue" `#0F172A`.
* **Score colors:** Green `#1a9e5c` (>= 80), Orange `#e8820c` (>= 50), Red `#e51c00` (< 50).
* **Threat level colors:** Minimal `#1a9e5c`, Low `#6aad81`, Elevated `#e8820c`, High `#d82c0d`, Critical `#c00000`.
* **Check status colors:** Passed `#1a9e5c`, Critical `#e51c00`, Warning `#e8820c`, Info `#5c6ac4`, Error `#8c9196`.

---

## 11. Architecture Decisions & Patterns

* **No Prisma/SQLite** -- All persistence via Supabase JS client with service_role key.
* **`maybeSingle()` not `single()`** -- Prevents 406 errors on missing rows.
* **Atomic scan quota** -- `decrement_scan_quota` Supabase RPC prevents race conditions on concurrent scan requests. Both scan entry points call this before running the scan.
* **Persistent rate limiting** -- `scan_rate_limits` table survives serverless cold starts. Falls back to in-memory if table not deployed.
* **Two scan entry points** -- Dashboard form submit (`app._index.tsx` action) for the UI, and `api.scan.ts` for programmatic access. Both use atomic quota decrement.
* **safeCheck() wrapper** -- Every individual compliance check is wrapped so exceptions become severity "error" results instead of failing the entire scan.
* **Polaris web component type gaps** -- Props like `submit`, `loading` work at runtime but aren't in TS type defs. Codebase uses `@ts-ignore` or spread patterns. This is expected; do not try to fix these.
* **Embedded app navigation** -- Navigation MUST go through App Bridge or React Router. Raw `<a>` tags trigger full page reloads that break the embedded iframe. Use `NavMenu` for sidebar nav, `useNavigate()` for in-app links.
* **useWebComponentClick hook** -- React's synthetic `onClick` does NOT fire on Polaris web components. All click handlers on `<s-button>` MUST use the `useWebComponentClick` hook which attaches native DOM `addEventListener` via a ref.
* **s-banner onDismiss** -- Same issue as `onClick`: synthetic events don't fire on web components. Use native `<button>` inside banners for dismiss actions.
* **SSRF protection** -- `fetchPublicPage()` in `helpers.server.ts` validates DNS records against private IP ranges before fetching. Both in-app and outbound scanners have this protection.
* **Streaming SSR** -- `entry.server.tsx` uses `renderToPipeableStream`. Bots get `onAllReady` (full render), humans get `onShellReady` (early streaming). 5s timeout.
* **DOMPurify sanitization** -- AI-generated policy HTML is sanitized with `isomorphic-dompurify` before rendering as defense-in-depth.

---

## 12. Known Issues

### Medium
* **Stale `billing_plan` column in live DB** -- The live Supabase `merchants` table may have both `billing_plan` (stale) and `tier` columns. All code uses `tier`. Run `ALTER TABLE merchants DROP COLUMN IF EXISTS billing_plan;` to clean up.

### Low
* **npm audit: 24 vulnerabilities in dev dependencies** -- All in ESLint, GraphQL codegen, and related transitive deps. No production runtime impact. No non-breaking fixes available.

---

## 13. Environment Variables & External Dependencies

### Required
| Variable | Used By | Purpose |
|----------|---------|---------|
| `SHOPIFY_API_KEY` | `shopify.server.ts`, `app.tsx` | Shopify app client ID |
| `SHOPIFY_API_SECRET` | `shopify.server.ts` | Webhook HMAC verification, OAuth |
| `SHOPIFY_APP_URL` | `shopify.server.ts`, `vite.config.ts` | App base URL |
| `SCOPES` | `shopify.server.ts` | OAuth scopes (falls back to `read_products,read_content,read_legal_policies`) |
| `SUPABASE_URL` | `supabase.server.ts` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase.server.ts` | Admin-level DB access (bypasses RLS) |
| `TOKEN_ENCRYPTION_KEY` | `crypto.server.ts` | AES-256-GCM key material (>= 32 chars) |

### Optional
| Variable | Used By | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `policy-generator.server.ts` | Required for AI policy generation (Pro feature) |
| `GOOGLE_PAGESPEED_API_KEY` | `page-speed.server.ts` | Higher PageSpeed API quota. Without it, check 9 may be rate-limited. |
| `CRON_SECRET` | `api.cron.weekly-scan.ts` | Bearer token for Vercel Cron weekly scan endpoint |
| `SHOP_CUSTOM_DOMAIN` | `shopify.server.ts` | Custom Shopify domain support |
| `PORT` | `vite.config.ts` | Server port (default 3000) |
| `NODE_ENV` | Various | Controls billing `isTest` flag, Supabase singleton caching |

### External Services
| Service | Purpose | Endpoint |
|---------|---------|----------|
| Supabase | PostgreSQL database | `https://bhnpcirhutczdorkhibm.supabase.co` |
| Shopify Admin API | GraphQL data | Per-store `https://{shop}/admin/api/2025-10/graphql.json` |
| Shopify Billing API | Subscription management | Via `billing.request()` / `billing.check()` |
| Google PageSpeed Insights | Mobile performance scoring | `googleapis.com/pagespeedonline/v5/runPagespeed` |
| Anthropic API | AI policy generation | Via `@anthropic-ai/sdk` (`claude-sonnet-4-20250514`) |

---

## 14. Testing

* **Framework:** Vitest ^4.1.2. Config in `vitest.config.ts`.
* **Run:** `npm test` (alias for `vitest run`).
* **Test file:** `tests/bug-fixes.test.ts` -- 60 regression tests covering unicode rendering, web component click handling, atomic scan quota decrement, navigation, billing flow, component extraction, shared types/helpers, hooks, policy generation, JSON-LD extension, one-time billing model, email system removal, billing returnUrl format, JSON-LD deep link format, and scan history removal verification.
* **Note:** Tests use file-content assertions (regex/string matching) to avoid needing env vars for module initialization.

---

## 15. Deployment & Build

### Vercel (current)
* App URL: `https://shieldkit.vercel.app`
* **`vercel.json`:** Defines Vercel Cron job -- `POST /api/cron/weekly-scan` at `0 8 * * 1` (Monday 08:00 UTC).
* **`react-router.config.ts`:** Uses `@vercel/react-router` preset for serverless deployment.
* Build: `react-router build` (Vite). Serve: `react-router-serve ./build/server/index.js`.

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
* HMR: WebSocket on localhost:64999 (dev) or wss://{host}:443 (production)
* Assets inline limit: 0 (no inlining)
* Optimized deps: `@shopify/app-bridge-react`

### Shopify CLI
* `npm run dev` -> `shopify app dev` (starts dev server with tunnel)
* `npm run deploy` -> `shopify app deploy`
* `npm run typecheck` -> `react-router typegen && tsc --noEmit`

### Database Migrations
After deploying code changes that add new tables or functions, apply the corresponding SQL from `supabase/schema.sql` to the live database. Current pending migrations:
* `scan_rate_limits` table (for persistent rate limiting)
* `decrement_scan_quota` function (for atomic quota enforcement)

---

## 16. Next Priorities

<!-- Fill in as needed -->
