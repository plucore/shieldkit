# ShieldKit — Complete Project Reference

## 1. Project Overview

ShieldKit is a B2B SaaS Shopify Embedded App that scans Shopify stores for Google Merchant Center (GMC) compliance issues.

* **Module A (Current MVP):** A 10-point automated compliance scanner. Identifies suspension risks and provides plain-English fix instructions.
* **Module B (Future/Hidden):** Automated DMCA Takedown Legal Engine. All DMCA features are deferred. `app/routes/app.dmca-takedowns.tsx` redirects to `/app`.

**Business model:** Free + Pro ($39/mo). Free tier gets 1 full scan + JSON-LD theme extension. Pro tier gets unlimited re-scans, AI-powered policy generation (Anthropic Claude), and full scan history.

---

## 2. Architecture & Tech Stack

### Framework & Runtime
* **React Router v7** (file-based routing via `@react-router/fs-routes`). Routes defined by convention in `app/routes/`.
* **React 18.3**, **Vite** build toolchain.
* **Node.js** >= 20.19 < 22 or >= 22.12 (enforced in `package.json` engines).
* **TypeScript** 5.9.3, strict mode.

### Hosting & Deployment
* **Vercel** at `shieldkit.vercel.app`. No `vercel.json` — uses default Vercel settings.
* **Dockerfile** provided (Node 20-alpine, port 3000) for alternative deployment.
* `npm run build` → `react-router build`. `npm start` → `react-router-serve ./build/server/index.js`.

### Key Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `@shopify/app-bridge-react` | ^4.2.4 | Embedded app shell, toast, navigation |
| `@shopify/shopify-app-react-router` | ^1.1.0 | Auth, billing, webhooks, session management |
| `@supabase/supabase-js` | ^2.47.0 | PostgreSQL client (service role) |
| `cheerio` | ^1.2.0 | Server-side HTML parsing for compliance checks |
| `resend` | ^6.9.2 | Transactional email (welcome email) |
| `@anthropic-ai/sdk` | latest | AI policy generation (Pro feature) |
| `isbot` | ^5.1.31 | Bot detection for streaming SSR |

### Folder Structure
```
app/
  routes/              # All Remix/RR7 routes (18 files)
  components/          # Extracted UI components from app._index.tsx
    ScoreBanner.tsx, KpiCards.tsx, ScanProgressIndicator.tsx,
    UpgradeCard.tsx, PolicyGeneratorDisplay.tsx,
    AuditChecklist.tsx, SecurityStatusAside.tsx
  hooks/               # Custom React hooks
    useWebComponentClick.ts    (native DOM events for web components)
    useScanToast.ts            (deduplicated scan-complete toast)
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
    rate-limiter.server.ts         (in-memory rate limiting for /api/scan)
    scan-comparison.server.ts      (score diff logic for weekly alerts)
    types.ts                       (shared UI types: Merchant, Scan, etc.)
    constants.ts                   (shared UI color constants)
    scan-helpers.ts                (pure helper functions for dashboard)
  utils/
    email.server.ts                (Resend public API)
    email-templates/
      welcome.ts                   (HTML template for welcome email)
      compliance-alert.ts          (HTML template for alert email)
  shopify.server.ts   # Shopify app config, billing plans, afterAuth hook
  supabase.server.ts  # Supabase client singleton
  root.tsx, entry.server.tsx, routes.ts, globals.d.ts, styles.css
scripts/
  outbound-scanner.ts  # Standalone CLI scanner (no OAuth)
supabase/
  schema.sql           # Database DDL
public/
  favicon.ico, logo-main.png
extensions/
  json-ld-schema/      # Theme extension: Product JSON-LD structured data block
tests/
  bug-fixes.test.ts    # Regression tests (unicode, scan decrement, nav, billing)
```

---

## 3. Shopify Integration

### App Configuration (`shopify.app.toml`)
* **client_id:** `071fc51ee1ef7f358cdaed5f95922498`
* **App type:** Embedded (`embedded = true`)
* **application_url:** `https://shieldkit.vercel.app`
* **Webhooks API version:** `2026-04`
* **Access scopes:** `read_products,read_content,read_legal_policies` (read-only — app never writes to merchant stores)
* **Auth redirect URLs:**
  - `https://shieldkit.vercel.app/auth/callback`
  - `https://shieldkit.vercel.app/auth/shopify/callback`
  - `https://shieldkit.vercel.app/api/auth/callback`
* **Distribution:** AppStore

### App Bridge & Auth (`app/shopify.server.ts`)
* **API Version:** `ApiVersion.October25` (October 2025)
* **Scopes at runtime:** `process.env.SCOPES ?? "read_products,read_content"` — the toml declares `read_legal_policies` too, but the code fallback omits it. In practice the CLI injects the full set from toml at dev time.
* **Session storage:** Custom `SupabaseSessionStorage` class (not Prisma/SQLite).
* **Token rotation:** `expiringOfflineAccessTokens: true` — refresh tokens stored in sessions table.
* **afterAuth hook:** Fires on every OAuth completion (install + re-auth). For offline sessions only, upserts a `merchants` row: sets `shopify_domain`, encrypts `access_token`, sets `installed_at`, clears `uninstalled_at`.
* **authenticate.admin(request):** Validates App Bridge 4.x JWT on every `/app/*` route. Called in `app.tsx` loader (gates all nested routes) and again in individual loaders/actions that need the session object.

