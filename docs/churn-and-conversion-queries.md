# Churn & conversion runbook

Copy-paste queries for the two metrics that matter. Written 2026-07-28.

**Read this first — which source is authoritative for what:**

| Question | Source | Why not the other |
|---|---|---|
| When did a shop install? | `merchants.created_at` | **Never `installed_at`.** It was restamped on every token exchange until 2026-07-28. Backfilled to `created_at`, but `created_at` is the source of truth regardless. |
| Did a shop convert? | PostHog `purchase` ∪ `merchants.subscription_started_at` | The DB alone misses converters whose row was hard-deleted by `shop/redact`. |
| Did a shop churn? | PostHog `uninstall` (from 2026-07-28) → `install_events` (once live) | `merchants.uninstalled_at` is erased 48h later by the redact cascade. |
| Historical churn before 2026-07-28 | orphaned `leads` rows | Count only, no dates. Do not prune `leads` until `install_events` has replaced it. |

Two counting rules, both learned the hard way:

- **`purchase` double-fires.** `app.billing.confirm.tsx` is a *loader*, so any re-GET of the welcome link re-fires it. Both known converters have exactly 2 events ~30s apart. **Always `uniq(distinct_id)`, never `count()`.**
- **`install` over-fires on re-auth.** It lives in the same `afterAuth` body that used to clobber `installed_at`. De-noise by joining to `merchants.created_at`.

---

## 1. Monthly cohort churn curve (the one you asked for)

### 1a. HogQL — the live curve, from 2026-07-28 forward

Once the `uninstall` event has been shipping for a few weeks this is the whole answer in one query. Run it in PostHog → SQL.

```sql
WITH lifecycle AS (
    SELECT
        distinct_id                                                        AS shop,
        minIf(timestamp, event = 'install')                                AS installed_at,
        minIf(timestamp, event = 'uninstall')                              AS uninstalled_at,
        minIf(timestamp, event = 'purchase')                               AS purchased_at
    FROM events
    WHERE event IN ('install', 'uninstall', 'purchase')
      AND timestamp >= toDateTime('2026-06-27 00:00:00')   -- instrumentation start
    GROUP BY distinct_id
    -- min() over install de-noises the re-auth over-fire; min() over purchase
    -- collapses the loader double-fire. Both are why this is min(), not count().
)
SELECT
    toStartOfMonth(installed_at)                                           AS cohort_month,
    count()                                                                AS installs,
    countIf(purchased_at > toDateTime(0))                                  AS converted,
    countIf(uninstalled_at > toDateTime(0))                                AS churned,
    round(100.0 * countIf(uninstalled_at > toDateTime(0)) / count(), 1)    AS churn_pct,
    -- Median days from install to uninstall, churned shops only.
    round(medianIf(
        dateDiff('day', installed_at, uninstalled_at),
        uninstalled_at > toDateTime(0)
    ), 1)                                                                  AS median_days_to_churn
FROM lifecycle
WHERE installed_at > toDateTime(0)
GROUP BY cohort_month
ORDER BY cohort_month
```

### 1b. HogQL — retention triangle (survival by month-since-install)

The curve rather than the single number. Each cell is "% of that cohort still installed N months later".

```sql
WITH lifecycle AS (
    SELECT
        distinct_id                                        AS shop,
        minIf(timestamp, event = 'install')                AS installed_at,
        minIf(timestamp, event = 'uninstall')              AS uninstalled_at
    FROM events
    WHERE event IN ('install', 'uninstall')
      AND timestamp >= toDateTime('2026-06-27 00:00:00')
    GROUP BY distinct_id
    HAVING installed_at > toDateTime(0)
)
SELECT
    toStartOfMonth(installed_at) AS cohort_month,
    count()                      AS cohort_size,
    round(100.0 * countIf(uninstalled_at = toDateTime(0)
        OR dateDiff('day', installed_at, uninstalled_at) >= 30)  / count(), 1) AS pct_alive_d30,
    round(100.0 * countIf(uninstalled_at = toDateTime(0)
        OR dateDiff('day', installed_at, uninstalled_at) >= 60)  / count(), 1) AS pct_alive_d60,
    round(100.0 * countIf(uninstalled_at = toDateTime(0)
        OR dateDiff('day', installed_at, uninstalled_at) >= 90)  / count(), 1) AS pct_alive_d90
FROM lifecycle
GROUP BY cohort_month
ORDER BY cohort_month
```

