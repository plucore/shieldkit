# ShieldKit Scan Reliability Audit

**Scope:** False-positive risk across all 12 GMC-compliance checks.
**Date:** 2026-07-09 · **Mode:** read-only investigation (no code, migrations, or commits).
**Trigger:** a 2★ review — (1) `checkout_transparency` flagged "missing payment icons" on a store that visibly *has* them; (2) fix instructions referenced "stale" Shopify admin paths.

**Method:** full source read of every check module + orchestrator + helpers + constants; live reproduction with `scripts/outbound-scanner.ts` (byte-identical check logic) against 3 real Shopify stores; two coded reproductions against the *real* production modules (`hidden-fee-detection.server.ts`, `structured-data-json-ld.server.ts`); per-check GMC-suspension research + adversarial verification; and verification of every hardcoded admin path against current Shopify UI.

> **Bottom line:** The suspicion is correct and worse than the single complaint. **Every check that reads statically-fetched storefront HTML with regex/substring matching false-positives on real, compliant stores** — because `fetchPublicPage` is a plain `fetch()` that cannot see JS-rendered, lazy-loaded, or SVG-`<title>` content. Two of these carry **CRITICAL** severity and read as accusations (`hidden_fee_detection`, plus the Admin-sourced-but-regex `image_hosting_audit`). Separately, `structured_data_json_ld` has **two deterministic code bugs** (valid `offers` arrays / `AggregateOffer` reported as "missing price"). And several of the highest-severity checks penalize signals that **Google Merchant Center does not actually suspend or disapprove for** (payment icons, description image host, page speed) or enforce under a **standard Google abandoned in 2021** (2-of-3 contact methods).

---

## TASK 1 — Scan architecture map

### Fetch model (the root cause)
`fetchPublicPage(url, timeoutMs)` in [helpers.server.ts:86](app/lib/checks/helpers.server.ts:86):

- **Plain `fetch()` — no JavaScript execution, no headless browser.** It returns the raw server-rendered HTML only. Anything a Shopify theme renders client-side (React/Vue/Hydrogen footers, lazy-loaded payment bars, JS-injected JSON-LD, cookie-gated content) is **invisible**.
- **No byte / length cap.** `const html = await res.text()` reads the full body; there is no truncation, so footer content is not lost to a size limit. (The failure mode is *client rendering*, not truncation.)
- **SSRF-guarded**: DNS pre-check rejects private/loopback IPs; returns `null` (never throws) on failure/timeout. A `null` HTML is treated by downstream checks as "content absent."
- **Timeouts**: homepage 12s, product pages 10s, `/cart` 8s. UA `ShieldKit-Compliance-Scanner/1.0` (a non-browser UA some WAFs/Cloudflare challenge → bot-block false positives).
- **Single-shot, no retry** for storefront fetches (unlike the Admin GraphQL client, which retries 3×).

### What data each check consumes
The orchestrator ([index.server.ts:70](app/lib/checks/index.server.ts:70)) fetches Admin GraphQL data (`getShopInfo`, `getShopPolicies`, `getProducts(50)`, `getPages(20)`) and pre-fetches the homepage + up to 3 product-page HTMLs, then runs 12 checks via `safeCheck()` (exceptions → severity `error`, excluded from the score denominator).

| Data source | Reliability | Checks |
|---|---|---|
| **Admin GraphQL** (server-authoritative) | High | contact_information, refund_return_policy, shipping_policy, privacy_and_terms, product_data_quality, business_identity_consistency, image_hosting_audit |
| **Static HTML fetch** (plain `fetch`, no JS) | **Low** | checkout_transparency, storefront_accessibility, structured_data_json_ld, hidden_fee_detection |
| **External API** (Google PSI) | Medium (volatile) | page_speed |

Does any check scan only a *slice* of the page? No length slice — but scope narrowing exists: `structured_data_json_ld` inspects **only the first `@type:"Product"` node** it finds and stops; `business_identity_consistency` caps About-page text at 2,000 chars; `image_hosting_audit` reads only the **first 20** products' `descriptionHtml`; `hidden_fee_detection` reads the first 5 product pages + `/cart` + homepage. None of these truncate the payment/footer regions of the homepage — the homepage HTML is parsed whole.

### Scoring
`score = round(passedChecks / (totalChecks − erroredChecks) × 100)`. **A failed `warning` costs exactly as many points as a failed `critical`** — so a "mere warning" false positive damages the headline score identically to a critical one. Severity only changes the label/tone and the KPI counters, not the score arithmetic.

---

## TASK 2 — Per-check audit (all 12)

Legend — **FP likelihood**: chance of firing on a *compliant* store. **GMC-suspends**: does Google Merchant Center actually suspend the account or disapprove listings for this signal? (researched + adversarially verified). ⚠ = severity disproportionate to real GMC risk.

