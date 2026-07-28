# "Failed fetch read as a factual negative" — audit of the other four paths

Read-only audit, 2026-07-28. **No fixes applied.** Scoped deliberately to four paths.

The root defect, stated generally: **a fetch failure is converted into a factual negative that reaches
the merchant as a finding** — "we could not look" becomes "we looked and it is absent". It has been
fixed for `getShopPolicies` (an `available` flag, one bounded retry, orchestrator degradation to
non-scorable info). This audit asks whether the same shape exists elsewhere.

| Path | On-failure value | Reaches merchant as a finding? | Verdict |
|---|---|---|---|
| `getShopInfo()` | `null` | No — both consumers guard | **SAFE** |
| `fetchPublicPage()` | `null`, **and non-2xx returns normally — no `res.ok` check** | **Yes** — `warning` + 3 × `critical` on public/CLI | **MATCH** |
| PageSpeed | `notMeasured()` → `info`, `scorable:false` | No | **SAFE** (reference impl) |
| `getProducts()` / `getPages()` | `[]` | `getProducts` no; **`getPages` yes** | SAFE / **PARTIAL** |

`executeWithRetry` (`graphql-client.server.ts:246-285`) loops **only** on `extensions.code ===
"THROTTLED"`. Any other GraphQL `errors` body is returned to the caller, and a throw is never caught.
HTTP non-2xx throws at `graphql-client.server.ts:227-231`, so each Admin data function hits its own
`catch`.

---

## 1. MATCH, worst — the public `/scan` and the CLI still carry the ORIGINAL defect at critical severity

`public-scanner.server.ts:755-764` coerces the fetch with `?.status === 200 ? html : null`, collapsing
three different outcomes into one `null`:

- fetch returned `null` — timeout / DNS / network
- HTTP 404 — policy genuinely absent (the only case where `null` is honest)
- HTTP 429 / 503 / 403 bot-challenge — "we could not look"

With no retry, no `available` flag and no degradation anywhere in `runPublicScan`:

- `:265-278` → `passed:false`, **critical**, "Missing Shipping Policy"
- `:313-326` → `passed:false`, **critical**, "Missing Refund/Return Policy"
- `:365+` → `privacy_and_terms`, same shape

CLI mirrors it at `scripts/outbound-scanner.ts:1088-1090`, `:1125-1131`, feeding criticals at `:358-360`
and `:452-453`.

**Why this matters most:** `/scan` is the lead-generation funnel. It is the first number a prospect ever
sees, and against any Shopify storefront behind a rate-limiter or bot-challenge it is three fabricated
criticals wide. Public scans are not persisted to `violations`, so there is no historical count — this is
absence of evidence, not evidence of absence.

## 2. MATCH — `fetchPublicPage` → `storefront_accessibility`, and it has already fired

`helpers.server.ts:96-105` has **no `res.ok` check**, so a 503/403/429 returns `{status, html}` normally;
a timeout returns `null`, which the orchestrator flattens to `status: null`
(`index.server.ts:137-141`). `storefront-accessibility.server.ts:79` then conflates all three:

```ts
const failedPages = productPageResults.filter((r) => r.status !== 200);
```

`null !== 200` and `503 !== 200` are indistinguishable from an unpublished product. Result at `:89-106`:
`passed:false`, `severity:"warning"`, **scorable**, titled "Some Product Pages Aren't Loading".

**Confirmed live:** the only `storefront_accessibility` failure in 115 scans across 52 merchants was
`normae-shop.com` on 2026-04-20, caused by a **single HTTP 503** on one of three product pages — the
other two returned 200. The timeout variant is latent (0 recorded `status: null` cases); the transient-5xx
variant is proven.

Secondary: the pass branch prints "Storefront is publicly accessible (HTTP unknown)" (`:114`) when the
homepage was never fetched — asserting accessibility it did not observe.

## 3. PARTIAL — `getPages()` silently deletes the Page fallback, and the new retry WIDENS the gap