### Webhook Subscriptions
Declared in `shopify.app.toml` and handled by route files:

| Topic | Route File | Behavior |
|-------|-----------|----------|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Deletes all sessions for shop, soft-deletes merchant (`uninstalled_at = NOW()`). |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Updates session scope string in Supabase. |
| `app_subscriptions/update` | `webhooks.app_subscriptions.update.tsx` | Maps plan name to tier, writes to merchants. On CANCELLED/EXPIRED/DECLINED/FROZEN: downgrades to `tier='free', scans_remaining=0`. |
| `customers/data_request` | `webhooks.customers.data_request.tsx` | GDPR. Logs and returns 200 (app stores no customer PII). |
| `customers/redact` | `webhooks.customers.redact.tsx` | GDPR. Logs and returns 200 (no customer PII to delete). |
| `shop/redact` | `webhooks.shop.redact.tsx` | GDPR. Hard-deletes merchant row (CASCADE to scans, violations). Fires 48h after uninstall. |

All webhooks use `authenticate.webhook(request)` which verifies `X-Shopify-Hmac-Sha256`. Invalid HMAC → automatic 401.

### Billing (`app/shopify.server.ts`, `app.upgrade.tsx`, `app.billing.confirm.tsx`)

**Single paid plan:**
| Constant | Plan Name | Price | Interval |
|----------|-----------|-------|----------|
| `PLAN_PRO` | `"Pro"` | $39.00 USD | Every 30 days |

**Billing flow:**
1. Merchant clicks upgrade link → GET `/app/upgrade?plan=Pro`
2. `app.upgrade.tsx` loader first calls `billing.check()` — if already subscribed, redirects to `/app` (skips billing)
3. If no active subscription, calls `billing.request()` for the Pro plan with `isTest: NODE_ENV !== 'production'`
4. Shopify redirects merchant to hosted approval page
5. Return URL: `https://admin.shopify.com/store/{subdomain}/apps/{apiKey}/billing/confirm`
6. `app.billing.confirm.tsx` loader calls `billing.check()`, maps `"Pro"` → `"pro"` tier
7. Updates merchants table: `tier = 'pro', scans_remaining = null` (null = unlimited)
8. Redirects to `/app` (dashboard)
9. On decline: redirects to `/app?billing=cancelled` → dashboard shows dismissible warning banner
10. On billing error: redirects to `/app?billing=error`

**Webhook reconciliation:** `APP_SUBSCRIPTIONS_UPDATE` webhook handles subscription lifecycle changes as a backstop. ACTIVE → upgrades tier. CANCELLED/EXPIRED/DECLINED/FROZEN → `tier='free', scans_remaining=1`.

**Pro tier features:**
- Unlimited re-scans (`scans_remaining = null`)
- AI policy generation (Anthropic Claude) — generates store policies from failed checks
- Scan history page (`/app/scan-history`) — table of past scan results
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
* **RLS:** Enabled, no anon/authenticated policies (server-only via service_role)

### Table: `merchants`
One row per installed shop. Soft-deleted on uninstall, hard-deleted by GDPR shop/redact 48h later.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK (gen_random_uuid) | |
| `shopify_domain` | TEXT NOT NULL UNIQUE | e.g. `mystore.myshopify.com` |
| `shop_name` | TEXT | |
| `access_token_encrypted` | TEXT | AES-256-GCM encrypted token |
| `tier` | TEXT DEFAULT 'free' CHECK ('free', 'pro') | Free or Pro tier |
| `billing_status` | TEXT | |
| `scans_remaining` | INTEGER DEFAULT 1 | null = unlimited (paid), 0 = exhausted, n > 0 = available |
| `installed_at` | TIMESTAMPTZ DEFAULT now() | |
| `uninstalled_at` | TIMESTAMPTZ | Soft-delete marker |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

* **Indexes:** `idx_merchants_domain` on (`shopify_domain`), `idx_merchants_active` on (`uninstalled_at`) WHERE `uninstalled_at IS NULL`
* **RLS Policy:** `merchants_shop_isolation` — row accessible only when `shopify_domain = current_setting('app.current_shop')`
* **CASCADE:** Deleting a merchant cascades to scans, then to violations.

### Table: `scans`
One row per compliance scan run.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants(id) ON DELETE CASCADE | |
| `scan_type` | TEXT DEFAULT 'manual' CHECK IN ('manual','automated') | |
| `compliance_score` | NUMERIC(5,2) | 0-100 |
| `total_checks`, `passed_checks` | INTEGER | |
| `critical_count`, `warning_count`, `info_count` | INTEGER | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

