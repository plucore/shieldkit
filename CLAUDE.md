# ShieldKit — Project Reference

## 1. Overview

ShieldKit is a **Shopify Embedded App** (B2B SaaS) that performs automated 10-point compliance audits for Google Merchant Center (GMC). It scans a merchant's Shopify store — policies, products, storefront, and structured data — and generates a scored compliance report with plain-English fix instructions for every failed check.

- **Module A (live):** GMC Compliance Scanner — the current MVP.
- **Module B (deferred):** DMCA Takedown Legal Engine — all routes are hidden/stubbed; the `app.dmca-takedowns` route simply redirects to `/app/pricing`.

Business model: free lead-generation (unlimited scans, full results), with three paid tiers (Starter $29/mo, Pro $49/mo, Shield $99/mo) gating future features. A welcome email with a GMC Survival Guide PDF is sent after the first scan via Resend.

---

## 2. Tech Stack & Versions

| Layer | Technology | Version / Notes |
|---|---|---|
| **Framework** | React Router v7 (Remix successor) | `react-router` ^7.12.0, file-system routing via `@react-router/fs-routes` |
| **Runtime** | Node.js | >=20.19 <22 \|\| >=22.12 (enforced in `engines`) |
| **Language** | TypeScript | ^5.9.3, strict mode |
| **UI Platform** | Shopify App Bridge 4.x | `@shopify/app-bridge-react` ^4.2.4 |
| **UI Components** | Shopify Polaris Web Components | `<s-page>`, `<s-section>`, `<s-button>`, etc. (`@shopify/polaris-types` ^1.0.1) |
| **Database** | Supabase (PostgreSQL) | `@supabase/supabase-js` ^2.47.0, service-role key only |
| **Session Storage** | Custom `SupabaseSessionStorage` | Replaces Prisma/SQLite — see `app/lib/session-storage.server.ts` |
| **Encryption** | AES-256-GCM (Node `crypto`) | Access tokens encrypted at rest — see `app/lib/crypto.server.ts` |
| **Email** | Resend | `resend` ^6.9.2, sends welcome emails after first scan |
| **HTML Parsing** | Cheerio | `cheerio` ^1.2.0, used for storefront scraping in compliance checks |
| **Bot Detection** | isbot | `isbot` ^5.1.31, used in `entry.server.tsx` for streaming vs. blocking SSR |
| **Build Tool** | Vite 6 | `vite` ^6.3.6 with `vite-tsconfig-paths` |
| **Linter** | ESLint 8 | With TS, React, a11y, and import plugins |
| **Formatter** | Prettier | ^3.6.2 |
| **Shopify API Version** | 2025-10 (October 2025) | Set in `shopify.server.ts` and `shopify-api.server.ts` |
| **Shopify CLI / Config** | `shopify.app.toml` webhook API version: 2026-04 | Webhooks use a newer API version than the Admin API |
| **Deployment** | Docker (node:20-alpine) or Vercel | `application_url` points to `https://shieldkit.vercel.app` |

---

## 3. Project Structure

