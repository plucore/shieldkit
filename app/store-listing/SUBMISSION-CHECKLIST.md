# ShieldKit v2 — App Store Submission Checklist

> Walk this top-to-bottom before clicking Submit in Partner Dashboard.
> Last updated: 2026-05-05

---

## Before clicking Submit in Partner Dashboard

- [ ] All 6 screenshots captured at 1600×900, saved to `app/store-listing/screenshots/` (filenames: `01-hero.png` … `06-plan-switcher.png`)
- [ ] Listing copy from `v2-listing-copy.md` pasted into Partner Dashboard (App listing → Marketing)
- [ ] Tagline picked (one of the three options) and pasted
- [ ] Pricing tiers updated to Free / Shield Pro ($14 mo / $140 yr) / Shield Max ($39 mo / $390 yr)
- [ ] In-app plan switcher accessible from main nav (verified at `/app/plan-switcher`)
- [ ] Refund / cancellation flow accessible without contacting support (verified — Shopify-managed via plan switcher)
- [ ] Privacy policy URL valid and live: https://shieldkit.app/privacy
- [ ] Terms URL valid and live: https://shieldkit.app/terms
- [ ] Support email working: hello@shieldkit.app (test inbound + outbound)
- [ ] App icon current (TBD — confirm with founder before paste)
- [ ] All 12 compliance checks running clean on dev store
- [ ] `write_products` scope review approved (Partner Dashboard → ShieldKit → Versions → check status of latest version)
- [ ] App Proxy registered for `/apps/llms-txt`
- [ ] Theme blocks registered (Product JSON-LD, Organization JSON-LD, WebSite JSON-LD)
- [ ] Vercel `SCOPES` env var updated to include `write_products` (Production + Preview + Development)
- [ ] At least one paid test subscription completed end-to-end on a development store

---

## Screenshot capture instructions

Required: **6 screenshots at 1600×900 PNG**, saved to `app/store-listing/screenshots/` with the filename pattern below. Brand styling: light blue gradient background, navy text, white cards (match the visual style of the existing four listing screenshots).

### `01-hero.png` — Compliance Command Center dashboard

- **Setup:** dev store with a completed scan. URL: `/app`
- **Capture:** compliance score (large %), threat-level indicator, the 4 KPI tiles (Checks Passed / Critical Threats / Warnings / Skipped), and the 12-Point GMC Compliance Audit list with a mix of pass and fail states visible.
- **Crop:** embedded app frame only — not the full Shopify admin chrome.

### `02-monitoring.png` — Continuous monitoring + weekly digest (Shield Pro)

- **Setup:** split visual.
  - Left: rendered weekly digest email HTML (open the actual sent digest in a browser → screenshot the rendered email body).
  - Right: dashboard "New issues caught this week: 2 | Fixes confirmed: 3" card.
- **Caption overlay:** "Continuous weekly monitoring catches what changes."

### `03-appeal-letter.png` — GMC re-review appeal letter (Shield Pro)

- **Setup:** `/app/appeal-letter` mid-flow. Form filled with a sample suspension reason and the fixes made. Generated letter visible in the result panel.
- **Caption overlay:** "AI-drafted re-review letter when Google suspends you."

### `04-ai-schema.png` — AI-ready product schema (Shield Max)

- **Setup:** side-by-side composite.
  - Left: storefront product page view-source with the rich JSON-LD `<script>` highlighted (`gtin`, `mpn`, `brand` visible).
  - Right: a Google Shopping result with a rich snippet (or an AI Overview mock-up if no live result yet).
- **Caption overlay:** "Full Merchant Listings schema for Google Shopping and AI search."

### `05-auto-filler.png` — GTIN/MPN/brand auto-filler (Shield Max)

- **Setup:** `/app/gtin-fill` before/after split.
  - Left: "47 products missing GTIN/MPN/brand" with the table of products and the Auto-fill button highlighted.
  - Right: "47 products fixed via metafields" success state (the green success banner the action returns).
- **Caption overlay:** "Bulk-fix missing identifiers without re-uploading products."

### `06-plan-switcher.png` — Plan switcher (mandatory for Shopify reviewer)

- **Setup:** `/app/plan-switcher`. Current plan badge visible. 2-card layout (Shield Pro + Shield Max) with the monthly / annual toggle. Switch button on the alternate plan. Cancel button visible at the bottom of the page.
- **Caption overlay:** "Switch plans or cancel anytime, no support needed."

---

## After clicking Submit

- Shopify reviews **5–14 business days**.
- During review, the existing v1 listing stays live.
- On approval, the v2 listing replaces v1 immediately.
- The 13 existing merchants will see the new pricing **only if they visit the listing**; their existing installs and active charges are unchanged.
- Do **not** release the new app config version (the one with `write_products` scopes) on the Shopify side until BOTH the listing review approves AND the captured screenshots reflect actual, working Phase 5 behavior on a real store.
