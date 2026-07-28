# Why the paying customers left — post-mortem, 2026-07-28

Read-only analysis. No code changed. Sources: Shopify Partner API app-event history
(complete, paginated), Partner API `transactions`, and the surviving `scans` / `violations` /
`leads` rows in Supabase.

---

## 0. The answer, up front

**They did not leave because the product found nothing, and not because it found the wrong thing. It
told them their store had four Google-suspension-level failures that did not exist, then told them it
was fine, then told them it was broken again — sometimes 94 minutes apart, with no change to the
store.**

**And the defect is still live.** It stopped firing on 2026-06-28 because its trigger stopped, not
because it was fixed. Any future Shopify Admin API throttle, timeout, or token lapse reproduces it
exactly.

Second finding, almost as important: **the one merchant who used the product properly still cancelled**
— because compliance has a completion state. That is a business-model problem, not a bug.

---

## 1. Correcting the churn number first

"~80% churn on 6.6% conversion" is built on a miscount. The eight departures are not eight rejections.

| Shop | Plan | Tenure | How it ended | Money settled |
|---|---|---|---|---|
| `bybaanoo` | Shield Pro $14 | **5 min 21 s** | switched to Free immediately | $14 |
| `pro-truck-lift` | Shield Pro $14 → Shield Max $39 | **~14 h** | switched, then left | $53 |
| `kjzvkq-6q` | Monitoring $39 | **4.0 days** | cancelled | $39 |
| `hbhkfy-gy` | Monitoring $39 | **3.2 days** | cancelled | $39 |
| `cq3dar-gv` | Monitoring $29 | **6.2 days** | cancelled | $29 |
| `sbnjen-ee` | Shield Max $39 | **36 days** | downgraded to Free — **still using the app** | $39 |
| `0yzffh-vw` | Shield Max $39 | 21 days | **FROZEN**, never unfrozen | **$0** |
| `ygxib5-9s` | Monitoring Annual **$290** | 28 days | **FROZEN**, never unfrozen | **$0** |

Decomposed:

- **2 are plan-shopping artifacts.** `bybaanoo` held a paid plan for five minutes; `pro-truck-lift`
  moved Free → Shield Pro → Shield Max → Free inside 14 hours. These are pick-a-plan UI churn, not
  customer loss.
- **2 never paid at all.** `0yzffh-vw` and `ygxib5-9s` were FROZEN before their first renewal settled —
  a freeze is Shopify's shop-level or payment-level state, not a verdict on the product. Note
  `ygxib5-9s` committed to **$290 annual** and Shopify never collected it.
- **1 is a success that ended anyway.** `sbnjen-ee` — see §3.
- **3 are genuine product rejections**: `kjzvkq-6q`, `hbhkfy-gy`, `cq3dar-gv`. All three cancelled at
  **day 3–6** — after the first charge, before the second.

**Real product-rejection churn is 3 of 10, not 8.** The number that should worry you is not 80%; it is
that **every genuine cancellation happened in the first week**, which is a first-run-experience failure,
not a retention failure. Retention was never tested.

Revenue reconciliation (matches Partner API `transactions` exactly): $213 gross from subscriptions +
$87 from three legacy one-time $29 purchases = **$300.00 gross / $290.24 net, lifetime**.

---

## 2. The mechanism: the scanner fabricated four criticals

Only three of the eight still have `scans` rows (the other five were CASCADE-deleted by `shop/redact`).
All three show the same pathology.

**`ygxib5-9s` — paid $290/year on 2026-05-18:**

| Scan | Score | Criticals |
|---|---|---|
| 05-15 10:38 | 91.67 | 0 |
| 05-18 11:05 | 91.67 | 0 | ← subscribed this day |
| **05-19 17:15** | **58.33** | **4** | ← next day |
| 05-19 19:17 | 58.33 | 4 |
| 05-25 20:12 | 91.67 | 0 | ← fine again |
| **05-25 21:46** | **58.33** | **4** | ← **94 minutes later** |
| 05-26 01:26 / 05:44 | 58.33 | 4 |
| 06-06 04:35 | 91.67 | 1 |

**`0yzffh-vw` — subscribed 2026-05-12 while scoring 91.67:**

| Scan | Score | Criticals |
|---|---|---|
| 05-09 / 05-12 | 91.67 | 0 |
| **05-14** | **66.67** | **4** |
| 05-15 | 66.67 | 4 | ← last scan ever; they stopped using it |

**`sbnjen-ee`** oscillates the same way — six scans in 40 minutes on 05-09 scoring
75/75/75/66.67/58.33/75, and a 0-critical → 4-critical flip on 05-15 an hour and 37 minutes apart.

### It is always the same four checks

From the violations: `contact_information`, `privacy_and_terms`, `refund_return_policy`,
`shipping_policy`. Those are precisely the four that read **Shopify Settings → Policies through the
Admin API** (`getShopPolicies()`).

### Proof it is an API failure, not a store change

`critical_count = 4` is the **only** bucket in the whole dataset that co-occurs with an explicit
`shop_info_unavailable` marker:

| criticals | scans | with `shop_info_unavailable` |
|---|---|---|
| 0 | 60 | 0 |
| 1 | 27 | 0 |
| 2 | 7 | 0 |
| 3 | 4 | 0 |
| **4** | **17** | **9 (53%)** |

0 of 98 scans in every other bucket. Store policies do not vanish and reappear within 94 minutes.
**When the Admin API policy fetch failed, all four checks read "couldn't fetch" as "doesn't exist" and
reported critical.**

### The window, and an honest note on causation

The signature runs 2026-05-04 → 2026-05-30 (15 scans), then two on 06-27/06-28, then **nothing across
the 34 scans since**. Two changes bracket the end: `expiringOfflineAccessTokens` removed
(`138d4aa`, 2026-06-26 — offline tokens had a **1-hour** TTL, so Admin API calls mid-scan could 401 at
any moment) and the false-positive remediation (2026-07-09). The token fix is the better-fitting cause
and the timing is tight, but there is a quiet June gap and low scan volume, so I would call this
**strongly correlated, not isolated**. It does not change the remedy.

### The remedy is not in place

Verified in `app/lib/checks/index.server.ts:80-85`: `getShopPolicies()` is fetched in a `Promise.all`,
swallows its own failures and returns null, and **the scan does not abort or degrade**. The four policy
checks receive the empty result and report "Missing …" as critical. The only check anywhere that marks
itself skipped on missing shop data is `business-identity-consistency.server.ts:29`. There is no
"scan degraded" concept.

**So the bug that churned three paying customers is dormant, not fixed.**

---

## 3. The uncomfortable finding: the product completed its job

`sbnjen-ee` is the healthiest engagement in the entire dataset:

- 15 scans across three months, the most of any merchant
- score 60.00 → **83.33**
- every critical resolved; only two warnings remain (incomplete refund policy, vague shipping policy)
- used the AI policy generator
- **cancelled on 2026-06-14 — and ran another scan on 2026-07-17, a month later, as a free user**

They did not leave unhappy. They left *finished*. Compliance is a project with a completion state: you
fix your policies once, and the recurring value of "check again" is much lower than the value of "tell
me what's wrong."

That is the strategic problem behind the 3–6 day cancellations too. A merchant who buys to fix a
suspension, fixes it, and cancels is behaving rationally against the current value proposition.

---

## 4. What is recoverable, and what is not

**Recoverable for all 8:** exact tenure, plan, amount, and end-state (cancel vs freeze) from the Partner
API — its history is complete and independent of our DB. Settled money from `transactions`. First-seen
date and contact email from `leads` (no FK, so it survived the cascade).

**Lost for the 5 hard-deleted shops** (`bybaanoo`, `pro-truck-lift`, `kjzvkq-6q`, `hbhkfy-gy`,
`cq3dar-gv`): every scan, every violation, every score. `shop/redact` cascaded it 48h after uninstall.
So for the three genuine cancellations, **we cannot see what the product told them** — the strongest
evidence sits precisely where the data is gone. The three surviving cases are the only window, and all
three show the same defect.

That gap is itself the argument for the `install_events` ledger already drafted in
`supabase/migrations/20260728120000_install_events.sql`, and for retaining anonymised scan outcomes
beyond redact.

---

## 5. What to build next

Ranked by expected effect on the number that is actually broken — first-week trust.

**1. Never report a critical you could not verify.** The single highest-value change in this document.
Thread a `dataAvailable` flag from `getShopPolicies()` / `getShopInfo()` into the four policy checks; on
a failed fetch emit a non-scorable `info` ("We couldn't read your store policies — retried
automatically") and exclude it from the score, exactly as `page_speed` already degrades on timeout.
Add a scan-level `degraded` marker so a partial scan is never shown as a compliance verdict. Without
this, one Shopify throttle can tell your next paying customer their store is catastrophically broken.

**2. Retry the policy fetch before scoring.** `getShopPolicies` returning null is treated as fact. One
bounded retry would have prevented most of the 17 bad scans.

**3. Alert on an implausible score collapse.** A drop of >20 points or 0 → 4 criticals between
consecutive scans on the same store is almost certainly ours, not theirs. That is a Sentry message and
would have surfaced this in May.

**4. Then, and only then, the business-model question.** `sbnjen-ee` says the current offer is a
one-off job priced as a subscription. Options worth considering, in the order I would test them: keep
the subscription but make its recurring value real and visible (the automated re-scan that the blog
already promised and v4 deleted, with an actual notification when a regression appears); or sell the
fix as a one-time purchase — you already have three settled $29 one-time sales from the model you
retired in March, and they converted at the same price you now charge monthly.

**Do not start with pricing.** The 3–6 day cancellations happened while the product was intermittently
lying about their compliance. Fix the trust defect first, then measure retention on a cohort that saw a
product telling the truth. You have never had that measurement.

---

## 6. Open question I could not answer

For the three genuine cancellations, their scan history is gone, so I cannot confirm they saw the
4-critical flapping. It is likely — `kjzvkq-6q` (06-11 → 06-15) and `hbhkfy-gy` (06-17 → 06-21) both
fall inside the window when the token TTL was still live, and `cq3dar-gv` (07-07 → 07-13) falls just
after. Confirming it would need Vercel logs from those dates, which Hobby retained for one hour.