| # | Check | Data source | Detection | Severity (fail) | FP likelihood | GMC suspends? | Proportionate? |
|---|---|---|---|---|---|---|---|
| 11 | **hidden_fee_detection** | Static fetch (products + `/cart` + homepage) | Substring keyword (negation-blind) | **critical** | **High** | Partial — real *area*, wrong *detector* | ⚠ No |
| 6 | **checkout_transparency** | Static fetch (homepage) | Regex keyword on select attrs | warning | **High** (near-universal) | **No** (req. removed 2021-06-28) | ⚠ No |
| 1 | **contact_information** | Admin GraphQL (Page bodies + billingAddress) | Regex + field, ≥2 of 3 | **critical** | **High** | Partial (1 method suffices since 2021) | ⚠ No |
| 8 | **structured_data_json_ld** | Static fetch (product pages) | DOM parse + field presence | warning | **High** (deterministic bugs) | **No** (recommended, not required) | ⚠ No |
| 7 | **storefront_accessibility** | Static fetch (homepage + product statuses) | Heuristic (status + DOM markers) | **critical** / warning | Medium | Partial (product-level disapproval) | ⚠ Partly |
| 12 | **image_hosting_audit** | Admin GraphQL (`descriptionHtml`) | Regex host substring | **critical** | Low | **No** (evaluates `image_link`, not desc host) | ⚠ No |
| 3 | **shipping_policy** | Admin GraphQL (policies + Page fallback) | Regex keyword | **critical** / warning | Medium | Partial (limited visibility, not suspend) | ⚠ Partly |
| 2 | **refund_return_policy** | Admin GraphQL (policies + Page fallback) | Regex keyword | **critical** / warning | Medium | Partial (limited visibility; contradiction=hard) | ⚠ Partly |
| 5 | **product_data_quality** | Admin GraphQL (products) | Heuristic field predicates | warning / info (capped) | Medium | Partial (item-level disapproval only) | ✅ Yes |
| 9 | **page_speed** | External API (PSI mobile) | Threshold on metric | warning (fails **safe** → info pass) | Medium | **No** | ✅ Yes |
| 4 | **privacy_and_terms** | Admin GraphQL (policies + Page fallback) | Presence field-check | **critical** / warning | **Low** | Partial (soft trust signal) | Copy-only issue |
| 10 | **business_identity_consistency** | Admin GraphQL | Heuristic (Jaccard overlap) | info | High | Partial (real signal = legal name/NAP) | ✅ Yes (info) |

### Per-check detail

Each entry lists false-positive vectors, real GMC risk, the **verbatim** `fix_instruction` strings, and every hardcoded admin path.

---

#### 1 · contact_information — CRITICAL — [source](app/lib/checks/contact-information.server.ts)
**Detection:** ≥2 of 3 signals over `/contact|about/i` Page bodies (via Admin `getPages`): a regex phone, an email **whose domain contains the store domain**, or a street-address regex — with `billingAddress.city+country` as an address fallback.
**FP vectors (verified):**
- *(confirmed)* **Footer-vs-body placement** — the most common real layout puts phone/email/address in the theme footer, which is **not** a Page body. If no `/contact` or `/about` Page exists, the combined text is empty and phone+email both fail. **Reproduced live on misen.com → 0/3 → CRITICAL.**
- *(confirmed)* **External / help-desk email** — [line 41](app/lib/checks/contact-information.server.ts:41) requires the email domain to `.includes()` the store domain, so a Gorgias/Zendesk/Gmail support address (very common, and accepted by Google) never counts.
- *(confirmed)* **Contact form / social profile** — Google accepts either as sufficient contact; neither can satisfy this check.
- *(confirmed)* **JS-rendered contact page**; *(likely)* non-US phone/address regex gaps.
**Real GMC risk:** **Partial.** Since 2021-08-02 Google requires only **one** form of contact and accepts a contact form or social profile; in 2022 it stopped auto-removing free listings for insufficient contact info. It feeds a soft trust review, not a standalone hard suspension. The check encodes Google's *abandoned* 2-of-3 standard. *(Verifier caveat: the audit's assertion that "only the address reliably passes" is a reasoned estimate, not a measured base rate — but the direction is confirmed.)*
**Fix strings / paths:** *"1. Create or update your 'Contact Us' or 'About' page.\n2. Add at least 2 of the following: a phone number, an email address using your store's domain … and a physical street address (PO Boxes are not accepted…).\n3. In **Shopify Admin → Online Store → Pages**, publish the updated page."* → path **current**.

