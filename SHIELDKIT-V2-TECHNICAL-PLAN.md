# ShieldKit v2 — Technical Implementation Plan

**For Claude Code execution. Reference `CLAUDE.md` as canonical technical doc for the live codebase. This file is the v2 delta.**

**Working directory:** `/Users/am/Documents/Claude/Projects/Shieldkit`
**Supabase project:** `bhnpcirhutczdorkhibm` (single project, do not create another)
**Production Shopify app credentials:** unchanged. Do NOT rotate `TOKEN_ENCRYPTION_KEY`. Sessions table preserved.

---

## Phase 0 — Prep (30 minutes)

```bash
cd /Users/am/Documents/Claude/Projects/Shieldkit
git status                          # confirm clean
git tag v1-final                    # rollback marker
git push origin v1-final
git checkout -b v2-rebuild
```

Confirm before proceeding:
- Supabase has a recent backup (Settings → Database → Backups). If not, create one manually.
- Separate dev Shopify app credentials are configured in `.env.development` (not production credentials).
- `RESEND_API_KEY` is set (free tier 3K emails/mo is enough until MRR > $200).

Install any new deps:
```bash
npm install resend
# all other deps already in package.json per CLAUDE.md
```

---

## Phase 1 — Database migrations (1 hour)

**Run against a Supabase branch first, validate, then promote to main.**

Create migration file `supabase/migrations/2026XXXXXX_v2_recurring_billing.sql`:

```sql
-- 1. Migrate merchants table to recurring tiers
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_tier_check;
ALTER TABLE merchants
  ADD CONSTRAINT merchants_tier_check
  CHECK (tier IN ('free', 'shield', 'pro', 'pro_legacy'));

-- 2. Monthly scan reset + billing fields
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS scans_reset_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT CHECK (billing_cycle IN ('monthly','annual')),
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shopify_subscription_id TEXT;

-- 3. Digest email tracking
CREATE TABLE IF NOT EXISTS digest_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ DEFAULT now(),
  scan_id UUID REFERENCES scans(id),
  new_issues_count INTEGER,
  fixes_confirmed_count INTEGER,
  email_provider_id TEXT
);
CREATE INDEX idx_digest_merchant_time ON digest_emails(merchant_id, sent_at DESC);

-- 4. Appeal letters
CREATE TABLE IF NOT EXISTS appeal_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id),
  suspension_reason TEXT,
  generated_letter TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Schema enrichment tracking (Pro)
CREATE TABLE IF NOT EXISTS schema_enrichments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  enriched_fields TEXT[],
  metafield_values JSONB,
  enriched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(merchant_id, product_id)
);
CREATE INDEX idx_schema_enrich_merchant ON schema_enrichments(merchant_id, enriched_at DESC);

-- 6. Grandfather the 2 paying customers (verify domains in production before running)
-- Run this AFTER deploying the code that recognizes 'pro_legacy'
-- UPDATE merchants
--   SET tier = 'pro_legacy', scans_remaining = NULL
--   WHERE shopify_domain IN ('normae-domain.myshopify.com', 'glamourous-grace-domain.myshopify.com');

-- 7. Migrate 11 free-tier merchants to fresh monthly quota
-- UPDATE merchants
--   SET scans_remaining = 1, scans_reset_at = now()
--   WHERE tier = 'free';
```

Lines 6 and 7 are commented — run them via Supabase SQL editor manually after code deploy, with the actual production domains. Get the 2 paying customer domains via:
```sql
SELECT shopify_domain FROM merchants WHERE tier = 'pro' OR id IN (SELECT merchant_id FROM payments WHERE status = 'paid');
```

---

## Phase 2 — Pricing & grandfathering (2–3 hours)

### 2.1 Update plan definitions