* **Indexes:** `idx_scans_merchant_id`, `idx_scans_created_at` (DESC)
* **RLS Policy:** `scans_merchant_isolation` via merchant_id join

### Table: `violations`
Individual check results per scan.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `scan_id` | UUID FK → scans(id) ON DELETE CASCADE | |
| `check_name` | TEXT NOT NULL | e.g. `contact_information` |
| `passed` | BOOLEAN DEFAULT false | |
| `severity` | TEXT CHECK IN ('critical','warning','info','error') | Severity level |
| `title`, `description`, `fix_instruction` | TEXT | Human-readable results |
| `raw_data` | JSONB | Machine-readable check details |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

* **Indexes:** `idx_violations_scan_id`, `idx_violations_severity`, `idx_violations_raw_data` (GIN)
* **RLS Policy:** `violations_merchant_isolation` via scan → merchant cascade

### Table: `leads`
Deduplication for welcome emails. Defined in `supabase/schema.sql`.

| Column | Type | Notes |
|--------|------|-------|
| `shop_domain` | TEXT | Unique constraint (for upsert `onConflict`) |
| `email` | TEXT | Store owner email |

---

## 5. Scan Engine

### How scans are triggered

**Path A — Dashboard form submit** (`app._index.tsx` action):
1. Merchant clicks "Run My Free Compliance Scan" → form POST with `action=runScan`
2. Action authenticates, looks up merchant, calls `runComplianceScan(merchant.id, shopDomain, "manual")`
3. Returns `{ success: true, scanId }`. Fetcher state change triggers toast + loader revalidation.

**Path B — API endpoint** (`api.scan.ts` action):
1. POST `/api/scan` with App Bridge JWT
2. Authenticates, looks up merchant, enforces quota (`scans_remaining`)
3. Calls `runComplianceScan(merchant.id, shopDomain, "manual")`
4. Decrements `scans_remaining` (non-atomic — separate SELECT then UPDATE)
5. Returns full scan + violations + summary as JSON

### Scan execution flow (`app/lib/compliance-scanner.server.ts`)

`runComplianceScan(merchantId, shopifyDomain, scanType)`:

1. **Build admin GraphQL client** via `createAdminClient(shopifyDomain)` — looks up encrypted token in Supabase, decrypts, creates fetch-based executor.
2. **Fetch Shopify data** (concurrent): `getShopInfo()`, `getShopPolicies()`, `getProducts(first=50)`, `getPages(first=20)`.
3. **Pre-fetch public storefront pages** (concurrent):
   - Homepage: `https://{primaryDomain.host}` (falls back to `https://{myshopifyDomain}`)
   - Up to 3 product pages: from `product.onlineStoreUrl`
4. **Run all 10 checks** concurrently via `Promise.all`, each wrapped in `safeCheck()` (catches exceptions, returns severity "error" so scan continues).
5. **Calculate score:** `(passedChecks / scorableTotal) * 100`. Errored checks excluded from denominator.
6. **Persist results:** INSERT into `scans` table, then bulk INSERT all violations with `raw_data` JSONB.
7. **Return:** `{ scan, violations }`.

### The 10 Compliance Checks

#### Check 1: `contact_information` (severity: critical)
**What:** Verifies the store publicly displays at least 2 of 3 contact methods: phone number, store-domain email, physical street address.
**How:** Scans HTML of contact/about pages (`/pages/contact-us`, `/pages/contact`, `/pages/about-us`, `/pages/about`) fetched via Shopify Pages GraphQL. Also checks `shopInfo.billingAddress` as fallback for physical address. Uses regex patterns:
- Phone: international format `\+?\d[\d\s\-().]{6,}\d`
- Email: `[a-zA-Z0-9._%+-]+@{storeDomainHost}`
- Address: street patterns (`\d+\s+[\w\s]+\b(Street|St|Ave|Rd|Drive|Blvd|...)\b`)
- Flags PO Boxes (`\bP\.?O\.?\s*Box\b`)

**Pass:** >= 2 methods publicly visible. **Fail:** critical if < 2.
**raw_data:** `phone_found, email_found, address_found, po_box_detected, methods_found, billing_address, contact_pages_checked`

#### Check 2: `refund_return_policy` (severity: critical)
**What:** Validates the store has a refund/return policy with substantive content.
**How:** Reads `REFUND_POLICY` from `getShopPolicies()`. Checks body length and searches for 3 content signals:
- Return window: regex for day counts (`\d+\s*days?`, "within X days")
- Item condition: keywords ("unused", "original packaging", "tags attached", etc.)
- Refund method: keywords ("full refund", "store credit", "exchange", "original payment")
- Flags placeholder text: ("insert your", "your policy here", "[company name]", "lorem ipsum")

**Pass:** Policy present + 3 content signals, no placeholders. **Fail:** critical if missing, warning if thin.
**raw_data:** `policy_present, body_length, has_return_window, has_item_condition, has_refund_method, has_placeholder_text, policy_url`