```
shieldkit/
├── app/
│   ├── entry.server.tsx          # SSR entry — streaming (onShellReady) for users, blocking (onAllReady) for bots
│   ├── root.tsx                  # HTML shell: <html>, <head>, <body>, <Outlet>
│   ├── routes.ts                 # File-system flat routes via @react-router/fs-routes
│   ├── shopify.server.ts         # Shopify app config (billing plans, auth, afterAuth hook, session storage)
│   ├── supabase.server.ts        # Singleton Supabase client (service-role, no built-in auth)
│   ├── globals.d.ts              # CSS module declaration
│   ├── styles.css                # Minimal global styles
│   ├── lib/
│   │   ├── compliance-scanner.server.ts  # 10-check GMC compliance engine
│   │   ├── crypto.server.ts              # AES-256-GCM encrypt/decrypt for access tokens
│   │   ├── session-storage.server.ts     # SupabaseSessionStorage (Shopify session interface)
│   │   └── shopify-api.server.ts         # Shopify Admin GraphQL service layer (queries, retry, types)
│   ├── utils/
│   │   └── email.server.ts       # Resend email service (welcome email with GMC guide)
│   └── routes/
│       ├── _index/               # Public landing page (shop login form + feature list)
│       │   ├── route.tsx
│       │   └── styles.module.css
│       ├── app.tsx               # Authenticated layout shell (AppProvider, s-app-nav, ErrorBoundary)
│       ├── app._index.tsx        # Main dashboard (onboarding wizard + KPI cards + 10-check audit)
│       ├── app.additional.tsx    # Template example page (boilerplate from Shopify scaffold)
│       ├── app.billing.confirm.tsx  # Post-billing redirect — writes tier to Supabase then redirects
│       ├── app.dmca-takedowns.tsx   # Stub — redirects to /app/pricing (feature deferred)
│       ├── app.test.tsx          # Temporary scanner verification page (dev only)
│       ├── app.upgrade.tsx       # Triggers Shopify billing.request() for plan selection
│       ├── api.scan.ts           # POST /api/scan — authenticated scan endpoint with quota enforcement
│       ├── auth.$.tsx            # Catch-all auth route — handles OAuth callbacks
│       ├── auth.login/           # Login page (shop domain form)
│       │   ├── route.tsx
│       │   └── error.server.tsx
│       ├── webhooks.app.uninstalled.tsx        # Deletes sessions, soft-deletes merchant
│       ├── webhooks.app.scopes_update.tsx      # Updates session scope in DB
│       ├── webhooks.app_subscriptions.update.tsx  # Plan activation/cancellation → updates tier
│       ├── webhooks.customers.data_request.tsx # GDPR — logs only (no customer PII stored)
│       ├── webhooks.customers.redact.tsx       # GDPR — logs only (no customer PII stored)
│       └── webhooks.shop.redact.tsx            # GDPR hard-delete — removes merchant + cascade
├── supabase/
│   └── schema.sql                # Full database schema (sessions, merchants, scans, violations)
├── public/
│   ├── favicon.ico
│   └── logo-main.png
├── extensions/                   # Shopify extensions directory (currently empty)
├── shopify.app.toml              # Shopify app config (client_id, scopes, webhooks, auth URLs)
├── shopify.web.toml              # Shopify web config (roles, dev command)
├── vite.config.ts                # Vite config with HMR, CORS, App Bridge optimizeDeps
├── tsconfig.json                 # TypeScript strict config, ES2022 target
├── Dockerfile                    # Production Docker build (node:20-alpine)
├── .eslintrc.cjs                 # ESLint config (React, TS, a11y, import)
├── .graphqlrc.ts                 # GraphQL codegen config for Shopify Admin API
├── .npmrc                        # engine-strict + shamefully-hoist
├── .mcp.json                     # MCP server config for Shopify Dev
├── claude.md                     # Older project context file (superseded by this CLAUDE.md)
└── package.json
```

---

## 4. Routes & What They Do

### Public Routes

| Route | File | Purpose |
|---|---|---|
| `/` | `routes/_index/route.tsx` | Public landing page. If `?shop=` param is present, redirects to `/app`. Shows shop domain login form and feature highlights. |
| `/auth/login` | `routes/auth.login/route.tsx` | Login page — POST submits shop domain to initiate OAuth. |
| `/auth/*` | `routes/auth.$.tsx` | Catch-all for OAuth callbacks — runs `authenticate.admin(request)`. |

### Authenticated App Routes (embedded in Shopify Admin)

