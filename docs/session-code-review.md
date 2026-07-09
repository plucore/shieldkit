# Session Code Review — Scan-Reliability False-Positive Batch

**Scope reviewed:** `2a386ef..9f1d1e6` (10 commits) — the 2026-07 false-positive remediation:
`hidden_fee_detection` negation, `contact_information` 1-of-N + warning, `structured_data_json_ld`
offers-shapes, `checkout_transparency` INFO, `image_hosting_audit` warning, public-scanner port,
CLI port, shared-detector refactor, docs.

**Method:** diffs re-derived from source (not commit messages); every correctness claim executed against
the real modules or a verbatim replica of the source logic; findings independently produced by a 4-dimension
adversarial workflow, then each finding attacked by a skeptic verifier. Read-only — **no code changed, no commits.**

**Re-derived baselines (not taken from prior summaries):**
- Tests: **329 / 329 passing** (14 files) — `npx vitest run`.
- Typecheck: **43 errors** — `tsc --noEmit` after fresh `react-router typegen`. Matches the known baseline.
  The only error inside a touched file is pre-existing and unrelated to the changes:
  `scripts/outbound-scanner.ts(104,22) TS2694 'LookupAddress'` (present identically at `2a386ef`). **No new type errors.**
- Working tree clean after review; no artifacts left behind.

