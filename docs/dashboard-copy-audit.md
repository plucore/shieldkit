# ShieldKit Dashboard — Copy & Content Audit

**Purpose:** Read-only inventory of every user-facing string on the embedded-app dashboard, as input to a benefit-driven copy rewrite. **This is an inventory only — no copy has been changed, invented, or "improved."** Every quoted string is verbatim from source as of this audit.

**Target reader (for the rewrite):** a non-technical Shopify merchant, often a suspended/at-risk dropshipper, who does **not** understand "JSON-LD", "structured data", "schema", "llms.txt", "crawler", "metafield", "GTIN/MPN", "AggregateOffer", "priceCurrency", "interstitial", etc. Jargon is flagged inline with **⚠️JARGON** and admin paths are flagged with **📍PATH** so they can be sanity-checked against current Shopify admin.

**Sources read:**
- `app/routes/app._index.tsx` (orchestrator: onboarding, main column, all inline aside cards, banners, actions/server messages)
- `app/routes/app.tsx` (NavMenu chrome — adjacent surface)
- Aside/main components: `PlanStatusCard`, `SecurityStatusAside`, `AIVisibilityCard`, `PolicyGenerationCard`, `ScoreBanner`, `ScoreTrend`, `KpiCards`, `AuditChecklist`, `ScanProgressIndicator`
- `app/lib/billing/plans.ts` (`PAID_FEATURES`, `FREE_FEATURES`, `PLANS` — rendered verbatim by `PlanStatusCard`)
- `app/lib/scan-helpers.ts` (badge/threat-label text)
- `app/lib/constants.ts` (`BEACON_LISTING_URL`)
- All 12 check modules in `app/lib/checks/*`

Page-level heading (always): **`ShieldKit — Compliance Command Center`** — ⚠️JARGON-ish ("Compliance Command Center" is on-brand but abstract). `s-page heading` at [app._index.tsx:1001](app/routes/app._index.tsx:1001).

---

## PART 1 — ASIDE / SIDE-PANEL CARDS

Aside cards render in this DOM order (all in `slot="aside"`):
`PlanStatusCard` → `SecurityStatusAside` → `PolicyGenerationCard` (paid) → `AIVisibilityCard` (paid) → Free JSON-LD card → Beacon card → About card.

Note: `PlanStatusCard`, `PolicyGenerationCard`, and `AIVisibilityCard` are gated on `!showOnboarding` (i.e. hidden entirely on a first-time store that has never scanned). `SecurityStatusAside`, the JSON-LD card, the Beacon card, and the About card render in **both** onboarding and dashboard states.

---

### 1.1 — PlanStatusCard  ·  `app/components/PlanStatusCard.tsx`

Two mutually-exclusive states driven by `isPaid = hasPaidAccess(tier)`.

**Render condition** — [app._index.tsx:1337](app/routes/app._index.tsx:1337):
```
{merchant && !showOnboarding && (
  <PlanStatusCard isPaid={isPaid} jsonLdEnabled={merchant.json_ld_enabled} onUpgrade={onUpgradeFromPlanCard} />
)}
```
Internal switch — [PlanStatusCard.tsx:52](app/components/PlanStatusCard.tsx:52): `if (isPaid) return <PaidCoverageCard/>; return <FreeUpgradeCard/>;`

**Length:** medium (9-row list + optional CTA).

#### PAID state — `PaidCoverageCard`
- Heading: **`Your ShieldKit coverage`**
- Rows = `PAID_FEATURES` verbatim (from `plans.ts`), each with a green check — except the JSON-LD row, which shows a muted "off" dot when `!jsonLdEnabled` (display-only status, no action):

  1. `Unlimited on-demand scans`
  2. `AI-written store policies (refund, shipping, privacy, terms)`
  3. `GMC re-review appeal letter generator` — ⚠️JARGON: "GMC"
  4. `Product data fixes (GTIN / MPN / brand)` — ⚠️JARGON: "GTIN / MPN"
  5. `Auto structured data for new products` — ⚠️JARGON: "structured data"
  6. `llms.txt for AI search` — ⚠️JARGON: "llms.txt"
  7. `AI crawler allow/block controls` — ⚠️JARGON: "crawler"
  8. `Store schema settings (logo, social, search)` — ⚠️JARGON: "schema"
  9. `JSON-LD product schema extension` — ⚠️JARGON: "JSON-LD", "schema" (this is the display-only status row)

- No CTA, no body copy, no urgency.