`getPages` returns `[]` on a GraphQL errors body (`shopify-api.server.ts:410-415`, then `edges=[]` →
`break` at `:430`) and on any throw (`:435-438`). No `available` flag.

`pages` is the **fallback source** for checks 2/3/4. With `pages: []`,
`refund-return-policy.server.ts:48` → `findPolicyPage([], …)` → `null` → `:63-79` `passed:false`,
**critical**:

> "No Refund/Return Policy was found in Settings → Policies **or as a Shopify Page**."

That sentence asserts a fact about Pages that were never fetched.

**This is a gap in the fix just shipped.** The degradation at `index.server.ts` keys solely off
`!shopPolicies.available`. `getShopPolicies` now retries once; `getPages` does not. A blip the policies
retry survives but `getPages` does not yields `available:true` + `pages:[]` → an **un-degraded critical**.
The retry is what opens the divergence.

**Blast radius, measured:** the silent-empty failure is frequent — all 9 `shop_info_unavailable` scans
also carried `total_products = 0`, i.e. the four Admin fetches fail *together* on one expired token.
Three merchants with real catalogs recorded false-zero product counts (`ygxib5-9s` 6 of 9 scans,
`sbnjen-ee` 2 of 15, `0yzffh-vw` 2 of 4). **But** only 1 merchant in 115 scans has ever resolved a policy
via the Page fallback, so today's realised exposure is ~1 merchant wide. A latent trap, not an active
fire — and in the whole-batch case `available:false` masks it.

## 4. Also a gap in the shipped fix — `hidden_fee_detection` reads `shopPolicies` but is not degraded

`hidden-fee-detection.server.ts:205-217` consumes `shopPolicies`, but the check sits in the **second**
batch in `index.server.ts:195-202`, and the degrade map only rewrites the first batch. With
`available:false`, `policyText` is empty, so every storefront fee mention becomes "undisclosed" →
`passed:false`, **critical**, "Undisclosed Fees Detected".

Not yet fired (the single historical critical, `ygxib5-9s` 2026-06-06, had both policies present), but it
is a live hole in the degradation that shipped today.

---

## Cleared

- **`getShopInfo()` — SAFE.** `null` on all four modes; both consumers guard (`contact_information`
  degraded to non-scorable info; `business-identity-consistency.server.ts:21-31` skips explicitly). Two
  nits: no bounded retry (asymmetric with `getShopPolicies`, unjustified given they fail together), and
  `:127-132` logs a GraphQL errors body without gating on it, so a *partial* `data.shop` returns non-null
  and the `!shopInfo` degrade never fires.
- **`getProducts()` — SAFE.** `[]` routes to free passes everywhere. Wrong direction (score inflation),
  never a fabricated finding.
- **PageSpeed — SAFE in all three surfaces.** `notMeasured()` with `scorable:false`. 10 not-measured
  results across 3 merchants since 2026-07-12, none moved a score. This is the reference implementation.

**Score-integrity nit spanning both SAFE paths:** `checkout-transparency.server.ts:25-39` and
`business-identity-consistency.server.ts:21-31` return `passed:true, info` on missing input but omit
`scorable:false`, so an unmeasurable signal is banked as a free point instead of excluded from both
sides. Contradicts the doctrine at `types.ts:18-27`. Direction is generous, not accusatory.

---

## Recommendation (decision is the owner's — nothing applied)

Ordered by merchant-facing harm:

1. **Public `/scan` + CLI policy fetch** — the original defect, unfixed, at critical severity, on the
   lead-gen funnel. Distinguish 404 from 429/503/timeout and degrade the latter.
2. **`storefront_accessibility`** — separate "not 200" into "unpublished" (a finding) vs "we could not
   reach it" (non-scorable info). Add the missing `res.ok` check in `fetchPublicPage`.
3. **`getPages` availability flag** — mirror the `getShopPolicies` treatment, or the retry asymmetry keeps
   the un-degraded-critical window open.
4. **Move `hidden_fee_detection` under the degrade map**, or pass it an availability flag.
5. Cheap hygiene: add `scorable:false` to the two "missing input → info" branches.