#### 2 · refund_return_policy — CRITICAL/WARNING — [source](app/lib/checks/refund-return-policy.server.ts)
**Detection:** Settings→Policies `REFUND_POLICY.body` (Page `/refund|return/i` fallback); regex for return window / item condition / refund method + placeholder detector. Missing→critical, incomplete→warning, Page-fallback pass→info advisory.
**FP vectors (verified):** *(confirmed)* **`ITEM_CONDITION_RE` is a closed enum** (`unused|unworn|…|tags attached`) — a clear policy saying "items must be in ressellable, as-delivered state" fails the condition test → WARNING "Incomplete". *(likely)* `RETURN_WINDOW_RE` misses spelled-out windows ("thirty days"); *(likely)* negation-blind.
**Real GMC risk:** **Partial.** Since Google's 2022 change a *missing* return policy limits *visibility* of free listings rather than disapproving them; paid Shopping ads can still be disapproved. The account-level **suspension** lever is a return policy that **contradicts** the on-site policy (Misrepresentation) — which this prose-only check cannot detect. *(Verifier caveat: absence still contributes to the trust review; don't over-narrow suspension to "contradiction only.")*
**Fix strings / paths:** *"1. In **Shopify Admin → Settings → Policies**, create a Refund Policy…"* / incomplete + Page-fallback advisories all point at **Settings → Policies** → **current**.

#### 3 · shipping_policy — CRITICAL/WARNING — [source](app/lib/checks/shipping-policy.server.ts)
**Detection:** mirror of refund; `TIMELINE_RE` + `COST_RE`.
**FP vectors (verified live):** **`TIMELINE_RE` misses common phrasings.** **Reproduced: tentree.com and misen.com both → WARNING "Vague Shipping Policy — no delivery timeline"** despite having shipping policies; the regex wants patterns like "3–7 business days" and misses "arrives in about a week", "ships next business day" variants, or timelines expressed only in the Shopify shipping-rates UI (not the policy prose). `COST_RE` similarly misses "we cover shipping".
**Real GMC risk:** **Partial** — same regime as refund (limited visibility for free listings; not a hard suspend for mere vagueness).
**Fix strings / paths:** *"1. In **Shopify Admin → Settings → Policies**, create a Shipping Policy…"* → **current**.

#### 4 · privacy_and_terms — CRITICAL/WARNING — [source](app/lib/checks/privacy-and-terms.server.ts)
**Detection:** presence-only of `PRIVACY_POLICY` + `TERMS_OF_SERVICE` (Page fallback). Privacy missing→critical, terms-only→warning, Page-fallback→info.
**FP vectors:** **Low.** Reads reliable Admin data with a `.trim()` guard; the only realistic FP is Shopify API shape drift.
**Real GMC risk:** **Partial.** Neither policy is an enumerated standalone suspension trigger; absence at most feeds the soft "website needs improvement" trust review. *(Verifier note: because this critical rests on **reliable Admin data with low FP**, a severity downgrade is a **copy** decision — the phrase "mandatory for Google Merchant Center approval" overstates reality — not a reliability defect. This is one of the safe checks.)*
**Fix strings / paths:** *"…click **'Create from template'** under Privacy Policy…"* — **PARTIALLY STALE**: no "Create from template" button exists in current Shopify. Correct labels are **"Insert template"** (return/shipping/terms) and, for Privacy specifically, **"Use automated policy."** Location `Settings → Policies` is current.

#### 5 · product_data_quality — WARNING/INFO — [source](app/lib/checks/product-data-quality.server.ts)
**Detection:** four predicates over Admin products — `stripHtml(description).length < 100`, no images, any variant `price` ∈ {null, "0.00"}, all variants blank SKU. Severity **capped**: warning if >20% flagged, else info; never critical.
**FP vectors:** *(confirmed)* arbitrary **<100-char** threshold flags legitimately terse listings; *(confirmed)* **`missing_sku` has no GMC basis** (Google uses GTIN/MPN/brand, not Shopify SKU); *(confirmed)* intentional `$0.00` products; *(likely)* 50-product sample not representative. *(Correction to the raw audit: the `variants(first:10)` cap does **not** spuriously fire `zero_price` — that claim was backwards.)*
**Real GMC risk:** **Partial** — missing image/price → *item-level disapproval* (that SKU removed), never account suspension; SKU/short-description are not GMC violations at all.
**Verdict:** severity is **proportionate** (capped at warning/info). Keep as-is; do not escalate. Drop `missing_sku` or relabel it advisory.
**Fix strings / paths:** *"For each flagged product in **Shopify Admin → Products** …"* → **current**.