> Cells where the cohort is younger than the window are structurally optimistic — a July cohort cannot yet have a real D90. Read `pct_alive_d90` only for cohorts at least 90 days old.

### 1c. Postgres — the same curve from `install_events`, once #5 is live

Preferred over HogQL long-term: it survives PostHog retention limits and joins to tier.

```sql
WITH lifecycle AS (
  SELECT
    shop_domain,
    min(occurred_at) FILTER (WHERE event_type = 'install')   AS installed_at,
    min(occurred_at) FILTER (WHERE event_type = 'uninstall') AS uninstalled_at,
    max(tier)        FILTER (WHERE event_type = 'uninstall') AS tier_at_churn
  FROM install_events
  GROUP BY shop_domain
)
SELECT
  date_trunc('month', installed_at)::date          AS cohort_month,
  count(*)                                         AS installs,
  count(uninstalled_at)                            AS churned,
  round(100.0 * count(uninstalled_at) / count(*), 1) AS churn_pct,
  count(*) FILTER (WHERE tier_at_churn IS NOT NULL
                     AND tier_at_churn <> 'free')  AS paid_churn,
  round(percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (uninstalled_at - installed_at)) / 86400
  )::numeric, 1)                                   AS median_days_to_churn
FROM lifecycle
WHERE installed_at IS NOT NULL
GROUP BY 1 ORDER BY 1;
```

---

## 2. Conversion — works today, no code change needed

### 2a. Postgres — survivor view (undercounts; misses deleted converters)

```sql
SELECT date_trunc('month', created_at)::date                       AS install_month,
       count(*)                                                    AS installs_surviving,
       count(*) FILTER (WHERE subscription_started_at IS NOT NULL) AS ever_paid
FROM merchants
GROUP BY 1 ORDER BY 1;
```

### 2b. HogQL — the correction that recovers deleted converters

```sql
SELECT uniq(distinct_id)                    AS shops_that_paid,
       arraySort(groupUniqArray(distinct_id)) AS which
FROM events
WHERE event = 'purchase'
  AND timestamp >= toDateTime('2026-06-27 00:00:00')
```

Subtract known non-customers before reporting: `shieldkit-test-stor.myshopify.com` is the dev store, and `cq3dar-gv.myshopify.com` is very likely a test charge (see the audit report).

---

## 3. Historical churn floor (pre-instrumentation)

`leads` has no FK to `merchants`, so it survived the redact cascade. An orphan row with a null `public_risk_score` is the authenticated install-path writer — meaning that shop installed, scanned, and its merchant row is now gone.

```sql
SELECT date_trunc('month', l.created_at)::date AS month_first_seen,
       count(*)                                AS confirmed_churned
FROM leads l
LEFT JOIN merchants m ON m.shopify_domain = l.shop_domain
WHERE m.id IS NULL
  AND l.shop_domain LIKE '%.myshopify.com'
  AND l.public_risk_score IS NULL
GROUP BY 1 ORDER BY 1;
```

A floor in two ways: it misses shops that churned without ever running an authenticated scan, and shops that uninstalled <48h ago. It yields no uninstall date.

---

## 4. Sanity checks worth keeping

```sql
-- installed_at must never drift from created_at again (expect 0 after the fix).
SELECT count(*) AS drifted
FROM merchants
WHERE installed_at > created_at + INTERVAL '2 seconds';

-- Enrichment backlog burn-down.
SELECT count(*) FILTER (WHERE processed_at IS NULL) AS backlog,
       min(trigger_at) FILTER (WHERE processed_at IS NULL) AS oldest,
       round(count(*) FILTER (WHERE processed_at >= now() - interval '1 day')/1.0, 0) AS drained_last_24h
FROM pending_scan_triggers;

-- Paid rows that reconcile-subscriptions can never demote (missing sub id).
SELECT shopify_domain, tier FROM merchants
WHERE tier <> 'free' AND shopify_subscription_id IS NULL;
```
