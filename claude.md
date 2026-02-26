# ShieldKit - Project Context & Guidelines

## 1. Project Overview
ShieldKit is a B2B SaaS Shopify Embedded App. 
* **Module A (Current MVP):** A 10-point automated compliance scanner to prevent Google Merchant Center (GMC) suspensions. 
* **Module B (Future/Hidden):** An automated DMCA Takedown Legal Engine. All DMCA features are currently hidden/stubbed to pass the initial Shopify App Store review.

## 2. Tech Stack
* **Framework:** Remix (React Router v7)
* **Platform:** Shopify App Bridge 4.x
* **UI Library:** Shopify Polaris Web Components (Strict adherence required)
* **Database:** Supabase (PostgreSQL)
* **Session Storage:** Custom `SupabaseSessionStorage` (No Prisma/SQLite)
* **Security:** AES-256-GCM token encryption (`app/lib/crypto.server.ts`)

## 3. Database Schema (Supabase)
* `sessions`: Shopify OAuth session storage.
* `merchants`: Tracks shop data (`tier` [free, starter, pro], `scans_remaining`). Soft-deletes on app uninstall.
* `scans`: One row per run. Tracks `compliance_score`, `total_checks`, `passed_checks`.
* `violations`: Relational to scans. Tracks `check_name`, `passed`, `severity` (critical, warning, info), `fix_instruction`.

## 4. UI & Styling Rules
* **Polaris Only:** Use native Shopify Polaris components (`Card`, `BlockStack`, `InlineGrid`, `Text`, etc.). Do not use raw HTML/CSS for layout.
* **Brand Color:** "Security Blue" (`#0F172A`). This is globally injected in `app.tsx` by overriding `--p-color-bg-fill-brand` properties on `s-button[variant="primary"]` to pierce the shadow DOM.
* **Typography:** Use Polaris `<Text>` variants for strict hierarchy.
* **Layouts:** Rely heavily on `bg-surface` for cards, and use semantic Polaris background tones (`bg-surface-success`, `bg-surface-warning`, `bg-surface-critical`, `bg-surface-info`) for dynamic data states.

## 5. Current Architecture
* `app/routes/app.tsx`: Root layout, global CSS injection, App Bridge Nav.
* `app/routes/app._index.tsx`: Main Dashboard. Handles the First-Time Onboarding Wizard and the returning user KPI/Checklist view.
* `app/routes/app.scan-history.tsx`: History table. Locked via UI callout for `free` tier users.
* `app/routes/app.pricing.tsx`: Upgrade page ($0 Free, $29 Compliance Pro).
* `app/routes/app.upgrade.tsx`: Action route that triggers `billing.request()`.
* `app/routes/api.scan.ts`: Authenticated API endpoint that runs the GMC checks.
* `app/routes/webhooks.*`: Handles `app_subscriptions/update`, `app/uninstalled`, and the 3 mandatory GDPR webhooks (which return 200 OK).

## 6. Immediate Pending Tasks (Next Session)
When modifying `app._index.tsx` or `app.upgrade.tsx`, ensure:
1. An `ErrorBoundary` is exported from `app._index.tsx` using `boundary.error(useRouteError())` and Polaris components to catch UI crashes.
2. The infinite toast bug (`shopify.toast.show`) is deduplicated using state.
3. Billing cancellation from `billing.request()` is handled gracefully if the merchant declines the charge.
4. The KPI dashboard reflects accurate, dynamic background colors based on score math.