#### Check 3: `shipping_policy` (severity: critical)
**What:** Validates the store has a shipping policy with delivery timeline and cost info.
**How:** Reads `SHIPPING_POLICY` from `getShopPolicies()`. Searches for:
- Timeline: regex for delivery estimates ("3-7 business days", "next day", "overnight", "within N days")
- Cost: keywords ("free shipping", "flat rate", "$" amounts, "calculated at checkout", "shipping costs")

**Pass:** Both timeline AND cost info present. **Fail:** critical if missing, warning if incomplete.
**raw_data:** `policy_present, body_length, has_delivery_timeline, has_shipping_cost_info, policy_url`

#### Check 4: `privacy_and_terms` (severity: critical)
**What:** Checks that both privacy policy and terms of service exist.
**How:** Reads `PRIVACY_POLICY` and `TERMS_OF_SERVICE` from `getShopPolicies()`.

**Pass:** Both present. **Fail:** critical if privacy missing, warning if only ToS missing.
**raw_data:** `privacy_policy_present, terms_of_service_present, urls`

#### Check 5: `product_data_quality` (severity: warning)
**What:** Evaluates product listings for description length, images, pricing, and SKUs.
**How:** Iterates all fetched products (up to 50). Flags products with:
- Description < 100 characters
- Zero images
- Zero or negative price
- Missing SKU

**Pass:** No products flagged OR < 20% flagged. **Fail:** warning.
**raw_data:** `total_products, flagged_count, flagged_percentage, flagged_products` (capped at 15)

#### Check 6: `checkout_transparency` (severity: warning)
**What:** Detects payment method icons on the storefront homepage.
**How:** Fetches public homepage HTML via `fetchPublicPage()`. Uses Cheerio to search for 26 payment keywords (visa, mastercard, paypal, amex, discover, apple-pay, google-pay, shop-pay, klarna, afterpay, etc.) in: `<img>` src/alt, SVG `<use>` href, CSS class names, `aria-label`, `data-payment-icon`, `data-method` attributes.

**Pass:** >= 1 payment icon found. **Fail:** warning.
**raw_data:** `store_url, payment_icons_found, icons_count`

#### Check 7: `storefront_accessibility` (severity: critical)
**What:** Detects password protection and verifies product pages are reachable.
**How:** Analyzes pre-fetched homepage HTML for password signals:
- HTTP 401 status
- `body` class contains `template-password`
- Page title contains "enter using password" or "password required"
- `form[action='/password']` present
- `#shopify-challenge-page` element

Then checks HTTP status of up to 3 sampled product pages.

**Pass:** Not password-protected AND all sampled products return HTTP 200. **Fail:** critical if password-protected, warning if product pages fail.
**raw_data:** `store_url, homepage_status, password_protected, password_signals, product_checks, failed_product_pages`

#### Check 8: `structured_data_json_ld` (severity: warning)
**What:** Validates Product JSON-LD structured data on product pages.
**How:** Parses pre-fetched product page HTML. Extracts all `<script type="application/ld+json">` blocks, searches for `@type: "Product"` nodes (handles `@graph` arrays). Validates:
- Required: `name`, `image`, `description`, `offers`
- Offer required: `price`, `priceCurrency`, `availability`
- Recommended (non-failing): `sku`, `itemCondition`

**Pass:** All scanned pages have valid Product schema with no missing required fields. **Fail:** warning.
**raw_data:** `pages_scanned, pages_with_product_schema, page_reports` (per-page: url, schema_found, missing_required, missing_recommended)

#### Check 9: `page_speed` (severity: warning)
**What:** Mobile performance score via Google PageSpeed Insights API.
**How:** Calls `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={storeUrl}&strategy=mobile`. Extracts `lighthouseResult.categories.performance.score` (0-1, multiplied by 100). Also checks `intrusive-interstitials` audit.

**Pass:** Performance score >= 50 AND no intrusive interstitials. **Fail:** warning. Skipped (severity "info") if no API key and rate-limited.
**raw_data:** `store_url, performance_score, intrusive_interstitials_failed, authenticated, api_status`

#### Check 10: `business_identity_consistency` (severity: info)
**What:** Checks if shop name, primary domain, and about page content are consistent.
**How:** Compares shop name vs primary domain host vs about/contact page text using Jaccard word-set similarity. Excludes stop words ("the", "shop", "store", etc.). Weighted score: 60% domain match + 40% about-page match. Threshold: 0.3.

**Pass:** Consistency score >= 0.3 OR shop name has no meaningful tokens after stop-word removal. **Fail:** info.
**raw_data:** `shop_name, primary_domain, consistency_score, name_vs_domain_score, name_vs_about_score, threshold`

---

## 6. Results Delivery & Email Flow

### Dashboard display
After a scan completes, the `app._index.tsx` loader revalidates and renders:
- **Score banner:** Large percentage display (color-coded green/orange/red at 80/50 thresholds)
- **4 KPI cards:** Checks Passed, Critical Threats, Warnings, Skipped
- **10-point checklist:** Sorted (failed first, by severity). Each check expandable with description + "Resolution Guide" box showing `fix_instruction`.
- **Aside:** Security Status card with threat level (Minimal/Low/Elevated/High/Critical), About ShieldKit card.