#### 6 · checkout_transparency — WARNING — [source](app/lib/checks/checkout-transparency.server.ts) — **the reported complaint**
**Detection:** substring-match `PAYMENT_KEYWORDS` against **only** `img@src/@alt`, `<use>@href/@xlink:href`, `[class]`, `@aria-label`, `@data-payment-icon`, `@data-method` on the homepage.
**FP vectors (reproduced 3/3 — see Task 4/5):**
- *(confirmed)* **SVG `<title>` / `id` / `aria-labelledby` text** — Shopify's stock payment icons put the name in `<title>Visa</title>`, `id="pi-visa"`, `aria-labelledby="pi-visa"`; the check scans none of these.
- *(confirmed)* **JS-rendered / lazy-loaded footers** — most stores never emit icons in static HTML.
- *(confirmed)* **payment data in JSON blobs / unscanned `data-*`** (e.g. `data-enabled-payment-types`, Apple Pay config).
- *(confirmed)* **utility/Tailwind-classed SVGs** (class carries no keyword).
**Real GMC risk:** **NO.** Google **removed** the "display accepted payment methods before checkout" requirement on **2021-06-28**. The surviving policy only requires a working payment method *at checkout* — which this homepage check never inspects. This check tests a requirement that no longer exists.
**Fix strings / paths:** *"1. In **Shopify Admin → Online Store → Themes**, open your active theme's settings.\n2. Navigate to **Theme settings → Footer** and ensure payment icons are enabled.\n3. …Verify your providers are active under **Settings → Payments**.\n4. If using a custom theme, manually add payment icon SVGs…"* — path #2 is **THEME-DEPENDENT / misleading**: not all themes expose a footer toggle; Dawn's is labeled "Show payment icons" and renders only *already-active* gateways, so the load-bearing step is **Settings → Payments** (current), which is buried as step 3.

#### 7 · storefront_accessibility — CRITICAL/WARNING — [source](app/lib/checks/storefront-accessibility.server.ts)
**Detection:** password gate = OR of `homepageStatus===401`, body class `template-password`, password-y `<title>`, `form[action='/password']`, or `#shopify-challenge-page` → **critical**. Any sampled product page `!==200` → warning.
**FP vectors (verified):**
- *(confirmed)* **`#shopify-challenge-page` is a bot/DDoS challenge interstitial, not a password gate** — a store that briefly serves Shopify's challenge to the scanner's non-browser UA is falsely labeled **CRITICAL "Storefront is Password Protected."** ([lines 48–51](app/lib/checks/storefront-accessibility.server.ts:48))
- *(confirmed)* **Bot-block 403 / Cloudflare / timeout** on a product page → `status !== 200` → WARNING (self-healing, transient). `null` fetch counted as failure ([line 79](app/lib/checks/storefront-accessibility.server.ts:79)).
**Real GMC risk:** **Partial** — a genuine password gate is a real, non-transient *product-level landing-page disapproval* (warrants critical); a single transient non-200 is typically temporary and auto-resolves (not a suspension trigger).
**Verdict:** keep CRITICAL for a *true* password gate; **split out** the `#shopify-challenge-page` branch (challenge ≠ password) and downgrade/soft-retry the transient non-200 branch.
**Fix strings / paths:** *"1. In **Shopify Admin → Online Store → Preferences** … 'Password protection'.\n2. Uncheck 'Restrict access to visitors with the password'…"* → **current, verbatim-accurate** (section heading is "Restrict store access"). Product path → **Shopify Admin → Products** → current.

#### 8 · structured_data_json_ld — WARNING — [source](app/lib/checks/structured-data-json-ld.server.ts) — **two code bugs**
**Detection:** parse `<script application/ld+json>`, take the **first** `@type:"Product"`, require `name/image/description/offers` + `offers.{price,priceCurrency,availability}`.
**FP vectors (reproduced against the real module — see Task 5):**
- *(confirmed, **BUG**)* **`offers` as an array** — [line 103](app/lib/checks/structured-data-json-ld.server.ts:103) casts `offers` to an object and indexes `offers["price"]`; on an array (one `Offer` per variant — standard for multi-variant products, e.g. **misen.com live**) that is `undefined` → reports `offers.price/priceCurrency/availability` all missing though every value is present. Google explicitly permits an array of `Offer`.
- *(confirmed, **BUG**)* **`AggregateOffer`** legitimately uses `lowPrice`/`highPrice`, has no `price` key → reported as `missing offers.price`.
- *(confirmed)* **JS-injected JSON-LD** (allbirds/tentree emit 0 `ld+json` in static product HTML) → "no schema found".
- *(likely)* first-`Product`-node short-circuit picks a wrong/partial node; bot-block / password.
**Real GMC risk:** **NO.** Structured data is *recommended, not required*; absence/incompleteness does not disapprove products or suspend accounts. The real lever is a price/availability **mismatch** vs the feed — which this presence-only check never measures.
**Fix strings / paths:** *"1. Shopify's default themes inject Product JSON-LD automatically. If missing, check that your theme's product.liquid template…\n…4. Validate with Google's Rich Results Test: https://search.google.com/test/rich-results"* — no admin path (theme-file reference); the "default themes inject it automatically" line means a FP here tells a correctly-configured merchant their theme is broken.