`app/lib/billing/plans.ts` (create if doesn't exist):
```typescript
export const PLANS = {
  free: { name: 'Free', monthly: 0, annual: 0 },
  shield_monthly: { name: 'Shield Pro', monthly: 14, interval: 'EVERY_30_DAYS' },
  shield_annual: { name: 'Shield Pro Annual', annual: 140, interval: 'ANNUAL' },
  pro_monthly: { name: 'Shield Max', monthly: 39, interval: 'EVERY_30_DAYS' },
  pro_annual: { name: 'Shield Max Annual', annual: 390, interval: 'ANNUAL' },
} as const;
```

### 2.2 Modify upgrade route

`app/routes/app.upgrade.tsx` — show 4 plan options (Shield Pro monthly, Shield Pro annual, Shield Max monthly, Shield Max annual). The pro_legacy tier was removed — paying v1 customers received the v1 product they paid for and now flow through the free tier like everyone else.

### 2.3 Modify billing confirm

`app/routes/app.billing.confirm.tsx` — handle subscription approval callback. Set `tier`, `billing_cycle`, `subscription_started_at`, `shopify_subscription_id` on merchant record. Set `scans_remaining = NULL` for paid tiers.

### 2.4 Build plan switcher (Shopify reviewer requirement — mandatory)

`app/routes/app.plan-switcher.tsx`:
- Shows current plan with badge.
- Shows all plans side-by-side with feature list.
- "Switch plan" button → `appSubscriptionCancel` then `appSubscriptionCreate` with new plan. Shopify handles proration.
- "Cancel subscription" → `appSubscriptionCancel`, return merchant to free tier (`tier = 'free'`, `scans_remaining = 1`, `scans_reset_at = now()`).
- This page must be accessible from the main nav, not buried.

### 2.5 Test mode

Every `appSubscriptionCreate` call uses `isTest: process.env.NODE_ENV !== 'production'`.

---

## Phase 3 — Shield Pro features (1.5 days)

### 3.1 Free tier monthly reset cron

`app/routes/api.cron.monthly-reset.ts` (Vercel Cron, runs 1st of month 00:00 UTC):
```typescript
// Reset free-tier merchants to 1 scan if their reset window has elapsed
await supabase.from('merchants')
  .update({ scans_remaining: 1, scans_reset_at: new Date().toISOString() })
  .eq('tier', 'free')
  .lt('scans_reset_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
```

Add to `vercel.json` crons:
```json
{ "path": "/api/cron/monthly-reset", "schedule": "0 0 1 * *" }
```

### 3.2 Continuous Monitor (modify existing weekly scan cron)

`app/routes/api.cron.weekly-scan.ts` — modify to:
1. Run existing 10-point scan
2. Diff against previous scan in `scans` table for same merchant
3. Compute `new_issues` (failed this scan, passed last scan) and `fixes_confirmed` (passed this scan, failed last scan)
4. Add 2 cheap checks:
   - **Payment icon health**: re-run existing Check #6 logic (`checkout_transparency`) on the homepage HTML. Already executing — just persist the result separately.
   - **Customer Privacy API status**: single GraphQL read against `currentAppInstallation { app { customerPrivacy } }` or equivalent. Flag if not wired.
5. Trigger digest email (Phase 3.3) for paid tiers.

**Cut**: synthetic EU-IP cookie probe. Not building this — Cloudflare cold-start latency creates false negatives.

### 3.3 Weekly Health Digest Email

`app/routes/api.cron.weekly-digest.ts` (Vercel Cron, Monday 13:00 UTC):
```typescript
// For each Shield Pro / Shield Max merchant, send digest email via Resend
// Email content:
// - Score this week vs last week
// - New issues caught (with fix links)
// - Fixes confirmed
// - Payment icon status
// - Customer Privacy API status
// - For Shield Max merchants: append "Shield Max This Week" section
//   - Products auto-enriched this week (count from schema_enrichments)
//   - Schema status (count of products with full Merchant Listings schema)
//   - llms.txt last refresh
//   - AI Readiness Score (computed)
```

`vercel.json`:
```json
{ "path": "/api/cron/weekly-digest", "schedule": "0 13 * * 1" }
```

Email template lives in `app/lib/emails/weekly-digest.tsx` (React Email or plain HTML — your call, plain HTML is faster).

### 3.4 GMC Re-Review Appeal Letter Generator

`app/routes/app.appeal-letter.tsx`:
- Form: textarea for "what Google said your suspension reason was"
- Textarea for "list the fixes you've made"
- Button → calls `app/lib/llm/appeal-letter.server.ts`
- That server function calls Claude Sonnet with a system prompt that produces a polished GMC re-review request letter
- Returns the letter as text + saves to `appeal_letters` table

Cost ceiling: $0.50 per generation. Cap merchants at 3 generations per scan.

### 3.5 Hidden Fee Detector

New check `app/lib/checks/hidden_fee_detection.ts`:
- Crawl product pages (sample of 5–10), cart page, shipping policy
- Regex match for: `handling fee`, `restocking fee`, `processing fee`, `convenience fee`, `service charge`
- Flag if matched on product/cart pages but absent from shipping policy
- Add to scan engine output as Check #11

### 3.6 Image Hosting Audit

New check `app/lib/checks/image_hosting_audit.ts`:
- For each product, scan `description_html` for image src URLs
- Flag URLs matching: `cdn.cjdropshipping.com`, `ae01.alicdn.com`, `ae04.alicdn.com`, `s.cdpn.io`, `usercontent.alibaba.com`, `oss.aliexpress.com`
- Severity: high (direct misrepresentation trigger)
- Add to scan engine output as Check #12

---

## Phase 4 — Pro features, no-scope (4 hours)

These ship without scope re-review. Build and deploy first.

### 4.1 Organization & WebSite Schema

Extend existing JSON-LD theme extension at `extensions/json-ld-schema/`:
- Add Organization schema block injected once per page (sameAs, logo, contactPoint pulled from merchant config in app)
- Add WebSite schema block with SearchAction for site-wide search
- Pull merchant-supplied data (social URLs, support email) from a new settings page `app/routes/app.pro-settings.tsx`
- Only render when merchant tier is `pro` or `pro_legacy`

### 4.2 llms.txt at root via App Proxy

Configure App Proxy in Shopify Partner Dashboard:
- Subpath: `apps`, Subpath prefix: `llms` → maps to `/llms.txt` at root
- Actually: configure proxy so `<store>/llms.txt` proxies to your app's `/api/proxy/llms-txt` endpoint
- This requires HMAC verification per Shopify App Proxy docs

`app/routes/api.proxy.llms-txt.ts`:
- Verify HMAC signature
- Generate llms.txt from merchant's products, policies, About page content
- Cache for 24 hours per merchant in Supabase or Cloudflare KV
- Return `text/plain` with appropriate sections (Products, Policies, About, Contact)

### 4.3 AI Bot Allow/Block Toggle

`app/routes/app.bots.toggle.tsx`:
- UI showing list of common AI bots (GPTBot, ChatGPT-User, ClaudeBot, anthropic-ai, Google-Extended, PerplexityBot, ByteSpider, etc.)
- Toggle each allow/block
- Generates a `robots.txt` snippet
- "Copy snippet" button — merchant pastes into `robots.txt.liquid` in their theme
- No write scope needed.

---

## Phase 5 — Pro features, requires `write_metafields` scope (4 hours after scope approval)

**Submit scope re-review BEFORE starting Phase 5 dev work.** Update `shopify.app.toml`:
```toml
[access_scopes]
scopes = "read_products,read_content,read_legal_policies,read_themes,read_shipping,read_locations,write_metafields"
```

Wait 5–10 business days for approval. During that time, ship Phases 1–4 to production.

### 5.1 Merchant Listings JSON-LD Enricher

`app/lib/schema/merchant-listings-enricher.server.ts`:
- For each product, build full Product schema with:
  - `gtin`, `mpn`, `brand` (from metafields if Auto-Filler ran, else from product fields)
  - `MerchantReturnPolicy` (from merchant's refund policy)
  - `OfferShippingDetails` (from shipping zones)
  - `aggregateRating` if reviews app installed and merchant opts in
- Inject via existing JSON-LD theme extension when product page renders
- Only active for `pro` / `pro_legacy` tier

### 5.2 GTIN/MPN/Brand Auto-Filler

`app/routes/app.gtin-fill.tsx`:
- Scan all products, identify those missing `gtin` / `mpn` / `brand`
- Show count: "47 products missing GTIN/MPN/brand"
- Bulk action UI: "Auto-fill via metafields"
- For each product, write to:
  - `custom.gtin` (or use Shopify standard `gtin` metafield definition)
  - `custom.mpn`
  - `custom.brand`
- The Enricher (5.1) reads these metafields when generating schema
- For merchants who legitimately don't have identifiers (handmade, vintage), provide opt-out: writes `custom.identifier_exists = false`, schema sets `identifier_exists: false`
- Insert row in `schema_enrichments` table per product
- **UI caveat copy**: "Identifiers added via schema satisfy the GMC 'Missing identifiers' warning for most categories. Some regulated categories (apparel size variants, grocery) may require identifiers in your Shopify product feed directly — for those, also add to product variant SKU/barcode field."

### 5.3 Pro digest section

Modify Phase 3.3 weekly digest email:
- For Pro/pro_legacy merchants, append "Pro This Week" block:
  - "X products enriched this week" (from `schema_enrichments` last 7 days)
  - "Schema status: Y products with full Merchant Listings schema"
  - "llms.txt last refreshed: [date]"
  - "AI Readiness Score: Z/100" (compute: % products with full schema + llms.txt freshness + bot configuration completeness)

---

## Phase 6 — Listing rewrite + submit (4 hours)

### 6.1 New listing copy

Lead with: "ShieldKit — the trust layer for Shopify stores. Stay compliant with Google. Be findable in AI search."

Pricing section:
- Free: 1 scan/month, fix instructions for top 3 findings
- Shield Pro $14/mo or $140/yr (16% off): unlimited scans, continuous monitoring, AI policy generator, GMC re-review appeal letter, hidden fee detector, image hosting audit, weekly digest email
- Shield Max $39/mo or $390/yr: everything in Shield Pro, plus: Merchant Listings JSON-LD Enricher, GTIN/MPN/Brand Auto-Filler, Organization & WebSite schema, llms.txt at root, AI bot allow/block toggle. Pitched as: "Your products show up correctly in Google AI Overviews and ChatGPT shopping results."

### 6.2 Screenshots (6 max, per Shopify listing requirements)

1. Hero scan dashboard with score + threat level
2. Continuous Monitor / Weekly Digest email mockup
3. GMC Appeal Letter Generator (panic-buyer hero)
4. Pro AI-Readiness section (schema + bot toggle + llms.txt status)
5. Auto-Filler before/after ("47 products fixed")
6. Plan switcher UI (reviewer requirement met visibly)

### 6.3 Submit

Partner Dashboard → app listing → submit changes. Listing review SLA 5–14 business days.

---

## Cutover sequence

1. **Phase 0–4 dev complete on `v2-rebuild`** (days 1–2)
2. **Submit scope re-review** for `write_metafields`
3. **Take Supabase backup**, confirm rollback path works
4. **Merge `v2-rebuild` → `main`**, Vercel auto-deploys
5. **Run grandfathering SQL** (Phase 1, lines 6–7) against production with actual domains
6. **Email the 13 merchants** (templates below)
7. **Phase 5 dev** while waiting for scope approval (days 3–4)
8. **Submit listing update** when Phase 5 deployed
9. **Wait listing review** (5–14 days). During this time, no merchant churn — existing v2 features running.
10. **New pricing live** when listing approves.

---

## Email templates

### To the 2 paying customers (NORMAE, Glamourous Grace)

> **Note:** the pro_legacy grandfather migration was abandoned in v2.7. v1
> customers received the v1 product they paid for and now flow through the
> regular free tier; the email below is kept for historical reference of the
> earlier plan and would need to be rewritten if grandfathering is revisited.

> Subject: ShieldKit just got monthly billing — your perpetual plan is locked in
>
> Hey [name],
>
> Quick update: ShieldKit moved from one-time pricing to monthly recurring (Shield Pro $14/mo, Shield Max $39/mo). You bought before the change, so I've upgraded your account to a perpetual Shield Max plan — full access to every paid feature, no recurring charge, ever.
>
> What's new you now have free for life: continuous weekly monitoring, weekly health digest email, GMC appeal letter generator, hidden fee detector, dropshipper image audit, full Merchant Listings JSON-LD schema, GTIN/MPN/brand auto-filler, Organization schema, llms.txt at root, AI bot allow/block toggle.
>
> As a thank-you, I'd like to give you 12 months free Shield Max on a second store — let me know which domain to apply it to.
>
> [your name]

### Separate email, sent 5+ days later, to same 2 customers

> Subject: A favor
>
> Hey [name],
>
> If ShieldKit has been useful, an honest review on the App Store would help me a lot — apps.shopify.com/shieldkit. Whatever you'd write, even brief, helps the listing rank.
>
> No pressure either way.
>
> [your name]

### To the 11 free-tier merchants

> Subject: ShieldKit update — fresh scan every month, plus 4 new features
>
> Hey there,
>
> Thanks for trying ShieldKit. Quick update on what's new:
>
> 1. Free tier now resets monthly. You get a fresh scan every 30 days instead of just once.
> 2. New Shield Pro plan ($14/mo): continuous weekly monitoring, weekly health digest, GMC re-review appeal letter generator.
> 3. New Shield Max ($39/mo): everything in Shield Pro, plus your products show up correctly in Google AI Overviews and ChatGPT shopping results via full schema enrichment.
>
> Want a 5-minute walkthrough? Reply to this email.
>
> [your name]

---

## Per-feature test checklist

For each feature, verify on the dev store before merge:

### Pricing migration
- [ ] Free merchant can install
- [ ] Free → Shield Pro monthly upgrade flow completes (test mode)
- [ ] Free → Shield Pro Annual upgrade flow completes
- [ ] Free → Shield Max monthly upgrade flow completes
- [ ] Shield Pro → Shield Max upgrade prorates correctly
- [ ] Shield Max → Shield Pro downgrade prorates correctly
- [ ] Annual ↔ monthly switch
- [ ] Cancel subscription → returns to free tier with `scans_remaining = 1`
- [ ] App uninstall webhook clears subscription state

### Continuous Monitor + Weekly Digest
- [ ] Cron triggers on schedule
- [ ] Diff correctly identifies new issues
- [ ] Diff correctly identifies fixes
- [ ] Digest email sends via Resend
- [ ] `digest_emails` row inserted with provider ID
- [ ] Email renders correctly in Gmail, Outlook, Apple Mail
- [ ] Shield Max section appears only for Shield Max merchants
- [ ] Quiet week ("0 issues, 200+ checks run") still sends digest

### GMC Appeal Letter Generator
- [ ] Form validates input
- [ ] Letter generates within 30s
- [ ] LLM cost stays under $0.50
- [ ] Letter saved to `appeal_letters` table
- [ ] 3-generation cap enforced per scan

### Hidden Fee Detector + Image Hosting Audit
- [ ] Both checks run on free-tier scan
- [ ] Detected on test products with planted fees / planted dropshipper URLs
- [ ] Pass when clean

### Pro features (post-scope approval)
- [ ] JSON-LD Enricher injects valid schema (validate via Google Rich Results Test)
- [ ] Schema includes gtin/mpn/brand from metafields
- [ ] Auto-Filler writes to correct metafield namespace/key
- [ ] Auto-Filler opt-out (`identifier_exists: false`) works for handmade
- [ ] Organization + WebSite schema renders site-wide
- [ ] llms.txt resolves at `<store>/llms.txt` (not under /apps/)
- [ ] llms.txt content is sane (not empty, not malformed)
- [ ] HMAC verification on App Proxy endpoint blocks unsigned requests
- [ ] Bot toggle generates copy-pasteable robots.txt snippet

### Plan switcher (mandatory for review)
- [ ] Page accessible from main nav
- [ ] Current plan visibly indicated
- [ ] Every plan transition tested above
- [ ] Cancel button works without contacting support
- [ ] Page renders on mobile

---

## Rollback plan

If anything breaks in production:

1. **Code**: Vercel dashboard → Deployments → previous deploy → "Promote to Production". <60s rollback.
2. **Database**: Supabase → Database → Backups → restore most recent pre-migration backup. ~5 min.
3. **Subscriptions**: Shopify subscriptions can't be un-charged, but `appSubscriptionCancel` on each new subscription returns merchants to prior state. Run via a one-off script if multiple new subs need reverting.
4. **App listing**: revert in Partner Dashboard, resubmit. 5–14 day re-review applies.

---

## What's explicitly NOT in v2 (for Claude Code awareness)

These were considered and cut. Do not build:
- Theme Regression Detector (high test burden, rare trigger)
- Shipping Policy ↔ GMC Sync Checker (deferred to v2.1; scope re-review delays cutover)
- Compliance Score Trend Dashboard (low recurring value)
- Google Ads Compliance Snapshot (adjacent product confusion)
- Geolocation/Currency App Conflict Detector (niche)
- Basic AI Bot Crawl Log (belongs in Beacon)
- Bing IndexNow auto-submit (small market, defer to Beacon)
- Agentic Storefronts Readiness Checker (theoretical pain)
- `write_products` scope ask (rebuilt as metafield-only Auto-Filler)
- Synthetic EU-IP cookie banner probe (Cloudflare cold-start fragility)

If these come up during build, defer and ask before adding scope.

---

## Reference

- Live codebase canonical doc: `CLAUDE.md` in this repo
- Sister business plan: ShieldKit v2 plan (the document this technical plan is implementing)
- Beacon app: separate codebase, separate Shopify app, same Supabase project under `beacon` schema. Do not modify Beacon while building ShieldKit v2.