### Welcome email (`app/utils/email.server.ts`)
Triggered on **first scan only**. Fire-and-forget (not awaited). Deduplicated via `leads` table.

**Flow** (in `app._index.tsx` action):
1. Check `leads` table for existing `shop_domain` row. If exists → skip.
2. Fetch `shop { email name }` via GraphQL.
3. Upsert `leads` row (prevents double-send on retry).
4. Call `sendWelcomeEmail(shopEmail, shopName)`.
5. Entire flow wrapped in try/catch with silent failure.

**Email details:**
- **From:** `ShieldKit <am@plucore.com>`
- **Subject:** `"Your ShieldKit Scan Results Are Ready"`
- **Template:** HTML email with ShieldKit branding (#0f172a header).
- **CTA:** "View Your Results" → `https://shieldkit.vercel.app/app`
- **Upgrade copy:** "Upgrade to Pro ($39/mo) for unlimited re-scans, AI policy generation, and full scan history."
- **Footer:** "2026 ShieldKit by Plucore. Abu Dhabi, United Arab Emirates."
- **Unsubscribe:** "Reply 'Unsubscribe' and we'll remove you."

Note: `shopName` is interpolated into HTML without escaping. Low risk since email is sent to the merchant themselves, but technically allows HTML injection via crafted shop names.

---

## 7. Route Map

### Authenticated app routes (all gated by `authenticate.admin` in `app.tsx`)

| Route File | URL Path | Type | Behavior |
|-----------|----------|------|----------|
| `app.tsx` | `/app` (layout) | Layout | Wraps all `/app/*` routes. Provides `AppProvider` with API key, renders sidebar nav via `NavMenu` from `@shopify/app-bridge-react` (Dashboard + Scan History), `<Outlet />` for children. |
| `app._index.tsx` | `/app` | Loader + Action + Component | **Onboarding:** Logo + 3-step wizard + "Run Free Scan" CTA. **Dashboard:** Score banner, 4 KPI cards, 10-point checklist, aside with threat level + JSON-LD extension info. **Actions:** `runScan` (with quota enforcement + decrement), `generatePolicy` (Pro-only AI policy generation). Fires welcome email on first scan. Billing banner on `?billing=cancelled`. Upgrade CTAs use `useNavigate()` for embedded-app-safe navigation. |
| `app.upgrade.tsx` | `/app/upgrade?plan=Pro` | Loader only | Pre-checks for existing active subscription via `billing.check()`. If already subscribed, redirects to `/app`. Otherwise calls `billing.request()` for Pro plan (redirects to Shopify approval page). Errors redirect to `/app?billing=error`. Has ErrorBoundary. |
| `app.billing.confirm.tsx` | `/app/billing/confirm` | Loader only | Calls `billing.check()`. If active: maps plan → tier, writes `tier` + `scans_remaining=null` to Supabase, redirects to `/app`. If declined: redirects to `/app?billing=cancelled`. |
| `app.dmca-takedowns.tsx` | `/app/dmca-takedowns` | Loader only | Redirects to `/app`. DMCA module deferred. |
| `app.scan-history.tsx` | `/app/scan-history` | Loader + Component | Pro-gated scan history. Free tier redirected to `/app?upgrade=scan-history`. |

### API routes

| Route File | URL Path | Method | Behavior |
|-----------|----------|--------|----------|
| `api.scan.ts` | `/api/scan` | POST | Authenticated scan endpoint. Enforces `scans_remaining` quota (402 if exhausted). Runs full 10-check scan. Decrements quota after success. Returns `{ success, scans_remaining, scan, violations, summary }`. GET returns 405. |

### Public routes

| Route File | URL Path | Behavior |
|-----------|----------|----------|
| `_index/route.tsx` | `/` | Landing page. If `?shop` param present, redirects to `/app?{params}`. Otherwise renders ShieldKit marketing page with login form (submits to `/auth/login`). Styled via `_index/styles.module.css`. |
| `auth.login/route.tsx` | `/auth/login` | Shop domain form. Uses `login()` from shopify.server. Error messages via `auth.login/error.server.tsx` (MissingShop, InvalidShop). |
| `auth.$.tsx` | `/auth/*` | Catch-all OAuth callback. Calls `authenticate.admin(request)` to complete OAuth flow. |

### Webhook routes (all use `authenticate.webhook` for HMAC verification)
See Section 3 (Shopify Integration → Webhook Subscriptions) for full details.

---

## 8. Server Utilities

### Encryption (`app/lib/crypto.server.ts`)
* **Algorithm:** AES-256-GCM (authenticated encryption)
* **Key derivation:** `scryptSync(TOKEN_ENCRYPTION_KEY, "shieldkit-token-v1", 32)`. Salt is intentionally static/public — exists for key versioning, not as a secret. Derived key cached after first call.
* **IV:** 12 bytes (96-bit, NIST recommendation), random per encryption
* **Auth tag:** 128-bit
* **Ciphertext format:** `<hex_iv>:<hex_authTag>:<hex_ciphertext>` (single string, safe for TEXT column)
* **Key requirement:** `TOKEN_ENCRYPTION_KEY` env var must be >= 32 characters
* **Functions:** `encrypt(plaintext) → string`, `decrypt(ciphertext) → string` (throws on tamper/format error)

### Session Storage (`app/lib/session-storage.server.ts`)
Custom class implementing Shopify's `SessionStorage` interface:

| Method | Behavior |
|--------|----------|
| `storeSession(session)` | UPSERT by id. Encrypts `accessToken` and `refreshToken` before storage. |
| `loadSession(id)` | SELECT by id, `maybeSingle()`. Decrypts tokens. On decrypt failure: logs error, returns session without token (triggers re-auth). |
| `deleteSession(id)` | DELETE by id. Idempotent (returns true even if missing). |
| `deleteSessions(ids)` | DELETE by id array. |
| `findSessionsByShop(shop)` | SELECT by shop, ordered by `expires DESC`, limit 25. |

### Shopify GraphQL API (`app/lib/shopify-api.server.ts` + split modules)

**GraphQL queries:**

| Query | Variables | Fields Fetched |
|-------|-----------|----------------|
| `SHOP_INFO_QUERY` | none | `name, contactEmail, billingAddress {address1,city,province,country,zip}, myshopifyDomain, currencyCode, primaryDomain {url,host}` |
| `SHOP_POLICIES_QUERY` | none | `shopPolicies { type, title, url, body }` — returns all 4 types (REFUND, PRIVACY, TERMS, SHIPPING) |
| `PRODUCTS_QUERY` | `$first: Int` (default 50) | `title, description, descriptionHtml, handle, onlineStoreUrl, images(first:5) {url,altText}, variants(first:10) {price,compareAtPrice,inventoryQuantity,sku,barcode}` |
| `PAGES_QUERY` | `$first: Int` (default 20) | `title, body, handle` (no url — `onlineStoreUrl` removed from Page type in API 2025-10) |

**Cursor-based pagination** — `getProducts()` paginates up to 250 products (50 per page), `getPages()` up to 100 pages (50 per page). Both use `pageInfo { hasNextPage endCursor }` for cursor iteration.

**Retry logic** (`executeWithRetry`): Max 3 retries, 500ms base delay (exponential backoff). Detects THROTTLED errors and retries. Logs query cost on every response.

**Executor factories:**
- `wrapAdminClient(adminGraphql)` — wraps the library's `admin.graphql` for route handlers
- `createAdminClient(shopDomain)` — standalone: looks up merchant in Supabase, decrypts token, creates raw fetch executor (used by compliance scanner)

### Supabase Client (`app/supabase.server.ts`)
* Singleton pattern: dev caches on `global` to survive hot reload. Production creates fresh on import.
* Uses `service_role` key (admin access, bypasses RLS).
* Supabase auth features disabled (`autoRefreshToken: false, persistSession: false, detectSessionInUrl: false`).
* Global type uses `any` to avoid TS generic mismatch.

---

## 9. Outbound Scanner (`scripts/outbound-scanner.ts`)

Standalone CLI tool that runs a subset of compliance checks against any public Shopify storefront without OAuth or app installation.

**Usage:**
```bash
npx tsx scripts/outbound-scanner.ts https://example.myshopify.com
GOOGLE_PAGESPEED_API_KEY=... npx tsx scripts/outbound-scanner.ts <url>
```

**Checks run (9 of 10):** `contact_information`, `shipping_policy`, `privacy_and_terms`, `checkout_transparency`, `storefront_accessibility`, `structured_data_json_ld`, `page_speed`, and partial variants of others. Same regex patterns and Cheerio logic as in-app scanner.

**Key difference from in-app scanner:** No Shopify Admin API access. Cannot check `billingAddress` fallback for contact info, cannot read policy bodies via API (scrapes public URLs instead), cannot check product data quality (no product listing access).

**SSRF Protection** (not present in in-app scanner):
```typescript
// Private IP patterns blocked:
127.0.0.0/8     // loopback
10.0.0.0/8      // RFC 1918
172.16.0.0/12   // RFC 1918
192.168.0.0/16  // RFC 1918
169.254.0.0/16  // link-local / AWS metadata
0.0.0.0         // unspecified
::1             // IPv6 loopback
fc00::/7        // IPv6 ULA
fd00::/8        // IPv6 ULA
```
Before fetching any URL, resolves all A/AAAA DNS records and rejects any that match private ranges. Also enforces HTTPS-only.

---

## 10. UI & Styling Rules

* **Polaris Only:** Use native Shopify Polaris web components (`<s-page>`, `<s-card>`, `<s-button>`, `<s-banner>`, `<s-badge>`, `<s-section>`, `<s-paragraph>`, etc.). Do not use raw HTML/CSS for layout.
* **Brand Color:** "Security Blue" `#0F172A`. Injected in `app._index.tsx` onboarding section by overriding `--p-color-bg-fill-brand` on primary buttons.
* **Score colors:** Green `#1a9e5c` (>= 80), Orange `#e8820c` (>= 50), Red `#e51c00` (< 50).
* **Threat level colors:** Minimal `#1a9e5c`, Low `#6aad81`, Elevated `#e8820c`, High `#d82c0d`, Critical `#c00000`.
* **Check status colors:** Passed `#1a9e5c`, Critical `#e51c00`, Warning `#e8820c`, Info `#5c6ac4`, Error `#8c9196`.
* **KPI card backgrounds:** Success `#f1f8f5`, Warning `#fff5ea`, Critical `#fff4f4`, Neutral `#f4f6f8`.

---

## 11. Architecture Decisions & Patterns

* **No Prisma/SQLite** — All persistence via Supabase JS client with service_role key.
* **`maybeSingle()` not `single()`** — Prevents 406 errors on missing rows.
* **Billing return flow** — `billing.request()` returns to `/app/billing/confirm` (not `/app`) so tier is written to Supabase synchronously before dashboard loads. Webhook is backup.
* **Welcome email fire-and-forget** — Sent on first scan, deduplicated via `leads` table, not awaited, silent on failure.
* **Two scan entry points** — Dashboard form submit (`app._index.tsx` action) for the UI, and `api.scan.ts` for programmatic access. Both enforce `scans_remaining` quota and decrement after successful scan.
* **safeCheck() wrapper** — Every individual compliance check is wrapped so exceptions become severity "error" results instead of failing the entire scan.
* **Polaris web component type gaps** — Props like `submit`, `loading` (as string) work at runtime but aren't in TS type defs. Codebase uses `@ts-ignore` or `{...(condition ? { prop: "" } : {})}` spread patterns. This is expected; do not try to fix these.
* **Embedded app navigation** — In Shopify embedded apps, navigation MUST go through App Bridge or React Router. Raw `<a>` tags and `<s-button url="...">` trigger full page reloads that break out of the embedded iframe context. Use `NavMenu` from `@shopify/app-bridge-react` for sidebar nav, and `useNavigate()` from React Router for in-app link buttons.
* **useWebComponentClick hook** — React's synthetic `onClick` does NOT fire on Shopify Polaris web components (`<s-button>`, etc.) because they are custom elements with shadow DOM. All click handlers on `<s-button>` MUST use the `useWebComponentClick` hook (`app/hooks/useWebComponentClick.ts`) which attaches native DOM `addEventListener("click", handler)` via a ref. Never use `onClick` directly on web components.
* **billing_plan vs tier** — The live Supabase DB has both `billing_plan` (stale, unused) and `tier` columns. All application code uses `tier`. The `billing_plan` column should be dropped from the live DB via `ALTER TABLE merchants DROP COLUMN IF EXISTS billing_plan;`.
* **Streaming SSR** — `entry.server.tsx` uses `renderToPipeableStream`. Bots get `onAllReady` (full render), humans get `onShellReady` (early streaming). 5s timeout.

---

## 12. Known Issues

### Medium
* **In-memory rate limiting on `/api/scan`** — 10 requests per hour per shop, but state resets on deploy. Only gated by `scans_remaining`, rate limiter, and Shopify auth.
* **Race condition on scan quota** — `scans_remaining` is read then decremented in separate queries. Concurrent requests can both pass the check.
* **Scopes fallback mismatch** — `shopify.server.ts` falls back to `"read_products,read_content"` when `SCOPES` env var is missing, but `shopify.app.toml` declares `read_products,read_content,read_legal_policies`. In practice the CLI injects the full set.
* **No SSRF protection in in-app scanner** — `fetchPublicPage()` in `compliance-scanner.server.ts` follows arbitrary URLs without DNS/IP validation. The outbound scanner has this protection but it was not ported.
* **Stale `billing_plan` column in live DB** — The live Supabase `merchants` table has both `billing_plan` (stale) and `tier` columns. All code uses `tier`. Run `ALTER TABLE merchants DROP COLUMN IF EXISTS billing_plan;` to clean up. Zero application code references `billing_plan`.

### Low
* **`feature/pro-tier` local branch** — Exists locally but not pushed to remote. Unknown state.

### Fixed (feature/new-pricing)
* **Unicode escape characters rendered as literal text** — `\uXXXX` sequences in JSX text content displayed as raw text. Fixed: replaced all escape sequences with actual Unicode characters in `app._index.tsx`.
* **Pro tier scan decrement bug** — `scans_remaining` was decremented even when `null` (unlimited/Pro). Fixed: decrement guard changed to `typeof scansRemaining === "number" && scansRemaining > 0` in both `app._index.tsx` and `api.scan.ts`.
* **Scan History navigation broke out of iframe** — Changed from `<s-app-nav>` + `<a>` tags to `NavMenu` from `@shopify/app-bridge-react` with `<a>` children and `rel="home"` on the Dashboard link. `NavMenu` wraps App Bridge's `<ui-nav-menu>` and handles embedded navigation correctly.
* **Upgrade button did nothing when clicked** — Went through 3 iterations: (1) `<s-button url="...">` triggered full page reloads, (2) `<s-button onClick={...}>` didn't fire because React synthetic events don't work on web components, (3) Final fix: all buttons use `useWebComponentClick` hook with native DOM `addEventListener` via refs. The upgrade route (`app.upgrade.tsx`) also has `billing.check()` pre-check, try/catch error handling, and `ErrorBoundary`.
* **Scan History loader had no error handling** — Added try/catch with `console.error` logging and graceful fallback. Response objects (redirects) are re-thrown.
* **JSON-LD extension not visible** — Merchants had no way to discover the free JSON-LD theme extension. Added an "Free JSON-LD Structured Data" card in the dashboard aside (visible to all tiers) with enable instructions.

---

## 13. Environment Variables & External Dependencies

### Required
| Variable | Used By | Purpose |
|----------|---------|---------|
| `SHOPIFY_API_KEY` | `shopify.server.ts`, `app.tsx` | Shopify app client ID |
| `SHOPIFY_API_SECRET` | `shopify.server.ts` | Webhook HMAC verification, OAuth |
| `SHOPIFY_APP_URL` | `shopify.server.ts`, `vite.config.ts` | App base URL |
| `SCOPES` | `shopify.server.ts` | OAuth scopes (falls back to `read_products,read_content`) |
| `SUPABASE_URL` | `supabase.server.ts` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase.server.ts` | Admin-level DB access (bypasses RLS) |
| `TOKEN_ENCRYPTION_KEY` | `crypto.server.ts` | AES-256-GCM key material (>= 32 chars) |
| `RESEND_API_KEY` | `email.server.ts` | Resend email service |

### Optional
| Variable | Used By | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `policy-generator.server.ts` | Required for AI policy generation (Pro feature) |
| `GOOGLE_PAGESPEED_API_KEY` | `compliance-scanner.server.ts`, `outbound-scanner.ts` | Higher PageSpeed API quota. Without it, check 9 may be rate-limited. |
| `CRON_SECRET` | `api.cron.weekly-scan.ts` | Bearer token for authenticating Vercel Cron weekly scan endpoint |
| `SHOP_CUSTOM_DOMAIN` | `shopify.server.ts` | Custom Shopify domain support |
| `PORT` | `vite.config.ts` | Server port (default 3000) |
| `NODE_ENV` | Various | Controls billing `isTest` flag, Supabase singleton caching |

### External Services
| Service | Purpose | Endpoint |
|---------|---------|----------|
| Supabase | PostgreSQL database | `https://bhnpcirhutczdorkhibm.supabase.co` |
| Shopify Admin API | GraphQL data (shop info, policies, products, pages) | Per-store `https://{shop}/admin/api/2025-10/graphql.json` |
| Shopify Billing API | Subscription management | Via `billing.request()` / `billing.check()` |
| Google PageSpeed Insights | Mobile performance scoring | `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` |
| Resend | Transactional email | Via `resend` npm package |
| Anthropic API | AI policy generation (Pro feature) | Via `@anthropic-ai/sdk` npm package |

---

## 14. Testing

* **Framework:** Vitest (dev dependency). Config in `vitest.config.ts`.
* **Run:** `npm test` (alias for `vitest run`).
* **Test file:** `tests/bug-fixes.test.ts` — 46 regression tests covering unicode rendering, web component click handling, scan decrement logic, navigation setup, billing flow, component extraction, shared types/helpers, and hooks.
* **Note:** Tests that import route modules directly will fail without env vars (`SUPABASE_URL`, etc.) since module initialization triggers `supabase.server.ts`. Tests use file-content assertions (regex/string matching) to avoid this.

---

## 15. Deployment & Build

### Vercel (current)
* App URL: `https://shieldkit.vercel.app`
* No `vercel.json` — default Vercel config.
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
* `npm run dev` → `shopify app dev` (starts dev server with tunnel)
* `npm run deploy` → `shopify app deploy`

---

## 16. Next Priorities (in order)

1. **Apply live DB migration** — Run ALTER statements on Supabase to rename `billing_plan` → `tier`, update CHECK constraints, add `leads` table if not present.
2. **Port SSRF protection** — Copy DNS resolution + private IP blocking from `outbound-scanner.ts` into `compliance-scanner.server.ts`'s `fetchPublicPage()`.
3. **Build `app.pricing.tsx`** — Standalone pricing page showing Free vs Pro ($39/mo) feature comparison.
4. **Add rate limiting to `/api/scan`** — Prevent abuse beyond `scans_remaining` quota gating.
5. **Deploy JSON-LD theme extension** — Run `shopify app deploy` to register the `json-ld-schema` theme extension.