#### 9 · page_speed — WARNING — [source](app/lib/checks/page-speed.server.ts)
**Detection:** Google PSI mobile; fail if performance `<50` or intrusive-interstitials `<0.9`. **Fails safe**: any API error/429/no-score → **info PASS** (score defaulted to 50).
**FP vectors:** *(confirmed)* **PSI score variance** run-to-run around the 50 cutoff; *(likely)* Lighthouse interstitial heuristic flags exempt modals (cookie/age/geo). Without `GOOGLE_PAGESPEED_API_KEY` the API is throttled (429) → the check simply passes (observed in all reproductions).
**Real GMC risk:** **NO** — GMC does not suspend/disapprove for speed; intrusive interstitials are an *organic* mobile-search ranking signal, **not** a Shopping/Merchant policy. The fix copy's claim *"Google penalises these in Shopping rankings"* is inaccurate.
**Verdict:** **proportionate** (fails safe; warning). Fix the copy; note that *"Set GOOGLE_PAGESPEED_API_KEY in your environment"* is a **developer** instruction leaking into a **merchant**-facing message.
**Fix strings / paths:** *"…4. In **Shopify Admin → Apps**, disable non-essential apps that inject scripts…"* → current (minor: modern apps use theme app embeds, toggled in the theme editor, not only via Apps uninstall).

#### 10 · business_identity_consistency — INFO — [source](app/lib/checks/business-identity-consistency.server.ts)
**Detection:** Jaccard word-overlap of shop name vs domain (0.6) + About-page text (0.4), threshold 0.3; **passes when shop-name tokens are empty**.
**FP vectors:** *(confirmed)* concatenated multi-word domains vs spaced names; *(confirmed)* `shop.brand.com` collapses first label to a stop word; *(confirmed)* abbreviated/stylized brands. **High FP** rate — but **info** severity, hedged copy ("may indicate… manual review advised"), and self-suppressing on empty tokens.
**Real GMC risk:** **Partial** — the real misrepresentation signal is legal-business-name + NAP consistency across site/MC/Ads/WHOIS, **not** display-name-vs-domain word overlap. This is a weak, misaligned proxy.
**Verdict:** **proportionate** (info). Low damage. Consider relabeling to make clear it is a heuristic hint.
**Fix strings / paths:** *"1. Ensure your Shopify store name (**Settings → General**) matches…"* → current.

#### 11 · hidden_fee_detection — CRITICAL — [source](app/lib/checks/hidden-fee-detection.server.ts) — **worst offender**
**Detection:** substring-match `FEE_TERMS` (`handling fee`, `restocking fee`, `processing fee`, `convenience fee`, `service charge`, `surcharge`) in visible text of product pages + `/cart` + homepage; if a term appears on the storefront but **not** in the shipping/refund policy text → **critical "Undisclosed Fees Detected — Google Merchant Center treats undisclosed fees as misrepresentation."**
**FP vectors (reproduced against the real module — see Task 5):**
- *(confirmed, **negation blindness**)* `lower.includes("restocking fee")` matches *"We charge **no restocking fee**, ever"* and *"there is **never a handling fee**"* → **CRITICAL misrepresentation accusation triggered by copy that reassures customers there are NO fees.**
- *(confirmed)* context blindness — the phrase in an FAQ, review, blog excerpt, or another store's embedded text counts; the policy must repeat the **exact** phrase or it is "undisclosed."
- *(likely)* `/cart` is empty/JS-rendered for most themes (fetched with a non-browser UA), so cart-side detection is unreliable in both directions.
**Real GMC risk:** **Partial — legitimate concern, wrong detector.** Undisclosed checkout costs *are* a genuine Google misrepresentation area, so the check's *intent* is valid (unlike #6/#12). But a substring scan that cannot distinguish a disclosed fee, a negated fee, or contextual text from an actual undisclosed surcharge produces confident CRITICAL accusations on compliant stores.
**Fix strings / paths:** *"1. In **Shopify Admin → Settings → Policies**, edit your Shipping Policy … to clearly explain every fee … {terms}.\n2. State who pays the fee…"* → path current; but the instruction is nonsensical when the "fee" is a *"no restocking fee"* reassurance.

