# Vercel Hobby usage investigation — 2026-07-28

Read-only. No code, config, or deployment changes were made.

Measurements come from the Vercel usage dashboard (read directly this session), Supabase, git history,
and the Shopify/Vercel docs. Where something is inferred rather than measured, it says so.

---

## 0. The headline: you are not currently over anything, and the thing that fixed it was not on your list

**Current cycle (Jun 28 – Jul 28, essentially complete), team-wide across all 9 projects:**

| Resource | Used | Hobby allowance | % | Rank |
|---|---|---|---|---|
| **Fluid Active CPU** | **2h 28m** | 4h | **62%** | **1** |
| Edge Requests | 219K | 1M | 22% | 2 |
| Fast Origin Transfer | 1.6 GB | 10 GB | 16% | 3 |
| Function Invocations | 93K | 1M | 9.3% | 4 |
| ISR Reads | 78K | 1M | 7.8% | 5 |
| Fluid Provisioned Memory | 27.5 GB-Hrs | 360 GB-Hrs | 7.6% | 6 |
| Fast Data Transfer | 7.36 GB | 100 GB | 7.4% | 7 |
| Image Transformations | 72 | 5,000 | 1.4% | 8 |
| Edge Request CPU Duration | 25s | 1h | 0.7% | 9 |
| Cron Job Invocations | 429 | (no stated cap) | — | — |

Only one resource is even close: **Fluid Active CPU at 62%**. Nothing else is above 22%.

**Two allowances to correct in your list:** Fast Origin Transfer (10 GB/mo) is a real limit you did not
list, and it is one of the two you actually blew. "1M edge requests" and the rest check out against what
the dashboard displays inline.

### It was a spike, and it is over

ShieldKit alone, derived as (3-month total Apr 28–Jul 28) − (last 30 days):

| Resource | May + June (2 months) | Monthly allowance | Peak monthly % |
|---|---|---|---|
| Function Invocations | **~1,036,000** | 1M | **~104% in a single month** |
| Edge Requests | ~1,070,000 | 1M | ~107% |
| **Fluid Active CPU** | **~10h 01m** | 4h | **~250%** |
| Fast Origin Transfer | ~18.6 GB | 10 GB | ~186% |
| Fluid Provisioned Memory | ~319 GB-Hrs | 360 GB-Hrs | ~89% |

That is your "repeatedly exhausts my limits" — and it was **one project (ShieldKit) on four resources at
once**, in May–June.

**The weekly invocation curve** (ShieldKit, from the dashboard chart; 1,050,200 successful + 441 errors
over the 3 months):

```
May 4   ~40K
May 11  ~140K
May 18  ~137K
May 25  ~118K
Jun 1   ~112K
Jun 8   ~110K
Jun 15  ~210K   <-- peak
Jun 22  ~152K
Jun 29  ~5K     <-- collapse, ~97% drop
Jul 6   ~2K
Jul 13  ~6K
Jul 20  ~4K
Jul 27  ~1K
```

**The collapse is in the week of Jun 29.** Two changes land immediately before it, and I cannot fully
separate them from the data alone:

- `288329f` (2026-06-11) moved `products/*` from an app-level subscription to per-shop paid-only. Note
  the commit date is **not** the effective date: a `shopify.app.toml` change only takes effect when
  `shopify app deploy` runs, and the on-disk `.shopify/deploy-bundle` is stamped **Jun 27 14:08** —
  which matches the collapse exactly. This is the better-supported cause by an order of magnitude of
  volume.
- `138d4aa` (2026-06-26) turned off `expiringOfflineAccessTokens`.

I initially read the collapse as the auth fix. The volume evidence says otherwise — see H1 below. The
operational lesson stands either way: **committing a toml change does nothing; deploying it does.**

### Per-project attribution (current cycle)

Function invocations, last 30 days:

| Project | Invocations | Share |
|---|---|---|
| **grepiq** | 52,042 | **56.1%** |
| beacon | 18,975 | 20.5% |
| **shieldkit** | 14,234 | **15.3%** |
| anvil | 7,287 | 7.9% |
| formaldraft | 75 | 0.1% |
| grep-staging | 70 | 0.1% |
| chowscan-web | 35 | 0.0% |
| plucore-website, expatclear | ~0 | ~0% |

**ShieldKit is only 15% of invocations but 52% of Active CPU** (1h 17m of the team's 2h 28m). Derived:

```
ShieldKit    : 4,620s CPU / 14,234 invocations = 325 ms Active CPU per invocation
Other 8 apps : 4,260s CPU / 78,766 invocations =  54 ms Active CPU per invocation
                                                  ---> ShieldKit costs 6.0x more per invocation
```

That ratio is the single most useful number in this report. ShieldKit ships **one 1.1 MB serverless
bundle** that every dynamic route boots. At today's low volume almost every invocation is a cold start,
so per-invocation cost is dominated by module init, not by the work.

For contrast, during the May–June flood ShieldKit averaged **38.7 ms/invocation** — the same bundle,
but warm, because volume kept containers alive. **Cutting invocations further has diminishing returns on
CPU**; below a certain volume you just pay cold-start on each survivor.

> **Log-retention caveat, stated explicitly as you asked.** Vercel Hobby retains runtime logs for roughly
> **one hour**. A sub-agent verified this directly: `since=1h` and `since=3h` returned byte-identical
> results. Any `get_runtime_logs` query over a wider window silently returns only the last hour, and a
> low count there is **not** evidence of low traffic. Worse, the hour we could see was mostly our own
> diagnostic requests. **No traffic figure in this report comes from runtime logs** — all volume comes
> from the billing dashboard and Supabase.

---

## 1. Hypotheses, tested

### H1 — products/* webhooks were the dominant invocation source — **CONFIRMED, and worse than the log shows**

The `enrichment_webhook_log` **understates** the flood, because the logging was removed before the
traffic was.

- `697907b` (2026-05-20 08:31:40 UTC) deleted `logOutcome()` from the four deterministic skip branches,
  including `skip_tier` — 85% of all May rows.
- The app-level subscription kept firing until the **Jun 27 deploy**.
- The daily series shows the cliff precisely: **2026-05-19 = 30,213 rows → 2026-05-20 = 4,905 → May 21–25
  = zero**. Nothing about the traffic changed on May 20. Only the logging did.

That leaves a **~22.5-day dark window** of unchanged free-tier delivery flood writing zero rows,
worth an estimated **550,000–700,000 invocations**.

**It was concentrated, not broad.** In May, 3 free shops produced 217,139 of 220,812 rows (98.3%), and
**`tbgypsysoul.myshopify.com` alone produced 177,510 (80.4%) at ~16,747/day** — one free store running a
sync app. That is why per-shop paid-only took it to zero: there are only 2 paid merchants.

Reconciliation of the ~1.09M May+June invocations:

| Component | Estimate |
|---|---|
| Logged webhook deliveries | 221,334 |
| Dark-window unlogged deliveries | 550,000–700,000 |
| Bots / marketing / public surface | 10,000–50,000 |
| Crons + app usage + other webhooks | ~10,000 |
| **Unexplained residual** | **~100,000–300,000** ← see H6 |

Confirmed: `ensureProductWebhooks` registers **both** `products/create` and `products/update`, both
pointed at the single `/webhooks/products/update` handler.

**Four early-return branches are invisible in the log and still cost a full invocation** — `!merchant`
(:203), `uninstalled_at` (:211), `!hasPaidAccess` (:229), missing scope (:234). All four return 200
without logging.

### H2 — retry amplification — **mechanism CONFIRMED, magnitude NOT, sub-mechanism REFUTED**

Every non-2xx path is inside `authenticate.webhook()`. With `expiringOfflineAccessTokens` on
(2026-02-26 → 2026-06-26), `ensureOfflineTokenIsNotExpired` called `refreshToken()`, whose catch block
either rethrows or `throw new Response(500)` — either way a 5xx, triggering Shopify's 19-retry / 48h
ladder.

**New measured fact:** surviving `sessions` rows show `refresh_token_expires − expires` = 90 days minus
1 hour. Working back, the offline **access token was valid for ONE HOUR**. So `isExpired(5min)` was true
for the majority of deliveries during that window — a far more aggressive footprint than assumed.

**But the specific trigger the earlier audit named is refuted:** `merchants.uninstalled_at IS NOT NULL`
= 0 all-time and `webhook_failures` = 0 all-time. There were no uninstalled shops in May–June to produce
`invalid_subject_token`. And Shopify deletes a shop's webhook subscriptions on token revoke, so an
uninstalled shop stops receiving `products/*` entirely.

**Best estimate: a 1.0–1.3x second-order multiplier, not the story.** Today it is ~1.0 — the current
cycle's 9,129 log rows plus a ~163/day baseline reconciles to the measured 14,000 invocations with no
room for retry inflation.

**This is not resolvable from code or the DB** — the throw happens before the first `logOutcome()`, so a
failed delivery is structurally unloggable. To settle it: Partner Dashboard → Apps → ShieldKit →
Monitoring → the Webhooks card, widest range available. A success rate below ~95% on `products/update`
would promote H2; above ~99% closes it.

> **Reliability note (not cost):** `ensureValidOfflineSession` ran for **every** topic, so `shop/redact`,
> `customers/redact` and `customers/data_request` were all exposed to the same 500-then-retry path for
> four months. Shopify does not retry `shop/redact` on 5xx. With zero uninstalls in the period nothing
> was actually lost — but that was luck. Closed since 2026-06-26.

### H3 — bot/crawler traffic on public routes — **largely REFUTED**

The 2026-07-09 fixes are in place and working. Critically, **`/` is genuinely CDN-cached** — verified
`x-vercel-cache: HIT`. The 28K edge : 14K function ratio is not a cache-miss problem; it is webhooks
(1 edge : 1 function, no static fan-out) plus cached static assets.

**Do not prerender `/`.** Vercel serves a static file regardless of query string, which would break the
`?shop=` → `/app` embedded redirect. The current query-string cache key is exactly what makes both work.

**One correction to `react-router.config.ts` and CLAUDE.md:** `/sitemap.xml` and `/llms.txt` are listed
as prerendered but are in fact **function-backed with a 1-hour CDN TTL**. Low volume, so low cost — but
the comment claiming they are static is wrong.

The only public route with a confirmed 100% miss rate is **`/scan`**, which has no `headers` export at all.

### H4 — `__manifest` requests — **REFUTED**

Edge-cached; ~0.7% of invocations with zero I/O. The prior reading of it as the "top path" in the logs
counted `cache=HIT` rows that ran no function at all.

### H5 — the drainer I just made heavier — **REFUTED, and your arithmetic is billed to the wrong meter**

Your figure — 5 × 45s × 30 = 1.875h = 47% of the 4h cap — is **arithmetically correct but measures wall
clock**. Fluid Active CPU **excludes I/O wait**, and the drainer is almost pure I/O: Supabase SELECT,
Shopify GraphQL round-trips, Supabase upserts. No cheerio, no HTML parsing.

| Meter | PR #12 adds | % of allowance |
|---|---|---|
| Fluid Active CPU | ~2–6 min/month | **1.0–2.4%** of 4h |
| Fluid Provisioned Memory | ~3.2–4.3 GB-Hrs/month | **~0.9–1.2%** of 360 |
| Function Invocations | **0** (the 89 cron invocations were already billed — they were just 405-ing) | 0% |

Per-row work is 2–6 ms of real CPU; cold start is 300–800 ms; so a 45s invocation is **500–1,400 ms of
Active CPU**, i.e. 1–3% of its wall clock.

**Merge PR #12 on cost grounds. Do not move the drainer off Vercel — that is premature by 20–50x.**
The right trigger to revisit is **throughput**, not billing: at ~500 rows/day drained vs 286/day inbound,
roughly two more merchants with catalogs like `sex-eshop`'s and the queue goes permanently net-positive
with no Hobby-legal cadence able to fix it. **Track inbound rows/day, not GB-Hrs.**

### H6 — the surprise you asked for: an unbounded revalidation loop, live on main right now

`app/routes/app._index.tsx:968-971`:

```ts
useEffect(() => {
  if (jsonLdFetcher.state !== "idle" || !jsonLdFetcher.data) return;
  revalidator.revalidate();
}, [jsonLdFetcher.state, jsonLdFetcher.data, revalidator]);
```

There is no fired-once guard, and `revalidator` is in the dependency array. I verified the library
behaviour rather than assuming it — `node_modules/react-router/dist/development/chunk-D6LUOGOQ.js:7614`:

```js
return React3.useMemo(
  () => ({ revalidate, state: state.revalidation }),
  [revalidate, state.revalidation]
);
```

`state.revalidation` cycles idle → loading → idle on every revalidation, so **the memo returns a new
object identity each time, the dependency array changes, and the effect re-fires.** The fetcher is still
`idle` with data still set, so the guard does not stop it. It calls `revalidate()` again. Forever.

Each iteration is one `/app.data` request = **one Vercel function invocation + ~14 Supabase queries**
(root loader + `app.tsx` tier query + ~12 in `app._index`). At a conservative 500 ms round trip that is
**~2 req/s ≈ 7,200 invocations per hour, per open tab**. One merchant leaving the dashboard open for a
workday ≈ 57,600 invocations — 5.8% of the entire monthly team allowance from a single tab.

**Trigger:** clicking "Enable JSON-LD" on the dashboard aside card — a **free-tier** surface, i.e. 52 of
your 54 merchants. Introduced `23cf403` (2026-05-28), still present today.

A second, conditional instance sits at `:958-963`: the self-heal effect loops the same way whenever
`selfHealFetcher.data.healed` is true, because `healed` stays true across re-renders. Paid-tier only, so
much rarer.

The toast effect at `:976-987` is **correctly** guarded by `toastId` state, and `scanViewedRef` at `:993`
and `selfHealFiredRef` at `:945` are the right pattern. The precedent for the fix already exists three
times in the same file.

**Confidence: HIGH that the loop is real** (verified in library source). **MEDIUM on historical
attribution** — it fits the ~100–300K unexplained residual in H1, and its introduction date (2026-05-28)
sits inside the surge, but the webhook flood is a competing and better-quantified explanation. Do not
attribute the historical spend to it without the 60-second browser check below.

**Verify in 60 seconds:** open the embedded dashboard on a free store, click Enable JSON-LD, watch
DevTools → Network for repeating `/app.data` requests.

---

## 2. Reduction options, ranked by (usage saved) ÷ (merchant risk)

| # | Option | Saves | Merchant risk | Effort |
|---|---|---|---|---|
| **1** | **Fix the revalidation loop** (H6) | Unbounded → 0. Removes the only mechanism that can blow the allowance from one tab. | **None** — it also *fixes* a sluggish dashboard | **~15 min** |
| **2** | **Replace `products/update` with a daily catalog reconcile**, keep `products/create` | **−9,014 invocations/cycle = −64% of ShieldKit invocations** | **None — it improves the product.** See below. | 1–2 days |
| **3** | `includeFields` **without `updated_at`** on the products subscription | Up to −58% of enrichment deliveries (upper bound; realistic ~30–57%) | Low | ~1 hour |
| **4** | Add a `headers` export to `app/routes/scan.tsx` | ~3–6% of invocations | None | ~10 min |
| **5** | Trim cold-start cost of the 1.1 MB bundle | Attacks the 325 ms/invocation figure directly — the only lever that helps once volume is already low | None | 0.5–1 day |
| **6** | Move webhook ingestion to Supabase Edge Functions (option D) | ~2.1K/mo today against a 1M allowance | Low, but a re-registration migration | ~1 day |
| **7** | ~~Move the drainer to GitHub Actions~~ (option C) | ~1% of invocations | **HIGH — reject** | — |

### On option 2 — this is the one that matters, and it is not a trade-off

The premise that enrichment is "almost always a no-op" is **refuted for July** (90.5% of processed
enrichments wrote all three metafields) but **confirmed for steady state**. What is actually happening:

- `products/update` is **98.4% of deliveries and 64% of all ShieldKit function invocations**.
- July saw 9,162 deliveries for only 3,861 distinct products — **2.37 deliveries per product**.
- And the queue it feeds is **15 days stale**.

So `products/update` is functioning as an accidental, 2.3x-redundant, badly-lagging catalog crawler.
A daily reconcile that pages 250 products at a time — pulling `variants{barcode,sku}` and
`metafields(namespace:"custom")` together so "does this need enrichment?" is decided without a
per-product round trip — is **both cheaper and fresher**. That last detail is a bigger saving than the
webhook reduction itself.

**Sequence it safely: build the reconcile, run both in parallel for one cycle, verify parity, then call
`removeProductWebhooks` for the UPDATE topic only.** Do not remove first.

### On option 3 — the one real Shopify-side lever

I had this checked against the live Admin GraphQL docs rather than from memory:

- **`filter` IS supported** for `products/update` on your API version — but it can only test *current
  payload values*, not "a source field changed". All 525 enriched products had both barcode and sku, so
  a filter would eliminate ~0 deliveries. **Near-worthless here**, and it carries silent-total-suppression
  risk.
- **`includeFields` does NOT reduce delivery count** — it reduces payload size. That helps Fast Origin
  Transfer, not invocations. Your instinct that A was the highest-value option was right in principle
  but wrong for this mechanism.
- **The exception, and the actual win:** omitting `updated_at` from `includeFields` triggers Shopify's
  **identical-payload debounce**, which *does* drop deliveries. Perfect debounce would collapse
  2.37 deliveries/product to 1.0 — **−5,301 deliveries, −38% of all ShieldKit invocations**. That is an
  upper bound; the window is short and undocumented for `products/*`, so bursts spread over hours will
  not collapse. Plan for ~30%.

### On option 7 — reject, and here is the reason you may not have considered

**Your repo is public** (`gh repo view` → `"visibility": "PUBLIC"`). Two consequences:

1. GitHub Actions is **unmetered** on public repos, so the 2,000-minute constraint you cited does not
   apply.
2. **GitHub Actions job logs are world-readable.** The drainer logs `shopify_domain` and `product_gid`,
   so your single paying merchant's store identity and catalog-edit activity would be published. And it
   requires a second copy of `TOKEN_ENCRYPTION_KEY` — the key that decrypts every merchant's offline
   Shopify token — in a public repo's secrets.

For a ~1% invocation saving, on a backlog that self-clears in ~7 days under PR #12 anyway. **No.** If you
ever revisit it, making the repo private is a precondition, not a nice-to-have.

### On option 6 — defer, with an explicit trigger

The analysis is sound and Supabase Edge Functions is the right target (5–7 DB round-trips per delivery,
so co-location wins; Workers' larger free tier is irrelevant at 238x headroom). HMAC verification ports
cleanly — HMAC-SHA256 of the raw body with `SHOPIFY_API_SECRET`, base64-compared against
`X-Shopify-Hmac-Sha256`, straightforward in Deno's Web Crypto.

But at ~2.1K deliveries/month against a 1M allowance it is not worth doing today, and the migration gets
harder linearly with paid-merchant count (every shop needs re-registering via `ensureProductWebhooks`).

**Trigger threshold: ~1,000 deliveries/day, or ~15 paid merchants, or 500K team invocations/month.**
Revisit at each upgrade.

### Option F — the September list

Nothing in D1–D9 materially increases Vercel usage.

- **D4 metadata backfill** and the **enrichment-log prune** both run as **local CLI scripts** — zero
  Vercel cost. Pull them forward freely.
- **D3** (test-charge gating) and **D5** (purchase dedupe) are neutral-to-reducing.
- **The one increase risk is D2** — if you approve a free-tier scan refill, that adds scan invocations,
  which are the most CPU-expensive thing in the app (~10–15s each, cheerio-bound). Sequence it *after*
  the reduction work and size it deliberately.

---

## 3. Recommended sequence

**This week (~1 hour total, all of it low-risk):**

1. **Verify and fix the revalidation loop.** 60-second browser check, then drop `revalidator` from both
   dependency arrays and add `useRef` fired-once guards matching the existing pattern at `:945` and
   `:993`. Highest value per byte in the entire backlog, and it is on no list anywhere.
2. **Merge PR #12.** It is ~1% of the CPU cap. But see the risk note below.
3. **Add a `headers` export to `app/routes/scan.tsx`.**
4. **Correct the prerender comment** in `react-router.config.ts` / CLAUDE.md re `/sitemap.xml` and
   `/llms.txt`.
5. **Check the Partner Dashboard webhook success rate** to close out H2. Two minutes, and it is the only
   place that number exists.

**Next two weeks:**

6. `includeFields` without `updated_at` (option 3) — cheap, reversible, ~30% of webhook deliveries.
7. Build the catalog reconcile (option 2), run it in parallel with `products/update` for one cycle,
   then drop the UPDATE subscription. **Remember to `shopify app deploy`** — a toml commit alone does
   nothing, which is the lesson of the Jun 11 → Jun 27 gap.

**Deferred, with triggers:**

8. Bundle cold-start trimming, when Active CPU next exceeds ~75%.
9. Supabase Edge Function ingestion, at ~1,000 deliveries/day or ~15 paid merchants.

### One risk introduced by PR #12 that is worth naming before you merge

`api.cron.reconcile-subscriptions` has **never executed** in production — it 405'd Vercel's GET since it
was written. PR #12 makes it run for the first time, and it is the only code path that demotes a merchant
tier. Its first run will evaluate every paid merchant against the Partner API. Given one of your two
"paid" rows is your own dev store with `shopify_subscription_id IS NULL`, it will be skipped by the
`.not("shopify_subscription_id", "is", null)` filter — so nothing should be demoted incorrectly. Worth
watching the first run's response body regardless.

---

## 4. Do-nothing baseline

**At the current burn you do not hit a limit.** Active CPU lands at ~62% of the 4h cap; second place is
Edge Requests at 22%. Extrapolating the current cycle forward with no changes, nothing crosses 100%.

**What would change that, in order of likelihood:**

1. **One merchant leaving the dashboard open after clicking Enable JSON-LD.** ~7,200 invocations/hour.
   Eight hours = 5.8% of the monthly team allowance. Three such days in a month and Active CPU is gone.
   This is the only mechanism currently capable of blowing an allowance without warning, and it needs no
   growth to fire.
2. **One more `tbgypsysoul`-shaped merchant upgrading to paid.** That single store generated
   ~16,747 deliveries/day. Two of those on a paid plan = ~1M invocations/month on their own, and unlike
   May the per-shop subscription means paid merchants are *supposed* to get them.
3. **Queue saturation.** At 500/day drained vs 286/day inbound you have ~214/day of headroom. Two more
   catalog-heavy paying merchants and the queue goes permanently net-positive, and no Hobby-legal cron
   cadence fixes it. That is a *product* failure (stale enrichment) before it is a billing one.

**What breaks when you do hit a limit:** Hobby enforcement pauses **all** functions across the team, so
plucore.com, chowscan.com, shieldkit.app and anvil.shieldkit.app all go down together — including the
GDPR webhooks, which Shopify does not retry for `shop/redact`. The blast radius argument for fixing #1
this week is stronger than the cost argument.

**The one number to watch:** inbound rows/day into `pending_scan_triggers`. It is the leading indicator
for both the throughput wall and the invocation wall, and it is a one-line query:

```sql
SELECT count(*) FILTER (WHERE trigger_at >= now() - interval '1 day') AS inbound_24h,
       count(*) FILTER (WHERE processed_at IS NULL)                   AS backlog
FROM pending_scan_triggers;
```
