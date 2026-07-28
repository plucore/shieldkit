# Block 4 — catalog reconcile parity gate

**Status: awaiting approval. `removeProductWebhooks` has NOT been called.**
Nothing is switched off. The reconcile ran in `observe` mode, which writes nothing
anywhere, in parallel with the live `products/create` + `products/update`
subscriptions. Written 2026-07-28.

---

## 1. The comparison

Six production runs, one per (shop × window). `observe` mode, every walk complete
(`truncated: false`).

| shop | window | pages | products walked | reconcile needs work | webhook log rows read | webhook saw (distinct) | **agreed** | webhook-only | webhook-only reasons | reconcile-only | **unexplained** | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sex-eshop | 7d | 31 | 7,685 | 6,661 | 4,250 | 2,941 | **2,173** | 768 | `already_complete: 768` | 4,488 | **0** | pass |
| sex-eshop | 24h | 31 | 7,685 | 6,661 | 829 | 659 | **130** | 529 | `already_complete: 529` | 6,531 | **0** | pass |
| 9973f3-3 (Wanok) | 7d | 7 | 1,650 | 1,650 | 0 | 0 | 0 | 0 | — | 1,650 | **0** | pass |
| 9973f3-3 (Wanok) | 24h | 7 | 1,650 | 1,650 | 0 | 0 | 0 | 0 | — | 1,650 | **0** | pass |
| shieldkit-test-stor | 7d | 1 | 17 | 0 | 0 | 0 | 0 | 0 | — | 0 | **0** | pass |
| shieldkit-test-stor | 24h | 1 | 17 | 0 | 0 | 0 | 0 | 0 | — | 0 | **0** | pass |

**Same products found: yes, in the direction that matters.** Of the 2,941 distinct
products `products/*` discovered for sex-eshop over 7 days, the reconcile flags
2,173 as needing work and accounts for all 768 of the rest. **Zero products the
webhook path found are missed by the reconcile.**

**Same enrichment decisions: yes, by construction.** Both paths now call one
function, `app/lib/enrichment/enrichment-decision.server.ts`. The per-product
enricher no longer carries its own copy of the rules (a test asserts the old
inline rules are gone). Had each kept its own implementation, agreement would
have been coincidence — the exact failure mode of the 2026-07 scan incident,
where three drifted copies of the same detectors fabricated criticals.

### Independent verification of the divergence

I did **not** take my own classifier's word for the 768. A separate script
re-reads a sample using the *drainer's* per-product query — the one that actually
performs the write — so a bug in the shared decision path would surface as a
disagreement rather than be reproduced:

```
webhook_saw(7d)=2941  catalog=7685  reconcile_needs=6661
agreed=2173  webhook_only=768  not_in_catalog=0

independent re-read of 30 webhook-only products (drainer's own query):
  confirmed nothing to write = 30
  CONTRADICTED               = 0
  product no longer exists   = 0
```

`webhook_saw=2941` matches a direct SQL `count(DISTINCT product_id)` exactly.

---

## 2. Every divergence, explained

**webhook-only — 768 products (7d).** Edited in the window, reconcile says no
work. All 768 classified `already_complete`; 30/30 sampled independently confirm
nothing left to write. These are pure waste today: each cost a serverless
invocation, an HMAC verification, two Supabase reads, a queue row, and then a
per-product Admin API round trip in the drainer to discover there was nothing to
do. **768 of 2,941 = 26% of webhook-discovered products over 7 days; 529 of 659 =
80% over 24h.**

**reconcile-only — 4,488 products (sex-eshop, 7d) + 1,650 (Wanok).** Products
needing enrichment that nobody edited in the window, so the webhook path is
structurally blind to them. This is the coverage gap, and it is the main reason to
switch: over 7 days the webhooks surfaced 2,173 of the 6,661 products that need
work — **33%**. Over 24h, 130 of 6,661 — **2%**.

**not_in_walked_catalog — 0.** An earlier truncated run reported 78 of these. They
were entirely an artifact of the truncation, which is why a truncated walk is
graded `inconclusive_truncated_walk` and can never be `pass`.

---

## 3. Two findings from running this that change the picture

### 3a. Webhook discovery is currently delivering NOTHING for a paying merchant

`9973f3-3.myshopify.com` (Wanok Cosmetics) has **zero** `products/*` subscriptions
in Shopify, and zero rows in `enrichment_webhook_log` — ever. They hold an active
$29/mo Monitoring subscription, have 1,650 products, and **all 1,650 need
enrichment**.

Cause: `ensureProductWebhooks` runs from `afterAuth`, `app.billing.confirm.tsx`,
and the daily `reconcile-subscriptions` cron. Wanok was wrongly demoted to `free`
by the superseded-subscription bug (§4a), so none of those provisioned them; the
tier restore was a DB write and does not itself provision webhooks. They will be
created at the next `reconcile-subscriptions` run (04:00 UTC).

This is not an argument I constructed — it is the failure mode the gate exists to
protect against, occurring on the *webhook* side. Webhook discovery depends on
per-shop provisioning that can fail silently for months. The reconcile needs only
a valid token.

Live subscription audit:

```
sex-eshop.myshopify.com     2 subscriptions  includeFields=[]  created 2026-07-12
9973f3-3.myshopify.com      0 subscriptions
shieldkit-test-stor         2 subscriptions  includeFields=[]  created 2026-06-27
```