**The user's two predictions, adjudicated:**
- *"At least one fix overcorrected into a useless false negative"* → **CONFIRMED**: [F1](#p1-1) — `hidden_fee_detection`.
- *"At least one severity is inconsistent somewhere"* → **CONFIRMED**: [F2](#p1-2) — the `ScoreBanner` "clean" gate is
  inconsistent with the new severity distribution; and the audit doc still states pre-fix severities ([F11](#p2-9)).

---

## Verdict

**Safe to leave on main? Yes — with two fixes that should land soon.** Nothing here is a **P0**: no check ships a
false *accusation*, and no check was softened into a total no-op — every softened check still fires at the correct
severity on a straightforwardly bad store (executed: `20% restocking fee applies`→critical; zero-contact→warning;
alicdn/cjdropshipping→warning; Product-schema-missing-price→warning; checkout structurally cannot fail). The
"zero behavior change" refactor (`49903a9`) is genuinely faithful — logic was moved verbatim.

But the softening left **two P1 gaps that undercut the product's purpose**: (1) the one check meant to stay
CRITICAL — `hidden_fee_detection` — is now blind to real fees whenever ordinary benign phrasing ("no", "not",
"without", "no questions asked") sits within 45 characters, which is exactly how a returns paragraph reads; and
(2) the paid dashboard now tells merchants **"Your store is clean"** while unresolved WARNING failures remain,
because the demotions this session made moved those failures out of the `critical_count` the banner keys on.
Neither is catastrophic, but both erode trust in opposite directions (missed real fee / false all-clear). The
remaining items are P2: bounded false-negatives, score-inflation, a residual false-positive, and pre-existing
copy issues surfaced by the all-12 audit.

---

## Prioritized fix list

**P0** — none.

**P1**
1. `hidden_fee_detection`: make negation clause-scoped (don't let a negation on a *different* nearby fee suppress
   a genuine positive fee), and add a behavioral regression test for the mixed case.
2. `ScoreBanner`: gate the "Your store is clean." line on `warning_count === 0` too (mirror `SecurityStatusAside`).

**P2**
3. `structured_data_json_ld`: residual **false positive** — accept `priceCurrency` nested inside `priceSpecification`
   (currently only price is accepted there).
4. `public-risk-score.ts`: drop/redistribute the 10-pt weight on the never-failing `checkout_transparency`.
5. `hidden_fee_detection`: add `deducted`/`withheld`/`retained` to the positive-charge verbs; scope amount-search to the sentence.
6. `contact_information`: `SOCIAL_RE` matches share/intent URLs, not just profiles — tighten if contact should mean the merchant's own profile.
7. Add a CLI-mirror parity guard (byte-equality test between `outbound-scanner.ts` and the shared module/constants).
8. `image_hosting_audit`: 20-product sample can miss supplier CDNs on products #21–50 of a large dropship catalog.
9. `/scan`: reconcile the two divergent headline numbers (flat "Compliance score" vs weighted "GMC suspension risk score").
10. Pre-existing copy: `privacy_and_terms` "Create from template" wording (inconsistent w/ refund/shipping; verify against live admin); password-protection label.
11. Docs: `docs/scan-reliability-audit.md` states pre-fix severities — annotate as historical to avoid being read as current.

---

## Findings (ranked by severity × likelihood)

### P1-1 — `hidden_fee_detection`: cross-clause negation suppresses genuine fees {#p1-1}
**Confidence: high.** This is the marquee regression — the one check the spec keeps at CRITICAL is now blind to
the evasion pattern it exists to catch.

`scanFees` takes a **45-char window** on each side of a fee term and drops the hit if `NEGATION_RE` matches
**anywhere** in that window, with no clause/sentence boundary awareness
(`hidden-fee-detection.server.ts:44,85-91`). So a negation attached to a *different* (reassured-absent) fee — or
to ordinary marketing copy — suppresses a genuine, positively-charged fee sitting nearby.

**Executed against the real `checkHiddenFeeDetection` (all should be CRITICAL; all return `passed:true, info, fees_detected:[]`):**

| Input | Result |
|---|---|
| `no handling fee, but a 15% restocking fee applies` | **PASS (wrong)** — real 15% fee missed |
| `no restocking fee, no handling fee — a 10% processing fee applies` | **PASS (wrong)** |
| `Satisfaction guaranteed, no questions asked. A 20% restocking fee applies.` | **PASS (wrong)** — "no" from "no questions" |
| `Not sure? A 20% restocking fee applies to opened items.` | **PASS (wrong)** — "not" from "Not sure?" |
| `Orders without free shipping incur a $5 handling fee.` | **PASS (wrong)** — "without" |
| `No restocking fee on exchanges; a 20% restocking fee applies to refunds.` | **PASS (wrong)** |
| *control:* `A 20% restocking fee applies to all returns.` | correctly CRITICAL |

The suppression is **narrower than "any reassurance"** — it requires an actual `NEGATION_RE` token
(`no|not|never|zero|without|waived|free of|*n't`) in the 45-char window (e.g. `Enjoy free shipping … a 15%
restocking fee applies` still fires, because bare "free" isn't a negation token). That keeps it **P1, not P0** —
it's a false *negative*, not a false accusation — but returns/fee copy routinely contains those tokens, so the
real-world miss rate is high. **Blast radius is bounded to the authenticated paid-dashboard scan** —
`hidden_fee_detection` runs only in `index.server.ts:193`, not on `/scan` or the CLI.

**No test guards this.** `tests/scan-fp-fixes.test.ts:80-154` covers reassurance-only, lone-fee, disclosed-fee,
and ambiguous cases — never the mixed "benign-negation-near-real-fee" case.

**Recommended fix:** evaluate negation/positive-charge on a clause bounded by sentence/clause delimiters
(`.;—\n` or an N-word window centered on the term), or require the negation token to sit *between* the fee term
and its positive-charge token. Add a regression test with the two proven inputs asserting `passed:false`,
`severity:critical`, `undisclosed_terms` contains the genuine fee.

---

### P1-2 — `ScoreBanner` tells paid merchants "Your store is clean" while WARNINGs remain {#p1-2}
**Confidence: high. Directly caused by this session's demotions.**

The paid reassurance line gates on:
```
hasPaidAccess(tier) && !isScanning && score !== null && score >= 80 && (latestScan.critical_count ?? 0) === 0
```
(`app/components/ScoreBanner.tsx:112-116`) and renders the literal sentence **"Your store is clean."**
(`:129`). It keys **only on `critical_count`** and ignores `warning_count` entirely.

This session demoted `contact_information` and `image_hosting_audit` from **critical → warning**
(`git show 2a386ef:…contact-information.server.ts:101`, `…image-hosting-audit.server.ts:87` were `critical`).
Consequence, executed: a store that fails exactly those two (both now warnings) and passes everything else →
`critical_count = 0`, `warning_count = 2`, `score = round(10/12*100) = 83` ≥ 80 → the banner fires **"Your store
is clean."** while two real, actionable warnings sit in the checklist below it. Pre-session those same failures
were criticals, so `critical_count > 0` suppressed the banner.

The codebase's own convention contradicts this: `SecurityStatusAside.tsx:156` gates its clean state on
`criticalCount === 0 && warningCount === 0`.

**Recommended fix:** add `&& (latestScan.warning_count ?? 0) === 0` to the `ScoreBanner` gate (mirror
`SecurityStatusAside`), or soften the copy so it doesn't assert cleanliness when warnings exist.

---

### P2-1 — `structured_data_json_ld`: residual FALSE POSITIVE on `priceSpecification` currency {#p2-1}
**Confidence: high (executed).** The offers-shape fix (`c01eba5`) is **half-done**.

`offerHasPrice` accepts a nested `priceSpecification` object as a valid **price**
(`html-detectors.server.ts:160-168`), but the currency check only inspects the **top-level** property:
`if (!offerObjs.some(o => !!o["priceCurrency"])) missing.push("offers.priceCurrency")` (`:234`). So a valid Offer
that carries price *and* currency inside `priceSpecification` is flagged as **"missing priceCurrency" → WARNING** —
exactly the "valid-but-unusual schema false positive" class this batch set out to kill.

**Executed (`missingRequiredProductFields`):**
```
Offer { priceSpecification: { price:"10.00", priceCurrency:"USD" } }  → missing=[offers.priceCurrency]  (WRONG WARNING)
Offer { price:"10.00", priceCurrency:"USD" }                          → PASS
AggregateOffer { lowPrice, highPrice, priceCurrency }                 → PASS
```
Affects **both** the authenticated check and `/scan` (shared detector). Shopify's default themes emit flat
`price`/`priceCurrency`, so real-world frequency is low — but the code explicitly opted into `priceSpecification`
support for price, making the price/currency asymmetry a genuine inconsistency.

**Recommended fix:** in the currency check, also treat currency as present when
`o.priceSpecification?.priceCurrency` (or any normalized offer's nested spec) is set.

---

### P2-2 — `computeRiskScore` gives every store 10 free points for a check that can never fail {#p2-2}
**Confidence: high (executed).**

`checkout_transparency` now **always** returns `passed:true` on all branches, yet `RISK_WEIGHTS.checkout_transparency
= 10` and `computeRiskScore` adds the weight whenever a check passed (`public-risk-score.ts:21-40`). So the weighted
**"GMC suspension risk score"** unconditionally awards 10/100 for a check with zero discriminating signal.
`structured_data_json_ld` (weight 15) similarly awards its full 15 in the common bad-store case (schema absent →
pass). Executed floor for a store failing everything failable: **25/100** (10 + 15). The file's own header claims
uncomputable-check weight is *"redistributed across what we can measure"* — but an always-pass check is precisely an
uncomputable signal whose weight was **not** redistributed.

**Recommended fix:** drop `checkout_transparency` from `RISK_WEIGHTS` and redistribute its 10 pts; reconsider whether
"absent" JSON-LD should earn the full 15.

---

### P2-3 — `hidden_fee_detection`: under-reach on "deducted" + distant amount {#p2-3}
**Confidence: med (executed).** Mirror-image of P1-1.

When a real fee is described with a verb **not** in `POSITIVE_CHARGE_RE` (notably `deducted`, and `will be
deducted` — the regex only has `will be charged|added|applied`) **and** the numeric amount sits in a later clause
beyond the 45-char window, no positive-charge signal lands near the term and the fee is dropped.

**Executed:** `A restocking fee will be deducted from your refund for all opened items … the amount is 20% of the
item price.` → **PASS (missed)**. Control with the amount near the term (`A 20% restocking fee will be deducted…`)
→ CRITICAL. Requires the compound precondition (synonym verb + displaced amount), so practical hit-rate is lower
than P1-1.

**Recommended fix:** add `deducted|deduct|withheld|retained` to `POSITIVE_CHARGE_RE`; scope the amount search to
the containing sentence rather than a fixed 45-char slice.

---

### P2-4 — `contact_information`: `SOCIAL_RE` matches share/intent buttons, not just profiles {#p2-4}
**Confidence: med (executed).**

`SOCIAL_RE` (`constants.ts:92-93`) is a bare-domain substring match, so it cannot distinguish the merchant's own
social profile from a **product share button** or Open-Graph link. Executed — all match (`socialFound → contact
passes`):
```
facebook.com/sharer/sharer.php   → match
pinterest.com/pin/create/button  → match
twitter.com/intent/tweet         → match
youtube.com/watch (og:see_also)  → match
```
Because the check passes on **any** single signal and is intentionally false-negative-biased, a store with share
widgets in scope (About/Contact page or homepage footer) passes `contact_information` even with no real contact
method — pushing an already-soft check closer to never-firing. Harm is low (it's a demoted WARNING, FN-biased by
design), and for the *authenticated* check the corpus is CMS Pages + homepage (share buttons less common there than
on product pages), so this is P2, not P1.

**Recommended fix:** if "social profile" should mean the merchant's own profile, exclude known share/intent paths
(`/sharer`, `/intent`, `/pin/create`, `/share`) from `SOCIAL_RE` or require a profile-shaped path.

---

### P2-5 — CLI mirror (`outbound-scanner.ts`) has no automated drift guard {#p2-5}
**Confidence: high.** *Latent, not present* — there is **zero current divergence.**

The refactor folded two of three detector copies into the shared module, but the CLI must run standalone
(`node --experimental-strip-types` rejects the app's extensionless imports), so it keeps a hand-copied mirror of
`SOCIAL_RE`, `PAYMENT_KEYWORDS`, `PAYMENT_STRUCTURAL_SIGNALS`, the contact regexes, `normalizeOffers`,
`offerHasPrice`, and the full JSON-LD body (`outbound-scanner.ts:209-283,492-499,710-756`). Verified byte-identical
to `constants.ts` + `shared/html-detectors.server.ts` today (25/25 keywords in-order, 9/9 structural signals, all
regexes equal). But **no test asserts CLI == shared**, so the exact triple-copy pattern that caused the 2026-07 FP
incident survives in the one fork the refactor couldn't remove — a future shared-module edit that isn't mirrored
ships silently. Blast radius: the CLI is an internal ops/outreach tool, not a merchant request path.

**Recommended fix:** a cheap file-content parity test (the repo's dominant test style) extracting the mirrored
literals from both files and asserting equality.

---

### P2-6 — `image_hosting_audit`: 20-product sample can miss supplier CDNs on #21–50 {#p2-6}
**Confidence: med (executed).** `products.slice(0, 20)` (`image-hosting-audit.server.ts:55`). The orchestrator
fetches up to 50 products, so a dropship catalog whose supplier-hosted images are only on products #21–50 is
reported clean. Executed: 20 clean Shopify-CDN products + a #21 with `ae01.alicdn.com` → PASS. The cap is
**documented** in the check header and the clean-pass copy names `sample.length` (doesn't over-claim the whole
catalog), so this is a bounded, by-design limit on a WARNING advisory — but it's a real false negative for exactly
the large-catalog dropshipper the tool targets.

**Recommended fix:** raise the cap toward the fetched set size, or note the sampled count more prominently.

---

### P2-7 — `/scan` shows two divergent headline numbers {#p2-7}
**Confidence: med. Pre-existing; marginally widened this session.** `/scan` renders both `result.score` (flat
`passed/scorable*100`, labelled "Compliance score", drives the threat badge) and `computeRiskScore(...)` (weighted,
labelled "GMC suspension risk score") — `scan.tsx:291-293,330,510-543`. They use different formulas and can display
two large, differently-colored numbers for the same store (executed divergence: flat 75 vs weighted 85). Both
scorers predate the session (`scan.tsx`/`public-risk-score.ts` untouched in range); making `checkout_transparency`
always-pass slightly widens the gap for payment-icon-missing stores.

**Recommended fix:** present one authoritative number (prefer the weighted score persisted to
`leads.public_risk_score`), or derive `threat_level` from the weighted score.

---

### P2-8 — Authenticated flat-score floor rose to ~33% for a genuinely bad store {#p2-8}
**Confidence: low. Largely a restatement of the intended FN-bias.** `complianceScore = passedChecks/scorableTotal`
(`index.server.ts:230-234`). For a non-compliant store, four checks are now effectively guaranteed passes —
`checkout_transparency` (always), `structured_data_json_ld` (absent→pass), `hidden_fee_detection` (no positive fee),
`image_hosting_audit` (no supplier host) — giving a floor of `round(4/12*100) = 33%` even when the other 8 fail
(public flat scorer floor is 25% = 2/8; same direction, different magnitude). This is the accepted false-negative
design; the one sharper sub-point (an always-pass check sitting in the denominator) is already captured by P2-2.

**Recommended fix (if pursued):** exclude always-pass INFO checks (e.g. `checkout_transparency`) from
`scorableTotal`, the way errored checks are already excluded — or document the intended floor.

---

### P2-9 — Pre-existing copy / doc issues surfaced by the all-12 audit {#p2-9}
**Confidence: med/low. None of these files were modified this session** — flagged per the Dimension-8 request to
audit all 12 checks, not just the batch.

- **`privacy_and_terms` "Create from template"** (`privacy-and-terms.server.ts:133,158`): tells merchants to click
  a **"Create from template"** button. Code-verifiable defect: it's **inconsistent** with the sibling policy checks
  — `refund-return-policy.server.ts:73` and `shipping-policy.server.ts:60` say "create a … Policy" with no button
  label. Whether "Create from template" is also *stale* vs the current admin ("Insert template") could **not be
  verified** in this read-only harness (the Shopify dev MCP covers developer APIs, not merchant Policies-editor UI
  copy) — verify in a live admin. Fix: unify the wording across all four policy checks.
- **`storefront_accessibility` password label** (`storefront-accessibility.server.ts:64-65`, mirrored in
  `public-scanner.server.ts:498`, `outbound-scanner.ts:627`): quotes "Restrict access to visitors with the
  password". Path (Online Store → Preferences) is fine; the exact checkbox label may have drifted to a "Password
  protection" control. Unverified in-harness; three copies to keep in sync.
- **`docs/scan-reliability-audit.md`** (the audit, commit `3cb03f3`) states **pre-fix** severities (contact &
  image as CRITICAL, lines 46-51, 65, 152). Correct as a historical audit, but reads as stale if taken for
  current state. Annotate it as pre-remediation.

---

### P2-10 — `hidden_fee_detection` 5-page cap is unreachable dead ceiling {#p2-10}
**Confidence: low. Effectively a non-issue** (kept for completeness; the adversarial verifier *refuted* the
original "misses page #6" framing). `checkHiddenFeeDetection` iterates `productPages.slice(0, 5)`
(`hidden-fee-detection.server.ts:114`), but its only caller prefetches **at most 3** product pages
(`index.server.ts:124-127`, `products.filter(onlineStoreUrl).slice(0, 3)`). The `slice(0, 5)` ceiling sits above
the actual supply, so it can never truncate in production. Documentation nit only.

---

## Ruled out (null results — verified, not assumed)

- **Refactor `49903a9` is genuinely zero-behavior-change.** Diffed `ded7f45 → 49903a9`: JSON-LD detectors
  (`normalizeOffers`/`offerHasPrice`/`findProductSchema`) moved **verbatim**; contact extraction's new
  `filter(Boolean)` only drops empty separators (inert for these regexes/`includes` — proven on boundary-split
  inputs); the CLI change in that commit was **comment-only** (the SOURCE-OF-TRUTH header). Payment `checkText`
  body character-identical; all regexes/keyword lists byte-identical across shared/constants/CLI. Admin augmentation
  (contact: `shopInfo.contactEmail` + `billingAddress` + Page title/handle; json-ld: recommended fields +
  `identifier_exists`) preserved.
- **No stale-severity leak in aggregation or UI.** `criticalCount/warningCount/infoCount` derive dynamically from
  each result's `severity` (`index.server.ts:223-226`); `AuditChecklist.tsx:96` reads `check.severity`; no component
  hardcodes a check-name → severity map. `CLAUDE.md` severities match the code.
- **`contact_information` homepage HTML is wired at all three call sites** (`index.server.ts:159`,
  `public-scanner.server.ts:744`, `outbound-scanner.ts:1094`). No silent detection-weakening.
- **"Settings → General" is NOT stale** (ruled out the hunch): store contact details/name still live there; the
  "Store details" rename is a different org-level surface. The session's new contact strings are current.
- **New tests are genuinely behavioral** (`scan-fp-fixes.test.ts`, `public-scanner-fp.test.ts` invoke the real
  modules with HTML/schema/product inputs; no source string-matching). 4 of 5 fixed checks have their real failure
  mode protected — the sole gap is the `hidden_fee` mixed-negation case (P1-1).
- **"Checks Passed"/"Skipped" KPI quirk** (passing INFO checks count as "Skipped") is **pre-existing** and unchanged
  by the session — no check moved buckets.
- **Baselines:** 329/329 tests pass; 43 typecheck errors (no new ones); CLI parses standalone.
