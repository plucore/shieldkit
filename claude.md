# ShieldKit - Project Context & Guidelines

## 1. Project Overview
ShieldKit is a B2B SaaS Shopify Embedded App.
* **Module A (Current MVP):** A 10-point automated compliance scanner to prevent Google Merchant Center (GMC) suspensions.
* **Module B (Future/Hidden):** An automated DMCA Takedown Legal Engine. All DMCA features are currently hidden/stubbed. `app.dmca-takedowns.tsx` redirects to `/app`.

## 2. Current Status (as of 2025-03-30)
* **Hosting:** Vercel (`shieldkit.vercel.app`). App URL and redirect URLs point there via `shopify.app.toml`.
* **Database:** Supabase project `bhnpcirhutczdorkhibm`. RLS enabled on all tables; app uses service_role key (bypasses RLS).
* **Auth:** Shopify App Bridge 4.x JWT-based. OAuth sessions stored in Supabase `sessions` table via custom `SupabaseSessionStorage`. `afterAuth` hook upserts merchant on install/re-auth.
* **Billing:** Three paid plans configured: Starter ($29), Pro ($49), Shield ($99) — all 30-day recurring. Free tier is default. Billing flow: `/app/upgrade?plan=X` -> Shopify approval page -> `/app/billing/confirm` (checks subscription, writes tier to Supabase, redirects to dashboard). On decline, redirects to `/app?billing=cancelled` which shows a dismissible warning banner. Webhook `APP_SUBSCRIPTIONS_UPDATE` serves as reconciliation backstop.
* **Email:** Resend (`resend` npm package) sends a welcome email on first scan. Lead deduplication via `leads` table in Supabase.
* **Scanner:** 10-point GMC compliance engine in `app/lib/compliance-scanner.server.ts`. Uses `app/lib/shopify-api.server.ts` for GraphQL data fetching and Cheerio for HTML parsing.
* **Outbound scanner:** Standalone CLI script `scripts/outbound-scanner.ts` — runs subset of checks against any public Shopify storefront without OAuth. Not connected to the app.

## 3. Tech Stack
* **Framework:** Remix (React Router v7)
* **Platform:** Shopify App Bridge 4.x
* **UI Library:** Shopify Polaris Web Components (Strict adherence required — `<s-page>`, `<s-card>`, `<s-button>`, etc.)
* **Database:** Supabase (PostgreSQL), service_role key
* **Session Storage:** Custom `SupabaseSessionStorage` (No Prisma/SQLite)
* **Security:** AES-256-GCM token encryption (`app/lib/crypto.server.ts`)
* **Email:** Resend (`app/utils/email.server.ts`)
* **HTML parsing:** Cheerio (compliance scanner)

## 4. Database Schema (Supabase)
* `sessions`: Shopify OAuth session storage.
* `merchants`: One row per shop. Key columns: `shopify_domain` (unique), `billing_plan` (in schema.sql) / `tier` (in app code — see Known Issues), `scans_remaining`, `access_token_encrypted`, `uninstalled_at` (soft-delete).
* `scans`: One row per compliance scan run. Tracks `compliance_score`, `total_checks`, `passed_checks`, `critical_count`, `warning_count`, `info_count`.
* `violations`: Individual check results per scan. Tracks `check_name`, `passed`, `severity` (critical, warning, info), `title`, `description`, `fix_instruction`, `raw_data` (JSONB).
* `leads`: Deduplication table for welcome emails (`shop_domain`, `email`). **Not in `supabase/schema.sql`** — was created directly in Supabase.

## 5. UI & Styling Rules
* **Polaris Only:** Use native Shopify Polaris web components. Do not use raw HTML/CSS for layout.
* **Brand Color:** "Security Blue" (`#0F172A`). Injected in `app.tsx` by overriding `--p-color-bg-fill-brand` on `s-button[variant="primary"]` to pierce shadow DOM.
* **Typography:** Use Polaris `<Text>` variants for strict hierarchy.
* **Layouts:** Use semantic Polaris background tones (`bg-surface-success`, `bg-surface-warning`, `bg-surface-critical`, `bg-surface-info`) for dynamic data states.