#### 12 · image_hosting_audit — CRITICAL — [source](app/lib/checks/image-hosting-audit.server.ts)
**Detection:** regex `src|srcset|data-src` URLs in the first 20 products' `descriptionHtml`; any match against `DROPSHIPPER_HOSTS` (alicdn, cjdropshipping, …) → **critical "Dropshipper-Hosted Images Detected — Google Merchant Center treats this as a misrepresentation signal."**
**FP vectors:** *(confirmed)* negation/context-blind substring; *(likely)* a legitimate merchant who intentionally embeds a supplier/manufacturer image in a description; narrow host list also **misses** real dropshippers. **Low FP frequency** (specific hosts, reliable Admin data) — but high *damage-per-incident*.
**Real GMC risk:** **NO.** Google evaluates `image_link` (the primary product media, on Shopify's CDN) for its image policy; the product-data spec says descriptions should be plain text without HTML/links, so a **description-embedded** image host is **not a feed signal at all**. Misrepresentation is driven by copied content across stores, feed-vs-site mismatch, counterfeits, and false identity — not by a CDN hostname string. *(Verifier caveat: an embedded alicdn/CJ URL is still decent circumstantial evidence of dropshipping — but that is a business-model heuristic, not a documented GMC enforcement trigger.)*
**Fix strings / paths:** *"1. Open each affected product in **Shopify Admin -> Products**.\n2. Re-host the product images on Shopify's CDN…"* → current.

---

## TASK 3 — Highest-damage checks (CRITICAL + static-fetch/regex)

The task's specific worry — **CRITICAL severity built on brittle matching that both tanks the score and reads as an accusation** — maps to these, worst first:

1. **`hidden_fee_detection` (CRITICAL · static fetch · substring · accusatory).** The single worst check. Negation blindness means the phrase *"no restocking fee"* produces a CRITICAL "Undisclosed Fees / **misrepresentation**" verdict — **proven** against the real module. Static-fetch + substring + critical + accusation is the exact worst-case profile.
2. **`image_hosting_audit` (CRITICAL · Admin data · regex · accusatory).** Not static-fetch (reads Admin `descriptionHtml`), so lower FP frequency — but CRITICAL + "dropshipper / misrepresentation" accusation for a signal **GMC does not enforce**. Severity is disproportionate to a non-existent enforcement action.
3. **`storefront_accessibility` (CRITICAL · static fetch · heuristic).** The `#shopify-challenge-page` branch misreads a bot/DDoS challenge as a password gate → false CRITICAL "Storefront is Password Protected." Static-fetch heuristic driving a critical accusation.
4. **`contact_information` (CRITICAL · Admin data · regex).** Not static-fetch, but CRITICAL, high-FP (footer/contact-form/external-email blind), and enforces a **2-of-3 standard Google abandoned in 2021**. Live-reproduced 0/3 on a compliant store.

> Note on `structured_data_json_ld` and `checkout_transparency`: only **warning** severity, but because a failed warning costs the **same score points** as a critical and both fire near-universally (deterministic offers-array bug; JS-rendered footers), their aggregate score damage rivals the criticals — they simply don't carry the accusatory label.

---

## TASK 4 — Deep dive: checkout_transparency

### Exactly what it matches
Keyword set (`PAYMENT_KEYWORDS`, [constants.ts:43](app/lib/checks/constants.ts:43)): `visa, mastercard/master-card/master_card, paypal, amex, american-express/_express, discover, apple-pay/applepay/apple_pay, google-pay/googlepay/gpay, maestro, jcb, diners, shop-pay/shopify-pay/shopify_pay, unionpay, klarna, afterpay, clearpay`.
Substring-scanned **only** in these locations ([checkout-transparency.server.ts:46](app/lib/checks/checkout-transparency.server.ts:46)):
`<img>` `src`/`alt` · `<use>` `href`/`xlink:href` · any `[class]` · `aria-label` · `data-payment-icon` · `data-method`. Pass if **≥1** keyword is found anywhere in those.

### What it concretely MISSES
- **SVG `<title>` element text** — `<title id="pi-visa">Visa</title>`. The name is in element *text*, never scanned.
- **`id` and `aria-labelledby`** — `id="pi-visa"`, `aria-labelledby="pi-visa"`. The check reads `aria-label`, **not** `aria-labelledby`, and never reads `id`.
- **Inline `<svg>` with utility classes** — Shopify/Dawn/Tailwind icon SVGs carry classes like `icon icon--full-color` or `w-12 h-auto` — no payment keyword.
- **`{{ shop.enabled_payment_types }}` Liquid / dynamic checkout & Shop Pay buttons** rendered client-side, and payment config in **JSON blobs** (`"supportedNetworks":["visa",…]`) or **unscanned `data-*`** (`data-enabled-payment-types`).
- **CSS background-image sprites** — `background: url(payment-sprite.png)` in CSS carries no scannable attribute.
- **Entirely JS/lazy-rendered footers** — the icons aren't in the static HTML at all.

### Why a store with visible icons fails
Shopify's stock payment-icon markup encodes the payment name **only** in `<title>` text, `id`, and `aria-labelledby` — the three places the check does not look — while the SVG's `class` is generic styling. So a footer showing ten icons yields **zero** keyword hits in the scanned attributes → "No Payment Method Icons Detected." Stores that render the footer with JavaScript emit no icon markup in the static fetch at all, guaranteeing the same result.

---

## TASK 5 — Reproduction (live + coded, read-only)

`scripts/outbound-scanner.ts` contains **byte-identical** check logic to the production modules (verified by diff of the inline `checkCheckoutTransparency` etc.). Run 2026-07-09 (no `GOOGLE_PAGESPEED_API_KEY`, so PSI returns 429 → info pass — noted and continued).

### 5a · checkout_transparency false-positives on 3/3 stores that visibly show icons

| Store | Icons actually shown | Scanner verdict | Why it missed |
|---|---|---|---|
| **tentree.com** | 10 inline SVGs (Visa, Mastercard, Amex, PayPal, Apple Pay, Google Pay, Shop Pay, Discover, Diners, Venmo) | ⚠ "No Payment Method Icons Detected" | Names only in `<title>`/`id`/`aria-labelledby`; SVG class = Tailwind utilities |
| **allbirds.com** | Yes (footer) | ⚠ "No Payment Method Icons Detected" | Keywords only in a JSON blob + `data-enabled-payment-types` |
| **misen.com** | Yes (footer) | ⚠ "No Payment Method Icons Detected" | Footer JS/lazy-rendered — absent from static HTML |

Exact tentree markup (payment name is **only** in the three unscanned locations):
```html
<svg class="w-12 h-auto pr-2 mt-2 space-y-2" role="img" viewBox="0 0 38 24"
     aria-labelledby="pi-visa"><title id="pi-visa">Visa</title>…</svg>
```
Grep confirmed **zero** payment keywords in any scanned location (`img@src/@alt`, `<use>@href`, `[class]`, `@aria-label`) for tentree.

### 5b · Other homepage/static checks that co-false-positived in the same runs
- **misen.com** — `contact_information` → **CRITICAL "Insufficient Contact Information — 0 of 3"** (no `/pages/contact`; `/pages/contact` returns 404; contact info is footer/help-desk).
- **misen.com** — `structured_data_json_ld` → WARNING "missing `offers.price`, `offers.priceCurrency`, `offers.availability`" — misen's Product schema has a **valid `offers` array** with all three fields present per variant.
- **tentree.com & misen.com** — `shipping_policy` → WARNING "no delivery timeline" despite having shipping policies (`TIMELINE_RE` phrasing gap).
- **allbirds.com & tentree.com** — `structured_data_json_ld` → WARNING "no schema found" (JSON-LD is JS-injected; 0 `ld+json` blocks in static product HTML).

### 5c · Coded reproduction against the *real* production modules
Executed `checkHiddenFeeDetection` and `checkStructuredDataJsonLd` directly (esbuild-bundled, no repo changes):

```
A) hidden_fee_detection — store text: "no restocking fee" / "never a handling fee"
   passed=false | severity=CRITICAL | title="Undisclosed Fees Detected"
   description: Found 2 undisclosed fee terms … (handling fee, restocking fee) …
               Google Merchant Center treats undisclosed fees as misrepresentation.

B) structured_data_json_ld — VALID Product, offers = ARRAY of per-variant Offers
   passed=false | severity=warning | "missing offers.price, offers.priceCurrency, offers.availability"

C) structured_data_json_ld — VALID Product, offers = AggregateOffer (lowPrice/highPrice)
   passed=false | severity=warning | "missing offers.price"
```

---

## TASK 6 — Ranked findings & remediation

Ranked by **FP likelihood × severity × merchant-visible damage** (accusation tone + firing frequency). Highest first. *No changes implemented — remediation is advisory.*

| Rank | Check | Sev | FP | GMC basis | Core defect | Recommended remediation |
|---|---|---|---|---|---|---|
| **1** | hidden_fee_detection | critical | High | Partial | Negation-blind substring → CRITICAL "misrepresentation" on *"no restocking fee"* (proven) | Downgrade to **warning**; require context (fee + a price/amount nearby); drop pure negated/contextual matches; drop unreliable `/cart` fetch; soften "misrepresentation" copy |
| **2** | contact_information | critical | High | Partial | Reads only Page bodies → blind to footer/contact-form/external-email; enforces abandoned 2-of-3 rule (proven 0/3) | Downgrade to **warning**; require **≥1** method; accept any email + contact form + social; read footer/`shopInfo.contactEmail` |
| **3** | checkout_transparency | warning | High | **No** | Tests a requirement Google removed in 2021; misses `<title>`/`id`/`aria-labelledby`/JS footers (proven 3/3) | **Remove** or downgrade to **info**; if kept, scan `<title>`/`aria-labelledby`/`id` and Liquid/JSON payment config; reframe as advisory |
| **4** | structured_data_json_ld | warning | High | **No** | Two code bugs: `offers` array & `AggregateOffer` → false "missing price" (proven); JS-injected JSON-LD invisible | Handle `offers` as array/`AggregateOffer`/`lowPrice`; treat static-fetch "absent" as *unknown* not *missing*; reframe as SEO/rich-results, not compliance |
| **5** | image_hosting_audit | critical | Low | **No** | CRITICAL "dropshipper/misrepresentation" for a description image host GMC doesn't evaluate | Downgrade to **warning/info**; drop "misrepresentation" framing; present as an advisory heuristic |
| **6** | storefront_accessibility | critical | Med | Partial | `#shopify-challenge-page` (bot challenge) misread as password gate → false CRITICAL; transient non-200 → warning | Split challenge ≠ password; retry/soft-fail transient non-200; keep critical only for a true password gate |
| **7** | shipping_policy | crit/warn | Med | Partial | `TIMELINE_RE`/`COST_RE` phrasing gaps → WARNING on real policies (proven ×2) | Downgrade incomplete→**info advisory**; broaden regex; consider LLM/semantic completeness check |
| **8** | refund_return_policy | crit/warn | Med | Partial | Closed-enum `ITEM_CONDITION_RE` → WARNING on clear policies; missing→critical overstated for free-listings | Broaden condition/window regex; incomplete→**info advisory**; reframe "critical" missing copy toward "limited visibility" |
| **9** | product_data_quality | warn/info | Med | Partial | Arbitrary <100-char rule; `missing_sku` has no GMC basis | **Keep severity** (already capped); drop/relabel `missing_sku`; make description threshold advisory |
| **10** | page_speed | warning | Med | **No** | Fails safe (mostly passes), but copy claims Shopping-ranking penalty; dev-facing API-key message leaks to merchants | Keep warning; fix inaccurate copy; hide the `GOOGLE_PAGESPEED_API_KEY` instruction from merchants |
| **11** | privacy_and_terms | crit/warn | **Low** | Partial | Reliable presence check; only issue is "mandatory for GMC approval" overstatement + invented "Create from template" button | **Trust as-is**; soften copy; fix button label to "Use automated policy"/"Insert template" |
| **12** | business_identity_consistency | info | High | Partial | Word-overlap heuristic, weak proxy for GMC's legal-name/NAP check | **Trust as-is** (info, hedged, self-suppressing); relabel as a hint |

### Admin-path (complaint #2) verdict
Most hardcoded paths are **current** (Settings → Policies, Settings → Payments, Online Store → Pages, Online Store → Preferences → Password protection, Products, Settings → General, Apps). Two are wrong:
- **Invented button label** — `privacy_and_terms` says *"Create from template"*; current Shopify has **"Insert template"** (return/shipping/terms) and **"Use automated policy"** (privacy). **Stale — fix.**
- **Misleading primary action** — `checkout_transparency` sends merchants to *"Theme settings → Footer → enable payment icons"*, which is theme-dependent and renders only already-active gateways; the real fix (**Settings → Payments**) is buried. **Reorder.**
- Minor: `page_speed`'s "script-injecting apps" reflects the legacy ScriptTag model (modern apps use theme app embeds).

### Verdict
**Safe to trust as-is:** `privacy_and_terms`, `product_data_quality`, `business_identity_consistency`, and `page_speed` — each either reads reliable Admin data with a presence/field check (low FP) or is severity-capped/fails-safe so a false positive does little harm; their only issues are copy accuracy, not reliability. **Reliable signal, unreliable detection (needs regex/parse work, not removal):** `refund_return_policy`, `shipping_policy`, and `storefront_accessibility`'s genuine-password-gate path — the intent is valid but the matching is too narrow. **Needs real work — false-positive-prone and/or misaligned with actual GMC enforcement:** `hidden_fee_detection`, `contact_information`, `checkout_transparency`, `structured_data_json_ld`, and `image_hosting_audit` — these are the checks generating the review complaints; they should be re-scoped (severity/copy), have detection broadened to see JS-rendered and stock-Shopify markup (or moved off static fetch), and in the cases of payment icons and description image-hosts, reconsidered entirely, since Google does not enforce those signals at all.