| Route | File | Purpose |
|---|---|---|
| `/app` | `routes/app.tsx` | **Layout shell** — authenticates via `authenticate.admin()`, wraps children in `<AppProvider>` with `<s-app-nav>`. |
| `/app` (index) | `routes/app._index.tsx` | **Main dashboard** — two states: (1) Onboarding wizard (first-time users, no scans yet), (2) KPI dashboard with score banner, metric cards, and 10-point audit checklist with fix instructions. Runs scans via fetcher POST to `/api/scan`. Sends welcome email on first scan. |
| `/app/additional` | `routes/app.additional.tsx` | Template example page from Shopify scaffold (demonstrates multi-page nav). |
| `/app/billing/confirm` | `routes/app.billing.confirm.tsx` | Post-billing landing — calls `billing.check()`, writes tier/scans_remaining to Supabase, redirects to `/app`. |
| `/app/dmca-takedowns` | `routes/app.dmca-takedowns.tsx` | **Stub** — redirects to `/app/pricing` (DMCA feature deferred). |
| `/app/test` | `routes/app.test.tsx` | **Dev-only** — runs a live compliance scan and renders raw JSON + styled results. Temporary, to be deleted. |
| `/app/upgrade` | `routes/app.upgrade.tsx` | Triggers `billing.request()` for the plan specified in `?plan=<Starter|Pro|Shield>`. Always redirects (billing.request throws a redirect to Shopify's approval page). |

### API Routes

| Route | File | Method | Purpose |
|---|---|---|---|
| `/api/scan` | `routes/api.scan.ts` | POST (action) | Authenticated scan endpoint. Looks up merchant, enforces scan quota, runs `runComplianceScan()`, decrements quota, returns full results as JSON. GET returns 405. |

### Webhook Routes

| Route | File | Topic | Purpose |
|---|---|---|---|
| `/webhooks/app/uninstalled` | `webhooks.app.uninstalled.tsx` | `app/uninstalled` | Deletes all sessions for the shop, soft-deletes merchant (sets `uninstalled_at`). |
| `/webhooks/app/scopes_update` | `webhooks.app.scopes_update.tsx` | `app/scopes_update` | Updates session scope in DB when merchant changes app permissions. |
| `/webhooks/app_subscriptions/update` | `webhooks.app_subscriptions.update.tsx` | `APP_SUBSCRIPTIONS_UPDATE` | On ACTIVE: sets tier + unlimited scans. On CANCELLED/EXPIRED/DECLINED/FROZEN: downgrades to free tier with 0 scans remaining. |
| `/webhooks/customers/data_request` | `webhooks.customers.data_request.tsx` | GDPR | Logs request — ShieldKit stores no customer PII. |
| `/webhooks/customers/redact` | `webhooks.customers.redact.tsx` | GDPR | Logs request — no customer PII to delete. |
| `/webhooks/shop/redact` | `webhooks.shop.redact.tsx` | GDPR | Hard-deletes merchant + cascades (scans, violations). Cleans up lingering sessions. |

---

## 5. Database Schema (Supabase)

Schema defined in `supabase/schema.sql`. Uses `pgcrypto` extension for UUID generation.

### `sessions` Table

Shopify OAuth session storage. Access tokens and refresh tokens are AES-256-GCM encrypted.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Session ID from Shopify |
| `shop` | TEXT NOT NULL | e.g. `mystore.myshopify.com` |
| `state` | TEXT NOT NULL | OAuth CSRF nonce |
| `is_online` | BOOLEAN | Online (user) vs offline (shop) session |
| `scope` | TEXT | Granted OAuth scopes |
| `expires` | TIMESTAMPTZ | Session expiry |
| `access_token` | TEXT | **Encrypted** (AES-256-GCM) |
| `user_id` | BIGINT | Online session: Shopify user ID |
| `first_name`, `last_name`, `email` | TEXT | Online session user info |
| `account_owner` | BOOLEAN | Is store owner |
| `locale` | TEXT | User locale |
| `collaborator`, `email_verified` | BOOLEAN | |
| `refresh_token` | TEXT | **Encrypted** (AES-256-GCM) |
| `refresh_token_expires` | TIMESTAMPTZ | |

RLS enabled. No anon/authenticated policies — server uses service_role which bypasses RLS.

### `merchants` Table

One row per installed shop. Soft-deleted on uninstall (`uninstalled_at` set), hard-deleted 48h later on GDPR `shop/redact` webhook.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `shopify_domain` | TEXT UNIQUE | e.g. `mystore.myshopify.com` |
| `shop_name` | TEXT | |
| `access_token_encrypted` | TEXT | AES-256-GCM encrypted access token (separate from sessions table) |
| `billing_plan` | TEXT DEFAULT 'free' | |
| `billing_status` | TEXT | |
| `scans_remaining` | INTEGER DEFAULT 1 | `null` = unlimited (paid tiers), `0` = exhausted |
| `installed_at` | TIMESTAMPTZ | |
| `uninstalled_at` | TIMESTAMPTZ | Set on uninstall, cleared on reinstall |
| `created_at` | TIMESTAMPTZ | |

**Note:** The `tier` column (used in app code as `free`, `starter`, `pro`, `shield`) is added via migration — see migration notes in `api.scan.ts` and `webhooks.app_subscriptions.update.tsx`.

RLS policy: `shopify_domain = current_setting('app.current_shop', true)`.

### `scans` Table

One row per compliance scan run.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `merchant_id` | UUID FK → merchants | ON DELETE CASCADE |
| `scan_type` | TEXT | `'manual'` or `'automated'` |
| `compliance_score` | NUMERIC(5,2) | Percentage 0–100 |
| `total_checks` | INTEGER | Always 10 currently |
| `passed_checks` | INTEGER | |
| `critical_count` | INTEGER | |
| `warning_count` | INTEGER | |
| `info_count` | INTEGER | |
| `created_at` | TIMESTAMPTZ | |

### `violations` Table

Individual check results within a scan. Always 10 rows per scan (one per check).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `scan_id` | UUID FK → scans | ON DELETE CASCADE |
| `check_name` | TEXT | e.g. `contact_information`, `refund_return_policy` |
| `passed` | BOOLEAN | |
| `severity` | TEXT | `'critical'`, `'warning'`, `'info'`, `'error'` |
| `title` | TEXT | Human-readable check title |
| `description` | TEXT | Detailed finding |
| `fix_instruction` | TEXT | Plain-English remediation steps |
| `raw_data` | JSONB | Full diagnostic data for each check |
| `created_at` | TIMESTAMPTZ | |

### Relationships

```
merchants (1) ──→ (N) scans ──→ (N) violations
```

All cascading deletes: deleting a merchant removes all scans and violations.

---

## 6. Compliance Scanner Engine

Entry point: `runComplianceScan(merchantId, shopifyDomain, scanType)` in `app/lib/compliance-scanner.server.ts`.

### Architecture

1. Creates a Shopify Admin GraphQL client using stored encrypted access token.
2. Fetches data concurrently: `getShopInfo()`, `getShopPolicies()`, `getProducts(50)`, `getPages(20)`.
3. Pre-fetches public storefront (homepage + up to 3 product pages) via HTTP.
4. Runs all 10 checks concurrently (each wrapped in `safeCheck()` — errors don't abort the scan).
5. Aggregates scores, persists scan + 10 violation rows to Supabase.

### The 10 Checks

| # | Check Name | Severity if Failed | What It Checks |
|---|---|---|---|
| 1 | `contact_information` | Critical | Phone, store-domain email, physical address on contact/about pages (need ≥2 of 3) |
| 2 | `refund_return_policy` | Critical/Warning | Refund policy exists with return window, item condition, refund method; no placeholder text |
| 3 | `shipping_policy` | Critical/Warning | Shipping policy exists with delivery timelines and cost information |
| 4 | `privacy_and_terms` | Critical/Warning | Privacy Policy (critical if missing) and Terms of Service (warning if missing) |
| 5 | `product_data_quality` | Warning/Info | Product descriptions (≥100 chars), images, pricing, SKU presence |
| 6 | `checkout_transparency` | Warning | Payment method icons detected on homepage (Visa, Mastercard, PayPal, etc.) |
| 7 | `storefront_accessibility` | Critical/Warning | Store is not password-protected; product pages return HTTP 200 |
| 8 | `structured_data_json_ld` | Warning | Product JSON-LD schema on product pages (name, image, description, offers) |
| 9 | `page_speed` | Warning | Google PageSpeed Insights mobile performance ≥50/100; no intrusive interstitials |
| 10 | `business_identity_consistency` | Info | Store name vs. domain Jaccard word-overlap ≥0.3 |

Checks 1–5 are the "Fatal Five" (synchronous, GraphQL data only). Checks 6–10 are the "Advanced" checks (async, public storefront + external APIs).

---

## 7. Shopify API Integrations

### GraphQL Admin API (via `app/lib/shopify-api.server.ts`)

All queries go through `executeWithRetry()` which handles THROTTLED errors with exponential backoff (500ms, 1s, 2s, max 3 retries).

| Query | Purpose | Used By |
|---|---|---|
| `ShieldKitShopInfo` | Shop name, email, billing address, domain, currency | Checks 1, 10 |
| `ShieldKitShopPolicies` | Refund, privacy, terms, shipping policies | Checks 2, 3, 4 |
| `ShieldKitProducts($first)` | Products with images and variants (up to 50) | Check 5, storefront sampling |
| `ShieldKitPages($first)` | Online store pages — title, body, handle (up to 20) | Checks 1, 10 |

Two executor modes:
- **Interactive** (`wrapAdminClient`): wraps `admin.graphql` from `authenticate.admin()` — used in route loaders/actions.
- **Background** (`createAdminClient`): decrypts stored token and makes raw fetch calls — used by the scanner engine.

### OAuth & Authentication

- `@shopify/shopify-app-react-router` handles OAuth flow.
- `authPathPrefix: "/auth"` — OAuth routes under `/auth/*`.
- `AppDistribution.AppStore` — public app distribution.
- `expiringOfflineAccessTokens: true` — future-proofed for rotating tokens.
- `afterAuth` hook: upserts merchant record in Supabase on every offline session OAuth completion.

### Billing

Three plans defined in `shopify.server.ts`:

| Plan | Price | Interval |
|---|---|---|
| Starter | $29.00/mo | Every30Days |
| Pro | $49.00/mo | Every30Days |
| Shield | $99.00/mo | Every30Days |

- `billing.request()` called from `/app/upgrade?plan=<name>`.
- `billing.check()` called from `/app/billing/confirm` after redirect.
- Plan constants (`PLAN_STARTER`, `PLAN_PRO`, `PLAN_SHIELD`) kept in sync across billing config, request calls, and webhook payload matching.

### Webhooks

Registered in `shopify.app.toml`:

| Topic | URI | Handler |
|---|---|---|
| `app/uninstalled` | `/webhooks/app/uninstalled` | Session deletion + merchant soft-delete |
| `app/scopes_update` | `/webhooks/app/scopes_update` | Session scope update |
| GDPR (3 mandatory) | `/webhooks/customers/*`, `/webhooks/shop/redact` | Compliance logging and hard-delete |

`APP_SUBSCRIPTIONS_UPDATE` is registered via the Shopify Partner Dashboard (not in TOML).

### Scopes

Read-only: `read_products,read_content,read_legal_policies`

---

## 8. Authentication & Session Handling

1. **OAuth** is managed by `@shopify/shopify-app-react-router` with session storage backed by Supabase.
2. **Session Storage** (`SupabaseSessionStorage`): custom class implementing 5 methods — `storeSession`, `loadSession`, `deleteSession`, `deleteSessions`, `findSessionsByShop`.
3. **Token Encryption**: All access tokens and refresh tokens are AES-256-GCM encrypted using `TOKEN_ENCRYPTION_KEY` (env var, min 32 chars). Key derived via `scrypt` with static salt `"shieldkit-token-v1"`.
4. **Route Protection**: Every `/app/*` route calls `authenticate.admin(request)` in its loader. Webhook routes use `authenticate.webhook(request)` which verifies `X-Shopify-Hmac-Sha256`.
5. **Merchant Token Storage**: The `afterAuth` hook also stores an encrypted copy of the access token in `merchants.access_token_encrypted` — this is used by the background scanner engine (`createAdminClient`) independently of the session storage.

---

## 9. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | Yes | Shopify app API key (client_id) |
| `SHOPIFY_API_SECRET` | Yes | Shopify app API secret |
| `SHOPIFY_APP_URL` | Yes | Public app URL (e.g. `https://shieldkit.vercel.app`) |
| `SCOPES` | No | OAuth scopes (defaults to `read_products,read_content`) |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (bypasses RLS) |
| `TOKEN_ENCRYPTION_KEY` | Yes | Min 32 chars — used for AES-256-GCM token encryption |
| `RESEND_API_KEY` | Yes | Resend API key for transactional emails |
| `GOOGLE_PAGESPEED_API_KEY` | No | Google PSI API key (increases quota; unauthenticated tier used if absent) |
| `SHOP_CUSTOM_DOMAIN` | No | Custom shop domain for Shopify app config |
| `PORT` | No | Server port (default: 3000) |
| `FRONTEND_PORT` | No | HMR port for non-localhost deployments (default: 8002) |
| `NODE_ENV` | No | `production` enables real billing; otherwise test charges |

---

## 10. Build & Dev Commands

| Command | Description |
|---|---|
| `npm run dev` | Start dev server via `shopify app dev` (includes tunnel + HMR) |
| `npm run build` | Production build via `react-router build` |
| `npm run start` | Serve production build via `react-router-serve ./build/server/index.js` |
| `npm run typecheck` | Run `react-router typegen` then `tsc --noEmit` |
| `npm run lint` | ESLint with gitignore and cache |
| `npm run deploy` | Deploy via `shopify app deploy` |
| `npm run config:link` | Link Shopify app config |
| `npm run generate` | Shopify app generate (extensions, etc.) |
| `npm run graphql-codegen` | Generate GraphQL types from Shopify Admin API schema |

### Docker

```dockerfile
FROM node:20-alpine
# npm ci --omit=dev → npm run build → npm run docker-start (= npm run start)
```

---

## 11. Conventions & Patterns

### File Naming

- **`.server.ts` / `.server.tsx` suffix**: Server-only modules — never import in client code. Contains Node APIs (`crypto`), env vars, and DB access.
- **Route files**: Follow React Router v7 flat-routes convention. Dots in filenames = nested layout segments (e.g. `app._index.tsx` is the index child of `app.tsx` layout).
- **Webhook routes**: Named `webhooks.<topic>.tsx` matching Shopify topic paths.

### Server-Side Patterns

- **Singleton services**: `supabase.server.ts` uses a global singleton pattern to prevent multiple DB connections on HMR reload.
- **GraphQL executor abstraction**: `GraphQLExecutor` type normalises both interactive (admin.graphql) and background (raw fetch) modes so data functions are mode-agnostic.
- **`safeCheck()` wrapper**: Every compliance check is wrapped so thrown errors produce a well-formed `"error"` severity result instead of aborting the entire scan.
- **Exponential backoff**: Shopify API throttling handled with `executeWithRetry()` (500ms base, 3 retries).

### UI Patterns

- **Shopify Polaris Web Components**: All UI uses `<s-page>`, `<s-section>`, `<s-button>`, etc. — not raw HTML/CSS for layout.
- **Inline styles in dashboard**: `app._index.tsx` uses inline styles extensively for the KPI dashboard and audit checklist (not CSS modules).
- **App Bridge**: `useAppBridge()` used for `shopify.toast.show()` notifications.
- **Fetcher pattern**: Scans are triggered via `useFetcher()` POST to `/api/scan` — keeps the page interactive during the scan.

### Security Patterns

- **Encrypted tokens at rest**: Both session access tokens and merchant access tokens are AES-256-GCM encrypted.
- **HMAC webhook verification**: All webhook routes use `authenticate.webhook()` which validates `X-Shopify-Hmac-Sha256`.
- **Row-Level Security**: All Supabase tables have RLS enabled. Server uses service_role (bypasses RLS); RLS policies guard anon/user key access by matching `shopify_domain`.
- **Scan quota enforcement**: Free tier gets 1 scan (`scans_remaining`). Paid tiers get `null` (unlimited). Quota is only decremented after a successful scan commit.

### Error Handling

- **Webhook routes**: Always return HTTP 200 to Shopify (even on internal errors) to prevent unnecessary retries.
- **ErrorBoundary**: `app.tsx` exports an ErrorBoundary using `boundary.error(useRouteError())` for Shopify-compatible error handling.
- **Streaming SSR**: `entry.server.tsx` uses `onShellReady` for regular users and `onAllReady` for bots, with a 6-second abort timeout.

### Billing Flow

1. User clicks upgrade → `/app/upgrade?plan=Pro` → `billing.request()` redirects to Shopify approval page.
2. After approval → Shopify redirects to `/app/billing/confirm` → `billing.check()` verifies subscription → writes tier to Supabase → redirects to `/app`.
3. Webhook `APP_SUBSCRIPTIONS_UPDATE` fires as a reconciliation backstop — also writes tier changes.
4. On cancellation/expiry → webhook downgrades to `free` tier with `scans_remaining = 0`.