### 3b. Correction to the Block 2 verification date

`includeFields` on both live subscriptions is still `[]`, not `["id"]`. The
narrowing is applied by `ensureProductWebhooks`, which for existing merchants runs
only from `reconcile-subscriptions` (daily 04:00 UTC) — and that has not run since
the Block 2 deploy at ~18:00 UTC today.

So the 48h delivery-count window starts at **2026-07-29 04:00 UTC**, not at the
deploy. I said I would report at 2026-07-30 ~18:00 UTC; the correct date is
**2026-07-31 ~04:00 UTC**. Reporting earlier would measure un-narrowed
subscriptions and tell us nothing about the debounce hypothesis.

---

## 4. The one genuine regression, stated plainly

**Webhook discovery is event-latency. Reconcile discovery is cycle-latency.**

A merchant who edits a barcode today is discovered within seconds. After the
switch they are discovered on the next reconcile pass — worst case ~6h at the
proposed GitHub Actions cadence. Nothing reads these metafields in real time (they
feed the JSON-LD theme block and the GMC feed), so ~6h is very likely acceptable —
but it is a real reduction and the decision is yours, not mine.

Given §3a, the honest comparison is not "seconds vs 6h". It is "seconds when
provisioning happened to work, never when it did not, vs ~6h always".

---

## 5. Before enqueue mode is switched on: the queue would flood

The reconcile finds **8,311** products needing work across the two paying
merchants (6,661 + 1,650). Current drain capacity is ~750 rows/day
(`BATCH_SIZE=150` × 4 GitHub Actions runs, measured at ~275ms/row).

Drainer state right now, as the baseline for the post-switch check:

```
backlog             2,893   (2,874 enrichment + 19 legacy)
oldest unprocessed  2026-07-15 21:45 UTC
drained_24h           560
inbound_24h            88
```

An uncapped first `enqueue` pass would add 8,311 rows to a 2,893-row backlog — ~15
days to clear, and the "backlog trends to zero" success criterion would be
meaningless for a fortnight. `enqueueCap` defaults to 500/pass for exactly this
reason, which paces new discovery to roughly the drain rate.

**Recommendation for the switch, if you approve it:**

1. Turn on `mode=enqueue` at the default cap and let the backlog burn down first.
   Keep `products/*` running — the two paths are idempotent against each other
   (the reconcile dedups against both `schema_enrichments` and unprocessed queue
   rows).
2. Only once the backlog is near zero, call `removeProductWebhooks` for
   `PRODUCTS_UPDATE` only, then `shopify app deploy`.
3. There is a much larger efficiency win available afterwards and deliberately not
   built yet: the reconcile already holds each product's variant and metafield
   data, so it could write via batched `metafieldsSet` (25 metafields/call, ~30
   calls per 250-product page) instead of the drainer's per-product round trip.
   That would collapse the ~275ms/row cost. I left it out because it changes
   *enforcement* as well as discovery, and this gate is only about discovery.

---

## 6. What I measured wrong, and corrected

**Query cost.** I expected `first: 250` with nested `variants` + `metafields` to
blow the calculated-cost limit and was wrong by roughly 40x. Measured:

| page shape | `first` | requested | actual |
|---|---|---|---|
| variants(1) + metafields connection | 250 | 112 | **79** |
| variants(1) + metafields connection | 60 | 82 | 66 |
| variants(1) + 4 singular metafields | 250 | 90 | 90 |

Against a 2,000-point bucket refilling at 100/s; the bucket never dropped below
1,888/2,000 across a full 31-page walk. 250/page is confirmed, not assumed. Cost
is not the constraint — **wall clock is**.

**The 60s ceiling.** The first production observe run took **57.7s** for three
merchants and truncated sex-eshop at 29 of 31 pages. My laptop finished the same
31 pages in 36.1s, so Vercel's iad1 round trip to Shopify is materially slower
(~1.42s/page vs ~1.16s). Fixed with an overall route budget, cheapest-catalog-first
ordering, an explicit `not_reached` list, and a raised per-shop budget for
single-shop calls.

**My own parity read was silently truncated.** PostgREST caps an unbounded
`.select()` at 1,000 rows. The first 7-day run reported `webhook_saw = 777` where
the table holds 4,250 matching rows / 2,941 distinct — and because `webhook_saw`
is the set the reconcile is checked *against*, the under-read made the gate look
**cleaner** than it was. Caught by cross-checking the route's output against SQL.
Now paginated, with `webhook_log_rows_read` in the output and an
`inconclusive_webhook_log_read_incomplete` verdict when a read is capped. The 24h
window (829 rows) sat under the cap, so that verdict was correct by luck.

**A classification bug, caught by writing the test.** My first version labelled a
product `already_complete` whenever all three keys were skipped — which mislabels
an un-enrichable product (no barcode, no SKU, no vendor, no shop-name fallback) as
finished. Now derived from the metafields actually set.

---

## 7. Reproducing this

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://shieldkit.vercel.app/api/cron/reconcile-catalog?mode=observe&shop=sex-eshop.myshopify.com&window_hours=168"
```

`mode` defaults to `observe`. Scheduled runs of
`.github/workflows/reconcile-catalog-observe.yml` are pinned to `observe`
unconditionally, so no default or input can turn the parallel run into a writer.
`enqueue` requires a manual dispatch — and your approval.