#### FREE state — `FreeUpgradeCard`
- Heading: **`Fix it now — and stay protected.`** (constant `HEADING_FREE`, [PlanStatusCard.tsx:98](app/components/PlanStatusCard.tsx:98))
- Free-tier rows (checked) = `FREE_FEATURES` verbatim:
  1. `One free compliance scan`
  2. `Step-by-step fix instructions`
  3. `JSON-LD product schema extension` — ⚠️JARGON: "JSON-LD", "schema" (shown **checked** to free users, since it's in `FREE_FEATURES`)
- Paid-only rows (locked + muted) = `PAID_FEATURES` minus the JSON-LD index and minus anything already in `FREE_FEATURES`. So free users see these as locked:
  `Unlimited on-demand scans`, `AI-written store policies (refund, shipping, privacy, terms)`, `GMC re-review appeal letter generator`, `Product data fixes (GTIN / MPN / brand)`, `Auto structured data for new products`, `llms.txt for AI search`, `AI crawler allow/block controls`, `Store schema settings (logo, social, search)` (same jargon flags as above).
- CTA button (interpolated) — [PlanStatusCard.tsx:138](app/components/PlanStatusCard.tsx:138):
  `Unlock everything — $49/mo or $390/yr`
  > **⚠️ PRICE DISCREPANCY (factual, not copy):** the annual figure renders from `PLANS.monitoring_annual.annual = 390`, so the dashboard shows **$390/yr**. CLAUDE.md and this task brief both say the annual price is **$449**. The rendered CTA, the marketing landing page copy, and the Partner Dashboard plan should be reconciled to one number before rewriting. Flagging because a rewrite will re-state the price.

---

### 1.2 — SecurityStatusAside  ·  `app/components/SecurityStatusAside.tsx`

**Render condition** — always rendered (no gate) at [app._index.tsx:1345](app/routes/app._index.tsx:1345). Internally branches on `score !== null`.

**Length:** medium.

- Heading: **`Security Status`**
- **Populated state** (a scan exists):
  - Sub-label: `Threat Level`
  - Threat label (from `threatLabel(score)`, `scan-helpers.ts`): one of `Minimal` / `Low` / `Elevated` / `High` / `Critical`
  - Trend line (when a previous scan exists): `↑ Improved from {n}%` / `↓ Declined from {n}%` / `→ Unchanged`
  - Issue chips:
    - `{criticalCount}` **`critical issue`**`(s)` — pluralized "critical issues"
    - `{warningCount}` **`warning`**`(s)` — pluralized "warnings"
    - Clean state: `No critical threats detected`
- **Empty state** (`score === null`, i.e. no scan yet):
  `Run your first scan to see your store's threat level and security status.`

Jargon note: "Threat Level" / "critical threats" is security-framing, not merchant-outcome framing — worth reviewing for the outcome-driven rewrite, though not technical jargon per se.

---

### 1.3 — PolicyGenerationCard  ·  `app/components/PolicyGenerationCard.tsx`

**Render condition** — PAID only, dashboard only — [app._index.tsx:1353](app/routes/app._index.tsx:1353):
```
{merchant && isPaid && !showOnboarding && ( <PolicyGenerationCard .../> )}
```
**Additionally self-hides** when there are no failed policy checks: `if (visibleTypes.length === 0) return null;` ([PolicyGenerationCard.tsx:75](app/components/PolicyGenerationCard.tsx:75)). Rows only appear for **failed** `refund_return_policy`, `shipping_policy`, and `privacy_and_terms` (privacy/terms split by parsing the check title).

**Length:** medium → long (one expandable row per failed policy type; expanded view embeds full generated policy HTML).

- Heading: **`Policy Generation`**
- Row labels (`POLICY_LABELS`): `Refund Policy`, `Shipping Policy`, `Privacy Policy`, `Terms of Service`
- Action buttons per row: `Generate` (or `…` while loading), `Regenerate`, `View` / `Hide`, `Copy`, and in expanded view `Copy to Clipboard`
- Per-row counter: `{remaining}/2 generations remaining` (e.g. `2/2 generations remaining`)
- Footer disclaimer: `Review policies before publishing. Not legal advice.`

**Server-side action messages** (returned by the `generatePolicy` action in `app._index.tsx`, surfaced to this card / toasts):
- Toast on success: `Policy generated` ([app._index.tsx:879](app/routes/app._index.tsx:879))
- Toast on copy: `Policy copied to clipboard` ([app._index.tsx:1362](app/routes/app._index.tsx:1362))
- `A paid plan is required for AI policy generation.`
- `Invalid policy type.`
- `You've already used your one regeneration for this policy type.`
- `You've used all 12 AI generations this month. Your limit resets on {date}.` — ("12" is `AI_MONTHLY_CAP`)
- `Could not fetch shop info.`
- Soft validator warning: `Review this policy — it may be missing: {list}.`

---

### 1.4 — AIVisibilityCard  ·  `app/components/AIVisibilityCard.tsx`

**Render condition** — PAID only, dashboard only, AND data object present — [app._index.tsx:1369](app/routes/app._index.tsx:1369):
```
{merchant && isPaid && aiVisibility && !showOnboarding && ( ... <AIVisibilityCard .../> ... )}
```
(`aiVisibility` is only built in the loader when `hasPaidAccess(merchant.tier)`, so free merchants never receive it.) The card then branches internally on `isEmpty = thisWeekHits === 0 && priorWeekHits === 0` — it does **not** self-hide when empty; it renders a "not been crawled yet" state instead.

**Length:** short.

- Label: **`AI visibility`**
- **Empty state** (`isEmpty`):
  `Your llms.txt has not been crawled yet. AI engines typically discover new content within 7-30 days of publishing.` — ⚠️JARGON: "llms.txt", "crawled"
- **Data state:**
  `{n} crawler hit`(+`s`)` this week` — ⚠️JARGON: "crawler hit(s)"
  optional delta: `(+{x}% WoW)` / `(-{x}% WoW)` — ⚠️JARGON: "WoW" (week-over-week)
  optional: `Top: {crawler names joined by ", "}.` — ⚠️JARGON: exposes raw crawler names (e.g. "GPTBot", "PerplexityBot")

---

### 1.5 — Free JSON-LD Structured Data card  ·  inline in `app._index.tsx`

The **sole JSON-LD control surface** on the dashboard (by design — `PlanStatusCard`'s JSON-LD row is display-only). Inline block at [app._index.tsx:1388–1447](app/routes/app._index.tsx:1388).

**Render condition** — always rendered (no tier gate, no onboarding gate); branches on `merchant?.json_ld_enabled`.

**Length:** short.

- Heading: **`Free JSON-LD Structured Data`** — ⚠️JARGON: "JSON-LD", "Structured Data" (both technical terms, in the heading)
- **ON state** (`json_ld_enabled === true`):
  - Green check + `JSON-LD Active` — ⚠️JARGON
  - Body: `Product structured data is being added to your product pages.` — ⚠️JARGON: "structured data"
  - Button: `Manage`
- **OFF state** (`json_ld_enabled` falsy):
  - Body: `Opens your theme editor — add the Product Schema block and click Save.` — ⚠️JARGON: "Product Schema block"
  - Button: `Enable JSON-LD` — ⚠️JARGON: "JSON-LD"

> This card is the **#1 jargon offender** on the dashboard: the heading, both state labels, the body copy, and the button label are all built on "JSON-LD" / "structured data" / "schema block" — terms the target merchant does not know. It never explains the *outcome* (richer Google Shopping listings / eligibility for rich results).

---

### 1.6 — Beacon cross-promo card  ·  inline in `app._index.tsx`

Inline block at [app._index.tsx:1454–1484](app/routes/app._index.tsx:1454). Cross-promotes the sibling app "Beacon" (`BEACON_LISTING_URL = https://apps.shopify.com/beacon-4`).

**Render condition** — always rendered, **all tiers** (free + paid). Non-dismissable, no DB state.

**Length:** short.

- Heading: **`New from ShieldKit: Beacon`**
- Body: `Get your store found by AI search (ChatGPT, Perplexity, Google's AI Overviews). See how visible your store is.`
- Button: `Get Beacon`

Jargon note: relatively clean — "AI search", "ChatGPT", "Perplexity", "AI Overviews" are consumer-recognizable. This card is already fairly outcome-driven ("Get your store found").

---

### 1.7 — About ShieldKit card  ·  inline in `app._index.tsx`

Inline block at [app._index.tsx:1487–1497](app/routes/app._index.tsx:1487).

**Render condition** — always rendered, all tiers, both states.

**Length:** short.

- Heading: **`About ShieldKit`**
- Body: `ShieldKit scans your store against Google Merchant Center policies and shows you exactly what to fix to avoid suspension.` — ⚠️JARGON-lite: "Google Merchant Center" (acceptable — it's the merchant's actual problem context).

---

## PART 2 — MAIN COLUMN (non-aside)

### 2.1 — Primary action button (`slot="primary-action"`)
[app._index.tsx:1004–1023](app/routes/app._index.tsx:1004). Dashboard state only.
- Paid OR quota remaining: `Re-Scan My Store` (label `Scanning…` while running)
- Free + exhausted: `Manage plan`
- Scan-completion toast (fires once per completed scan, [app._index.tsx:923](app/routes/app._index.tsx:923)): `Compliance checked`

### 2.2 — Scan error banner
[app._index.tsx:1026–1042](app/routes/app._index.tsx:1026).
- Heading: `Free scan used` (when quota reached) / `Scan failed` (otherwise)
- Body = server message, one of:
  - `You've used your free scan. Upgrade to Monitoring for unlimited on-demand scans plus AI-written policies, appeal letters, and AI search visibility.` (402, quota reached — appears twice in source, identical)
  - `We hit an error running your scan. Your scan quota has been restored — please try again. If this keeps happening, contact support.`
  - `Scan failed — please try again.` (fallback)
  - `Merchant not found. Please reinstall the app.` / `Database error — please try again.`
- Action button (quota-reached only): `Upgrade`

### 2.3 — Billing cancellation banner
[app._index.tsx:1045–1070](app/routes/app._index.tsx:1045). Shown when `?billing=cancelled`.
- Body: `You're on the Free plan. Upgrade for unlimited scans and AI search visibility — catch issues before Google does.`
- Buttons: `View upgrade options` · `Dismiss`

### 2.4 — Onboarding wizard (first-time, `latestScan === null`)
[app._index.tsx:1073–1223](app/routes/app._index.tsx:1073). Length: long.
- Hero heading: **`Your GMC Compliance Dashboard`** — ⚠️JARGON: "GMC"
- Hero subhead: `Protect your Google Shopping revenue in under 60 seconds.` (good — outcome-driven)
- 3 static step cards:
  1. `Welcome to ShieldKit` — `ShieldKit runs a full 12-point audit of your Shopify store against every requirement that causes Google Merchant Center account suspensions — and shows you exactly how to fix each one.`
  2. `Why GMC Compliance Matters` — ⚠️JARGON: "GMC" — `Google frequently suspends Shopify stores for vague policy violations like "Misrepresentation", instantly cutting off your Google Shopping traffic. Worse, Google only gives you a limited number of appeals before a permanent ban. You must fix all trust signals before requesting a review.`
  3. `Run Your Free Compliance Scan` — `Get a complete compliance audit in under 60 seconds. ShieldKit identifies exactly which issues to fix to protect your Google Shopping revenue before Google flags your store.`
- Primary CTA: `Run My Free Compliance Scan →` (label `Scanning your store…` while running)

### 2.5 — ScanProgressIndicator  ·  `app/components/ScanProgressIndicator.tsx`
Shown while scanning. Length: short.
- Title: `Scanning your store…`
- Sub: `Running 12 compliance checks against your store. This takes 15–30 seconds.`

### 2.6 — ScoreBanner  ·  `app/components/ScoreBanner.tsx`
Dashboard only. Length: medium.
- Store domain chip: `{merchant.shopify_domain}`
- Big number: `{score}%` (or `—`)
- Label: `Compliance Score`
- Status badge: `Running all 12 compliance checks…` (scanning) / `Last scanned {date}` (idle)
- **Post-fix "clean" reassurance line** (paid + score ≥ 80 + zero critical + zero warning) — [ScoreBanner.tsx:133](app/components/ScoreBanner.tsx:133):
  `Your store is clean. ShieldKit keeps your structured data live, your products readable to AI search, and lets you re-scan instantly any time you change something.` — ⚠️JARGON: "structured data"
- Legacy automated-scan line (paid + a `lastAutomatedScan` row exists): `Last automated scan: {date}`
- New-issues banner (paid + `newAutoIssueCount > 0`): `Your automated monitoring detected {n} new issue`(+`s`)` since your last scan.`

### 2.7 — ScoreTrend  ·  `app/components/ScoreTrend.tsx`
Dashboard only. Length: short.
- Label: `Score trend (last 30 days)`
- Empty state (<2 scans): `Run another scan to track your progress over time.`
- Populated: `{first} → {last}` · `(+{delta} in {n} days)` · sparkline · `{n} issue`(+`s`)` fixed.`

### 2.8 — KpiCards  ·  `app/components/KpiCards.tsx`
Dashboard only. Length: short. Four labels:
`Checks Passed` · `Critical Threats` · `Warnings` · `Skipped`
(Jargon-lite: "Skipped" is opaque to a merchant — it means info-only/non-scored checks.)

### 2.9 — Review request banner
[app._index.tsx:1255–1301](app/routes/app._index.tsx:1255). Shown after a scan until dismissed.
- Body: `If ShieldKit helped, a quick review helps other merchants discover us.`
- Buttons: `Leave a Review` · `Dismiss`

### 2.10 — Inline upgrade banner (free only)
[app._index.tsx:1307–1317](app/routes/app._index.tsx:1307). `tier === "free"` and at least one check exists.
- Body: `Upgrade for unlimited on-demand scans and AI-written policies — fix issues before Google flags them.`
- Button: `See plans`

### 2.11 — AuditChecklist  ·  `app/components/AuditChecklist.tsx`
Dashboard only. Length: long (the 12-point list). Self-hides if `sortedChecks.length === 0`.
- Header (interpolated): `12-Point GMC Compliance Audit — {passed} / {total} passed` — ⚠️JARGON: "GMC"
- Toggle button: `Expand All` / `Collapse All`
- Per-check row: title (from the check's `title`), a severity badge, and an expandable Resolution Guide.
- Badge text (`checkBadgeText`, `scan-helpers.ts`): `Skipped` / `Passed` / `Critical` / `Warning` / `Info` / `Error`
- Resolution guide label: `Resolution Guide`
- **Paid override for the 3 policy checks** (`PRO_POLICY_FIX`, [AuditChecklist.tsx:24](app/components/AuditChecklist.tsx:24)) — replaces the check's own `fix_instruction` for paid merchants on `refund_return_policy` / `shipping_policy` / `privacy_and_terms`:
  ```
  1. Use the Policy Generation tool in the sidebar to generate a compliant policy, then click Copy to Clipboard.
  2. In Shopify Admin → Settings → Policies, paste the generated policy into the appropriate field.
  3. Review the policy to ensure it reflects your actual business practices, then Save.
  4. Ensure the policy page is linked in your store footer.
  ```
  📍PATH: `Shopify Admin → Settings → Policies`
- Fallback when a check has no `fix_instruction`: `Detailed remediation copy coming soon — check back after your next scan.`

---

## PART 3 — THE 12 COMPLIANCE CHECKS

The dashboard renders each check's `title`, `description`, and `fix_instruction` from the DB (`violations` rows), populated at scan time by these modules. Below: the **fail/warning-state** copy (what an affected merchant reads) with `title` + `fix_instruction` verbatim, plus the pass-state title. `fix_instruction` strings are shown exactly as authored (with their `\n` step breaks). Jargon and admin paths flagged.

> Note: `fix_instruction` is rendered as plain text in a `<div>` with no `white-space: pre`, so the authored `\n` line breaks visually **collapse to spaces** in the Resolution Guide — the numbered steps run together on screen. Worth confirming this is intended (it reads as a wall of text).

---

### Check 1 — `contact_information`  ·  severity: **warning** (fail) / info (pass)
`app/lib/checks/contact-information.server.ts`
- PASS title: `Contact Information`
- FAIL title: `No Contact Method Detected`
- FAIL description: `No contact method (email, phone, physical address, contact page, or social profile) could be found on your storefront. Google Merchant Center and shoppers expect at least one visible way to reach you. (Note: contact details rendered only by JavaScript can be missed by an automated scan — if you already show one, you can disregard this.)`
- FAIL `fix_instruction`:
  ```
  Add at least one contact method — any one of these satisfies Google:
  1. Set a public support email in Shopify Admin → Settings → General → Store contact details, or add one to your footer/contact page.
  2. Add a Contact page (Shopify Admin → Online Store → Pages) — the 'Contact' page template includes a contact form, which Google accepts.
  3. Or link a social business profile (Instagram, Facebook, TikTok, etc.) in your footer. A phone number or physical address also qualifies.
  ```
  📍PATH: `Shopify Admin → Settings → General → Store contact details`; `Shopify Admin → Online Store → Pages`. Jargon: clean (already updated to the 1-of-N framing).

### Check 2 — `refund_return_policy`  ·  severity: **critical** (missing) / warning (incomplete) / info (pass or page-advisory)
`app/lib/checks/refund-return-policy.server.ts`
- PASS title: `Refund & Return Policy`
- MISSING title: `Missing Refund & Return Policy`
  - description: `No Refund/Return Policy was found in Settings → Policies or as a Shopify Page. Google Merchant Center requires a clearly visible and detailed return policy for all Shopping listings.`
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Settings → Policies, create a Refund Policy.
    2. Specify: the return window (e.g. '30 days'), the required item condition (e.g. 'unused, in original packaging'), and the refund method (e.g. 'full refund', 'store credit', or 'exchange').
    3. Save and ensure the policy page is linked in your store footer.
    ```
- INCOMPLETE title: `Incomplete Refund & Return Policy` (or `Incomplete Refund & Return Policy (found on Page)`)
  - `fix_instruction`:
    ```
    Update your Refund Policy (Shopify Admin → Settings → Policies) to:
    1. State the return window clearly (e.g. 'Returns accepted within 30 days of delivery').
    2. Specify required item condition (e.g. 'Items must be unused and in original packaging').
    3. Describe the refund method (e.g. 'Refunds issued to original payment method within 5 business days').
    4. Remove any placeholder text such as '[your company name]' or 'Lorem ipsum'.
    ```
- PAGE-ADVISORY title (info): `Policy detected on page, not in Settings → Policies`
  - `fix_instruction`: `In Shopify admin, go to Settings → Policies and paste your policy content there. Shopify will auto-link it in your store footer.`
  📍PATH: `Shopify Admin → Settings → Policies`. Jargon: clean. (For paid merchants the `PRO_POLICY_FIX` override replaces this — see 2.11.)

### Check 3 — `shipping_policy`  ·  severity: **critical** (missing) / warning (vague) / info (pass or page-advisory)
`app/lib/checks/shipping-policy.server.ts`
- PASS title: `Shipping Policy`
- MISSING title: `Missing Shipping Policy`
  - description: `No Shipping Policy was found in Settings → Policies or as a Shopify Page. Google Merchant Center requires a shipping policy that details delivery times and costs for all regions where products are sold.`
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Settings → Policies, create a Shipping Policy.
    2. Include: estimated delivery timeframes (e.g. '3–7 business days'), and shipping costs (e.g. 'Free shipping on orders over $50, otherwise $5.99 flat rate').
    3. If you ship internationally, add per-region information.
    4. Link the policy in your store footer.
    ```
- VAGUE title: `Vague Shipping Policy` (or `Vague Shipping Policy (found on Page)`)
  - `fix_instruction`:
    ```
    Update your Shipping Policy (Shopify Admin → Settings → Policies):
    1. Add a clear delivery timeframe per shipping method (e.g. 'Standard Shipping: 5–7 business days').
    2. State your shipping costs explicitly — even if free (e.g. 'Free standard shipping on all orders').
    3. For international shipping, list each region's estimated transit times.
    ```
- PAGE-ADVISORY title (info): `Policy detected on page, not in Settings → Policies` (same fix as Check 2 advisory).
  📍PATH: `Shopify Admin → Settings → Policies`. Jargon: clean.

### Check 4 — `privacy_and_terms`  ·  severity: **critical** (privacy missing) / warning (terms missing) / info (pass or page-advisory)
`app/lib/checks/privacy-and-terms.server.ts`
- PASS title: `Privacy Policy & Terms of Service`
- title (privacy missing): `Missing Privacy Policy` — or, if both missing: `Missing Privacy Policy and Terms of Service`
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Settings → Policies, create a Privacy Policy (Shopify provides a starting template you can adapt).
    2. Customise it to reflect your actual data practices (what data you collect, how it is used, third-party sharing).
    3. Ensure the policy is linked in your store footer.
    4. Also create a Terms of Service covering purchase terms, liability limitations, and governing law.   ← (4th line only present when both are missing)
    ```
- title (terms only missing, warning): `Missing Terms of Service`
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Settings → Policies, create a Terms of Service (Shopify provides a starting template you can adapt).
    2. Review and customise it — particularly sections covering payment terms, liability, and governing law.
    3. Link the Terms of Service in your store footer.
    ```
- PAGE-ADVISORY title (info): `Policy detected on page, not in Settings → Policies` (same fix as Check 2 advisory).
  📍PATH: `Shopify Admin → Settings → Policies`. Jargon-lite: "GDPR, CCPA, PIPEDA" appear in the description (legal acronyms; acceptable but worth plain-language framing).

### Check 5 — `product_data_quality`  ·  severity: **warning** (>20% flagged) / info (≤20% or pass)
`app/lib/checks/product-data-quality.server.ts`
- PASS title: `Product Data Quality`
- FAIL title: `Product Data Quality Issues`
  - description (interpolated): `{n} of {total} products ({pct}%) have data quality issues: {summary}.` where summary items read e.g. `3 with empty description`, `2 with description under 100 characters`, `1 with no product images`, `4 with zero or missing price`, `5 with all variants missing SKU`.
  - `fix_instruction`:
    ```
    For each flagged product in Shopify Admin → Products:
    1. Empty/short description: Write at least 100 characters describing the product's features, materials, dimensions, and use case.
    2. No images: Upload at least one high-quality product image (minimum 800×800px, white or clean background recommended by GMC).
    3. Zero/missing price: Set a valid selling price on each variant. Free products should be listed as $0.00 intentionally, but verify this.
    4. Missing SKU: Add a unique SKU to each variant. GMC uses SKUs as item identifiers — duplicates or blanks cause feed rejections.
    ```
  📍PATH: `Shopify Admin → Products`. ⚠️JARGON: "SKU" (probably fine for merchants), "GMC", "feed rejections", "item identifiers".

### Check 6 — `checkout_transparency`  ·  severity: **info** (never fails)
`app/lib/checks/checkout-transparency.server.ts`
- PASS titles (all info, never a failure): `Payment Methods Displayed` / `Payment Methods — Not Detected` / `Payment Methods — Not Verified`
- "Not Detected" description: `No payment method icons were detected in your storefront's initial HTML. This is a trust best-practice, not a Google Merchant Center requirement, and automated scans can miss icons that load via JavaScript — so no action may be needed.`
- "Not Detected" `fix_instruction`: `Payment icons usually appear automatically once a provider is active. Verify your providers under Shopify Admin → Settings → Payments. Most themes then render the icons from your active gateways (some themes also expose a payment-icons toggle in the theme editor).`
- "Not Verified" state (returned when the homepage can't be fetched, e.g. password-protected):
  - description: `The public storefront homepage could not be fetched, so accepted payment methods could not be checked. Displaying payment methods is a trust best-practice, not a Google Merchant Center requirement.`
  - `fix_instruction`: `Ensure your store is published and not password-protected, then re-run the scan.`
  📍PATH: `Shopify Admin → Settings → Payments` (✅ current/confirmed). Jargon-lite: "initial HTML", "gateways".

### Check 7 — `storefront_accessibility`  ·  severity: **critical** (password) / warning (non-200) / info (pass)
`app/lib/checks/storefront-accessibility.server.ts`
- PASS title: `Storefront Accessibility`
- PASSWORD title (critical): `Storefront is Password Protected`
  - description: `Your store is behind a password page and is not publicly accessible. Google Merchant Center cannot crawl or approve products from password-protected stores.`
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Online Store → Preferences, scroll to 'Password protection'.
    2. Uncheck 'Restrict access to visitors with the password' and save.
    3. Ensure your store is on an active paid Shopify plan — free trial stores are password-protected by default.
    ```
- NON-200 title (warning): `Product Pages Returning Non-200 Status` — ⚠️JARGON: "Non-200 Status", "HTTP 200" (in description)
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Products, verify the affected products are published to the Online Store sales channel.
    2. If a product handle has changed, update any feeds pointing to the old URL.
    3. Check that the product is not archived (Products → filter by 'Archived').
    ```
  📍PATH: `Shopify Admin → Online Store → Preferences`; `Shopify Admin → Products`.

### Check 8 — `structured_data_json_ld`  ·  severity: **warning** (present-but-malformed) / info (valid, absent, or not-verified)
`app/lib/checks/structured-data-json-ld.server.ts` — **heavy jargon zone**
- PASS title: `Structured Data (JSON-LD)` — ⚠️JARGON
- NOT-VERIFIED title (info, when no schema in static HTML): `Structured Data (JSON-LD) — Not Verified` — ⚠️JARGON
  - description: `No Product structured data was found in the initial HTML of the sampled product page(s). Many Shopify themes inject JSON-LD via JavaScript, which an automated fetch cannot see, so this is not necessarily a problem.` — ⚠️JARGON: "structured data", "JSON-LD", "initial HTML", "automated fetch"
  - `fix_instruction`: `Confirm your products emit Product structured data using Google's Rich Results Test: https://search.google.com/test/rich-results. If it passes there, no action is needed. If not, ensure your theme's product template outputs Product JSON-LD (name, image, description, and offers with price and priceCurrency).` — ⚠️JARGON: "emit Product structured data", "Product JSON-LD", "priceCurrency", "product template"
- MALFORMED title (warning): `Incomplete Product JSON-LD Schema` — ⚠️JARGON: "JSON-LD Schema"
  - description: `Product JSON-LD schema is present but missing required fields on {n} of {m} scanned product page(s). Missing: {fields}. Google uses these fields to show your products in Shopping results.` — ⚠️JARGON: "JSON-LD schema", "required fields", raw field names
  - `fix_instruction`:
    ```
    1. Shopify's default themes inject Product JSON-LD automatically. If a field is missing, check that your theme's product template still outputs complete structured data.
    2. Required fields: name, image, description, and offers with a price and priceCurrency (offers may be a single object, an array of per-variant offers, or an AggregateOffer with lowPrice/highPrice).
    3. Recommended additions: sku and itemCondition improve feed quality in GMC.
    4. Validate with Google's Rich Results Test: https://search.google.com/test/rich-results
    ```
  ⚠️JARGON (heaviest in the app): "Product JSON-LD", "structured data", "priceCurrency", "AggregateOffer", "lowPrice/highPrice", "itemCondition", "sku", "per-variant offers", "product template", "Rich Results Test". No Shopify admin path — points to Google's Rich Results Test and "your theme's product template."

### Check 9 — `page_speed`  ·  severity: **warning** (measured) / info + non-scorable (not measured)
`app/lib/checks/page-speed.server.ts`
- PASS title: `Page Speed`
- NOT-MEASURED title (info, non-scorable): `Page Speed — Not Measured`
  - description pattern: `Couldn't measure page speed right now — {reason}. This doesn't affect your compliance status.` (reasons: rate-limited HTTP 429 / temporarily unavailable / didn't return a score / didn't respond in time)
  - `fix_instruction`: `No action needed on your end. Page speed is measured by Google's PageSpeed Insights service — re-run your scan later for a fresh reading, or check it any time at https://pagespeed.web.dev.`
- FAIL title (warning): `Page Speed Issues Detected`
  - description: `PageSpeed Insights flagged the following on mobile: {issues}.` (e.g. `mobile performance score is 34/100 (threshold: 50)`; `intrusive interstitials detected (...)`)
  - `fix_instruction`:
    ```
    1. Run a full audit at https://pagespeed.web.dev for detailed recommendations.
    2. Common mobile improvements: compress images (WebP format), enable lazy loading, minify CSS/JS, and reduce third-party scripts.
    3. For intrusive interstitials: remove or delay full-screen pop-ups that appear immediately on page load — Google penalises these in Shopping rankings.
    4. In Shopify Admin → Apps, disable non-essential apps that inject scripts at load time (chat widgets, loyalty pop-ups, etc.).
    ```
  📍PATH: `Shopify Admin → Apps`. ⚠️JARGON: "intrusive interstitials", "WebP", "lazy loading", "minify CSS/JS", "third-party scripts".

### Check 10 — `business_identity_consistency`  ·  severity: **info** (mismatch) / warning (pass) / info (skipped)
`app/lib/checks/business-identity-consistency.server.ts`
- PASS title: `Business Identity Consistency`
- SKIPPED title: `Business Identity Consistency — Skipped`
- FAIL title (info): `Potential Business Identity Mismatch`
  - description: `The store name "{name}" has a low word-overlap score with the primary domain "{host}" (consistency: {n}%). This may indicate a branding inconsistency that could prompt GMC manual review.` — ⚠️JARGON: "word-overlap score", "consistency %"
  - `fix_instruction`:
    ```
    1. Ensure your Shopify store name (Settings → General) matches the brand name used on your domain, About page, and social profiles.
    2. If you have recently rebranded, update your primary domain in Shopify to match.
    3. Note: this check uses word overlap and may produce false positives for stores with stylised or abbreviated brand names — manual review is advised.
    ```
  📍PATH: `Settings → General`. Jargon-lite.

### Check 11 — `hidden_fee_detection`  ·  severity: **critical** (undisclosed) / info (pass)
`app/lib/checks/hidden-fee-detection.server.ts`
- PASS title: `Hidden Fee Detection`
- FAIL title (critical): `Undisclosed Fees Detected`
  - description: `Found {n} undisclosed fee term(s) charged on your storefront ({terms}) that are not mentioned in your shipping or refund policy. Google Merchant Center treats undisclosed fees as misrepresentation.`
  - `fix_instruction`:
    ```
    1. In Shopify Admin → Settings → Policies, edit your Shipping Policy (and/or Refund Policy) to clearly explain every fee charged at checkout: {terms}.
    2. State who pays the fee, when, and the typical amount or formula.
    3. After saving, re-run the scan to confirm.
    ```
  📍PATH: `Shopify Admin → Settings → Policies`. Jargon: clean. (Title "Hidden Fee Detection" on the PASS state is oddly clinical for a "you're fine" result.)

### Check 12 — `image_hosting_audit`  ·  severity: **warning** (flagged) / info (pass)
`app/lib/checks/image-hosting-audit.server.ts`
- PASS title: `Product Image Hosting`
- FAIL title (warning): `Product Images Hosted on External CDNs` — ⚠️JARGON: "CDNs"
  - description: `{n} of {m} sampled product(s) embed images loaded from external supplier/marketplace CDNs ({hosts}). Google evaluates your feed's main product image (image_link) against its image requirements, and supplier-hosted images are more likely to include promotional overlays or watermarks, be low-resolution, or be generic — any of which can get a listing's image disapproved. Worth reviewing: {productList}.` — ⚠️JARGON: "external supplier/marketplace CDNs", "image_link", raw CDN hostnames (e.g. `ae01.alicdn.com`, `cdn.cjdropshipping.com`)
  - `fix_instruction`:
    ```
    1. Check that each product's main image meets Google's image requirements: a clear, unobstructed product photo with no promotional text, watermarks, or added borders; at least 100x100px (250x250px for apparel); not a placeholder or generic stock image.
    2. Host product images on Shopify's CDN (upload them to the product's media gallery in Shopify Admin → Products) so the feed image_link is stable and crawlable.
    3. Replace or remove any supplier-hosted images embedded in the product description.
    4. After updating, re-run the scan to confirm.
    ```
  📍PATH: `Shopify Admin → Products`. ⚠️JARGON: "Shopify's CDN", "feed image_link", "crawlable".

---

## PART 4 — GATING SPECIFICS (for the rewrite)

### 4.1 — Aside cards: paid vs free vs all

| Card | Shown to | Exact gate | Self-hides when empty? |
|---|---|---|---|
| PlanStatusCard (paid coverage) | **Paid** | `merchant && !showOnboarding` → `if (isPaid)` renders `PaidCoverageCard` | No (always shown if scanned) |
| PlanStatusCard (free upgrade) | **Free** | same gate → `else` renders `FreeUpgradeCard` | No |
| SecurityStatusAside | **All tiers** | no gate (always at [1345](app/routes/app._index.tsx:1345)) | No — shows empty-state text |
| PolicyGenerationCard | **Paid** | `merchant && isPaid && !showOnboarding` | **Yes** — `return null` when no failed policy checks |
| AIVisibilityCard | **Paid** | `merchant && isPaid && aiVisibility && !showOnboarding` (loader only builds `aiVisibility` when `hasPaidAccess`) | **No** — renders "not been crawled yet" empty state |
| Free JSON-LD card | **All tiers** | no gate; branches on `json_ld_enabled` | No |
| Beacon card | **All tiers** | no gate | No |
| About card | **All tiers** | no gate | No |

### 4.2 — AI-visibility / llms.txt card (TASK 4 confirmation)
- **Paid-gated:** yes. Rendered only when `merchant && isPaid && aiVisibility && !showOnboarding` ([app._index.tsx:1369](app/routes/app._index.tsx:1369)); the loader only populates `aiVisibility` inside `if (hasPaidAccess(merchant.tier))` ([app._index.tsx:245](app/routes/app._index.tsx:245)). Free merchants never see it.
- **Empty state exists:** yes. Condition `isEmpty = thisWeekHits === 0 && priorWeekHits === 0` ([AIVisibilityCard.tsx:26](app/components/AIVisibilityCard.tsx:26)). Copy verbatim:
  `Your llms.txt has not been crawled yet. AI engines typically discover new content within 7-30 days of publishing.`
  It does **not** hide when empty — it shows this "not crawled yet" message instead.

### 4.3 — JSON-LD card is the sole control (TASK 4 confirmation)
- **Sole control:** yes. The inline Free JSON-LD card is the only place a merchant can enable/manage JSON-LD. `PlanStatusCard`'s JSON-LD row is **display-only** (renders `state="off"` dot or `state="checked"`, no action handler — [PlanStatusCard.tsx:79–89](app/components/PlanStatusCard.tsx:79)). Confirmed by the source comment at [app._index.tsx:1379–1387](app/routes/app._index.tsx:1379).
- **ON state:** heading `Free JSON-LD Structured Data`; status `JSON-LD Active`; body `Product structured data is being added to your product pages.`; button `Manage`.
- **OFF state:** heading `Free JSON-LD Structured Data`; body `Opens your theme editor — add the Product Schema block and click Save.`; button `Enable JSON-LD`.

### 4.4 — NavMenu chrome (adjacent surface, `app/routes/app.tsx`)
Not part of the aside/main column, but rendered around the dashboard and jargon-relevant. Labels:
`Dashboard` · `Appeal letter` (paid) · `Store schema settings` (paid) · `GTIN auto-filler` (paid + `write_products` scope) · `AI bot access` (paid) · `Manage plan`
⚠️JARGON: "GTIN auto-filler" (GTIN), "Store schema settings" (schema), "AI bot access" (borderline).

---

## PART 5 — SUMMARY

### Worst jargon offenders (ranked; JSON-LD card first, as requested)
1. **Free JSON-LD Structured Data card** (§1.5) — heading, both state labels (`JSON-LD Active`), body (`Product structured data is being added…`), and button (`Enable JSON-LD`) are entirely built on unexplained technical terms. Never states the merchant outcome (richer/eligible Google Shopping listings). **Highest priority.**
2. **Check 8 `structured_data_json_ld`** (§Part 3) — the single densest jargon in the app: "Product JSON-LD", "structured data", "priceCurrency", "AggregateOffer", "lowPrice/highPrice", "itemCondition", "sku", "per-variant offers", "Rich Results Test". Titles themselves contain "JSON-LD".
3. **`PAID_FEATURES` list** (§1.1, rendered in PlanStatusCard both states) — `Auto structured data for new products`, `llms.txt for AI search`, `AI crawler allow/block controls`, `Store schema settings…`, `JSON-LD product schema extension`, `Product data fixes (GTIN / MPN / brand)`. Six of nine paid-feature rows lead with a mechanism term, not an outcome.
4. **AIVisibilityCard** (§1.4) — `llms.txt`, `crawler hit(s)`, `WoW`, and raw crawler bot names in "Top: …".
5. **Check 12 `image_hosting_audit`** (§Part 3) — "External CDNs", "image_link", raw CDN hostnames.
6. **Check 9 `page_speed`** — "intrusive interstitials", "WebP", "minify CSS/JS", "lazy loading".
7. **NavMenu** (§4.4) — "GTIN auto-filler", "Store schema settings".
8. Scattered lighter offenders: onboarding + audit header + ScoreBanner "GMC" abbreviation; ScoreBanner clean-line "structured data"; KpiCards "Skipped"; SecurityStatusAside "Threat Level / critical threats"; Check 7 "Non-200 Status"; Check 4 "GDPR/CCPA/PIPEDA"; Check 10 "word-overlap score".

### Cards / strings that are candidates to shorten or hide-when-empty
- **PlanStatusCard (paid coverage)** — a 9-row always-on checklist with no CTA; candidate to shorten. (Already hidden on first-time/unscanned via `!showOnboarding`.)
- **AIVisibilityCard** — currently renders a "not been crawled yet" empty state indefinitely for paid merchants with zero data; candidate to **hide-when-empty** (or fold into a single AI-visibility surface) rather than persistently show an empty technical message.
- **About ShieldKit card** — always-on, low-value once a merchant is active; candidate to shorten or drop on the dashboard.
- **Beacon card** — always-on for all tiers, non-dismissable; candidate for dismissable / shorten (content is already reasonable).
- **Free JSON-LD card + PlanStatusCard JSON-LD row** — two surfaces referencing the same feature (one interactive, one display-only). Not a bug, but a rewrite should make sure the two don't read as contradictory.
- **`fix_instruction` rendering** — the authored `\n` steps collapse to a single run-on line in the AuditChecklist Resolution Guide (no `white-space: pre`). Worth confirming whether the numbered-step formatting is meant to be visible; if so, it's currently lost on screen.

### Non-copy factual flags surfaced during the audit
- **Annual price:** the FreeUpgradeCard CTA renders **`$390/yr`** (`PLANS.monitoring_annual.annual = 390`), while CLAUDE.md and this brief say **$449**. Reconcile before the rewrite re-states the price.
- **Duplicate quota-reached string:** the "You've used your free scan…" 402 message is authored twice in `app._index.tsx` (RPC-error fallback + normal path) — keep them in sync when rewritten.

---

_End of audit. No code, copy, config, or DB was modified. Working tree left clean._