## 6. Route Map
* `app/routes/app.tsx`: Root layout, global CSS injection, App Bridge Nav. Calls `authenticate.admin` to gate all nested `/app/*` routes.
* `app/routes/app._index.tsx`: Main Dashboard (~1330 lines). Onboarding wizard (no scan yet) + returning user KPI/Checklist view. Shows dismissible billing cancellation banner when `?billing=cancelled` is present. ErrorBoundary is exported. Toast is deduplicated via `toastId` state.
* `app/routes/app.upgrade.tsx`: Loader-only route — validates plan param against whitelist, calls `billing.request()`, redirects to Shopify approval page. Returns to `/app/billing/confirm`.
* `app/routes/app.billing.confirm.tsx`: Post-billing landing. Calls `billing.check()`, writes tier to Supabase, redirects to dashboard (or `/app?billing=cancelled` on decline).
* `app/routes/app.dmca-takedowns.tsx`: Stub — redirects to `/app`. DMCA module deferred.
* `app/routes/app.additional.tsx`: Boilerplate additional page (unused).
* `app/routes/api.scan.ts`: Authenticated POST endpoint for running scans. Enforces scan quota, returns full results as JSON.
* `app/routes/_index/route.tsx`: Public landing page (non-embedded login form).
* `app/routes/auth.login/route.tsx`: Shopify OAuth login page with shop domain form.
* `app/routes/auth.$.tsx`: Catch-all OAuth callback handler.
* `app/routes/webhooks.*`: `app/uninstalled` (soft-delete), `app/scopes_update`, `app_subscriptions/update` (billing tier sync), 3 GDPR webhooks (200 OK).

## 7. Architecture Decisions
* **No Prisma/SQLite** — All persistence goes through Supabase JS client with service_role key. Session storage is a custom class, not the default Prisma adapter.
* **`maybeSingle()` not `single()`** — Supabase queries use `maybeSingle()` to avoid 406 errors when rows are missing.
* **Three billing tiers** — Starter/Pro/Shield, not a single paid tier. Plan names in `shopify.server.ts` (`PLAN_STARTER`, `PLAN_PRO`, `PLAN_SHIELD`) must match billing config keys exactly.
* **Billing return flow** — `billing.request()` returns to `/app/billing/confirm` (not `/app` directly) so the billing check + DB write happens synchronously before the dashboard loads. The webhook is a backup reconciliation.
* **Welcome email fire-and-forget** — Sent on first scan only, deduplicated via `leads` table, intentionally not awaited so it can't block the scan response.
* **Global Supabase singleton** — `app/supabase.server.ts` uses `any` for global type to avoid TS generic mismatch.
* **Scopes are read-only** — `read_products,read_content,read_legal_policies`. The app never writes to merchant stores.
* **Polaris web component type gaps** — Several Polaris web component props (`url`, `submit`, `loading` as string) work at runtime but are not in the TS type definitions. The codebase uses `@ts-ignore` or spread patterns to suppress these. This is expected; do not try to "fix" these type errors.

## 8. Known Issues

### Schema Drift
* **`billing_plan` vs `tier`** — `supabase/schema.sql` defines `merchants.billing_plan` but all app code references `merchants.tier`. The live DB was likely altered manually. The schema file is stale and won't work for fresh deployments.
* **`leads` table missing from schema.sql** — Created directly in Supabase, not tracked in the schema file.
* **`merchants.tier` CHECK constraint** — The webhook file documents a required migration to expand the CHECK constraint to include `('free', 'starter', 'pro', 'shield')`. Unclear if this was applied to the live DB.

### Medium
* **No `app.pricing.tsx` route** — There is no standalone pricing page. Upgrade links go directly to `/app/upgrade?plan=X`.
* **GraphQL queries not paginated** — `shopify-api.server.ts` fetches `first: 50` products and `first: 20` pages without pagination. Stores with more items get incomplete compliance scans.
* **No rate limiting on `/api/scan`** — Only gated by `scans_remaining` quota and Shopify auth. No per-time-window throttle.

### Low
* **Duplicate entries in `.gitignore`** — `.env`, `node_modules/`, `.shopify/`, etc. are listed twice.

## 9. Next Priorities (in order)
1. **Sync `supabase/schema.sql`** — Add `tier` column (or rename from `billing_plan`), add `leads` table, and update CHECK constraints to match the live DB.
2. **Build `app.pricing.tsx`** — A standalone pricing page showing all three tiers (Free, Starter $29, Pro $49, Shield $99) with feature comparison.
3. **Build `app.scan-history.tsx`** — Scan history table showing past scans. Consider gating behind paid tiers.
4. **Add pagination to GraphQL queries** — `getProducts` and `getPages` in `shopify-api.server.ts` need cursor-based pagination for stores with >50 products.
5. **Clean up `.gitignore`** — Remove duplicate entries.

## 10. Env Vars Required
* `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`
* `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
* `TOKEN_ENCRYPTION_KEY` (>= 32 chars, hex string)
* `RESEND_API_KEY` (for welcome emails)
* `GOOGLE_PAGESPEED_API_KEY` (optional, for outbound scanner script only)
