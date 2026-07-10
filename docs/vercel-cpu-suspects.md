# Vercel Fluid Active CPU — Suspect Analysis

_Read-only investigation, 2026-07-09. Goal: replace inference with evidence for what consumes ShieldKit's Vercel Fluid **Active CPU** (Hobby tier, shared team pool; ShieldKit ≈ 4h52m of the team's ≈ 5h51m/cycle = 83%; Active CPU P75 = 88ms; cold-start rate ≈ 65% — these four are the user's dashboard readings, treated as MEASURED-by-user)._

Every claim below is tagged **MEASURED** (returned by a tool / build output / DB query / source line) or **INFERRED** (reasoned from code, not directly measured). Fluid bills **active CPU, not I/O wait** — so awaiting Shopify/Supabase/Anthropic/PageSpeed is cheap; cheerio parsing, full-document regex, and cold-start module evaluation are what cost.

---

## TL;DR — the bot-vs-scan question, answered with evidence

- **The compliance scan is NOT the dominant driver. REFUTED by measurement.** The heavy 10–15s scan ran **20 times in the last 30 days** (max 3/day, ~0.67/day avg; 101 all-time over 3½ months). Even at ~12s each that is ≈ 20 minutes of scan CPU across the entire history of the app. It cannot account for ~4h52m per billing cycle. _(MEASURED — Supabase, independently re-confirmed by me.)_
- **The most likely dominant consumer is fixed per-invocation cold-start cost on the single combined SSR function, driven by bot/crawler traffic to the public dynamic surface.** ShieldKit ships **one 1.1 MB serverless bundle** that handles every non-prerendered route; every cold hit — even `/robots.txt` — evaluates the whole graph (`Sentry.init()` + `shopifyApp()` + cheerio + Anthropic SDK + …). At a 65% cold-start rate, ~2 of 3 invocations pay that. Bots/scanners are the invocation source: a **338-occurrence 404 probe cluster** (plus 49 more) executes the function, and ordinary marketing paths log `cache=MISS`. _(Mechanism MEASURED; bot attribution INFERRED — see confidence note.)_
- **One latent worst-case hole:** the public `POST /scan` runs a full multi-page cheerio scan with **zero rate limiting**. Not currently measurably abused, but it is the highest-severity amplifier if a bot ever finds it.

**The MCP toolchain cannot measure per-route Active CPU.** Vercel's MCP exposes deployments, a short runtime-log buffer, and aggregated error clusters — **no CPU/invocation/GB-hr metrics**. So the *ranking* of bot-GET vs cold-start vs cron is INFERRED from code + circumstantial runtime signals; the split can only be confirmed in the Vercel dashboard (see §8b for the exact view).

---

## 1. Serverless entry-point inventory (TASK 1)

Routing is `flatRoutes()` (`app/routes.ts`). Every route is a **LIVE function unless prerendered**. Prerender list is `react-router.config.ts:44-54`. Build output confirms **one** server function: `build/server/nodejs_.../index.js`, **1.1 MB**, containing `runComplianceScan`, all crons, `Sentry.init`, `shopifyApp`, and `renderToPipeableStream` together. _(MEASURED — build dir present on disk; `du` = 1.1M.)_

Legend: **CPU** = cheerio/regex/render-bound · **I/O** = await-bound (cheap on Fluid) · **trivial** = tiny string/env work.

### Public / bot-exposable function routes
| Route | Live/Prerendered | Profile | Bot-reachable unauth? | Evidence |
|---|---|---|---|---|
| `/` (`_index/route.tsx`) | **LIVE** | **CPU** (full marketing SSR: Hero/FeatureGrid/Pricing/FAQ + 2 JSON-LD blobs; bots → `onAllReady` buffered render) | **Yes** | Excluded from prerender by design so loader can redirect `?shop` (`react-router.config.ts:41-43`, `_index/route.tsx:64`). `s-maxage=86400` set but does nothing on cold/cache-miss. |
| `/scan` (`scan.tsx`) | **LIVE** | GET trivial; **POST = CPU+I/O (runs a real scan)** | **Yes** | POST → `runPublicScan(rawUrl)` (`scan.tsx:85`). **No rate limit.** See §3. |
| `/sitemap.xml` | **LIVE** | trivial (in-mem string build) | **Yes** | `sitemap[.]xml.tsx:33`; `max-age=3600` (`:82`). No `public/sitemap.xml` exists → served by function. |
| `/robots.txt` | **LIVE** | trivial (8 constant lines) | **Yes** | `robots[.]txt.tsx:7`; `max-age=86400` (`:25`). No `public/robots.txt` → served by function. |
| `/llms.txt` | **LIVE** | trivial (in-mem string build) | **Yes** | `llms[.]txt.tsx:10`; `max-age=3600` (`:52`). Marketing llms.txt, distinct from the paid App Proxy. |
| `/auth/login`, `/auth/*` | **LIVE** | I/O (OAuth) | Yes (entry) | `login()` / `authenticate.admin` redirect. Network, not CPU. |
| `/explainer`, `/blog`, `/blog/:slug`, `/fix`, `/fix/:slug`, `/privacy`, `/terms` | **PRERENDERED** | none at runtime (CDN HTML) | Yes (static) | Prerender list `react-router.config.ts:45-52`. **Zero runtime function.** Not suspects. |

### Authenticated function routes (gated by `authenticate.admin` — App Bridge JWT)
All bounce to OAuth without a valid session, so **none is bot-reachable** and none runs its DB/GraphQL/Anthropic body drive-by. All are **I/O-dominated** except the `runScan` action.
| Route | Profile | Evidence |
|---|---|---|
| `app.tsx` layout | I/O (1 Supabase `tier` read) | `app.tsx:18,23` |
| `app._index` loader | I/O (up to ~9 Supabase reads, all awaits) | `app._index.tsx:80-296` |
| `app._index` action `runScan` | **CPU (the scan)** — but double-gated: admin JWT + `decrement_scan_quota` | `app._index.tsx:632,661`. Free = 1 lifetime scan; paid = manual click. |
| `app._index` action `generatePolicy` / `app.appeal-letter` | I/O (Anthropic await + AI credit) | `app._index.tsx:371,404`; `app.appeal-letter.tsx:237` |
| `app._index` action `selfHealBilling` | I/O (Partner API) — extra post-mount invocation, paid only | `app._index.tsx:537,889` |
| `app.gtin-fill` | I/O (up to 10 GraphQL pages + batched writes) | `app.gtin-fill.tsx:103-129` |
| `app.bots.toggle` / `app.pro-settings` / `app.plan-switcher` / `app.upgrade` | I/O (1–2 Supabase ops) | trivial CPU |

### API / App Proxy / cron / webhook function routes
| Endpoint | Auth | Profile | Unauth can force cold-start? | Heavy work before auth reject? |
|---|---|---|---|---|
| `POST /api/scan` | JWT first (`api.scan.ts:76`) | CPU on success (full scan); reject cheap | Yes | **No** — JWT check precedes rate-limit/quota/scan |
| `GET /apps/llms-txt` | App Proxy HMAC (`:174`) | I/O; cache dead across cold starts | Yes | No — HMAC first |
| `POST /api/cron/process-scan-triggers` | Bearer `CRON_SECRET` | I/O (GraphQL enrichment); **empty queue = 1 SELECT + return** | Yes | No |
| `POST /api/cron/reconcile-installs` | Bearer | I/O (probe/merchant, 500ms sleeps) | Yes | No |
| `POST /api/cron/reconcile-subscriptions` | Bearer | I/O (Partner API/merchant) | Yes | No |
| 7 × `webhooks.*` | HMAC first | I/O (`products/update` heaviest: dedup SELECTs + inserts) | Yes | No — HMAC precedes DB |

**Prime-suspect filter (public + live + non-trivial CPU):** `/` (CPU render) and `POST /scan` (CPU scan). Everything else public-live is either trivial (`/robots.txt`, `/sitemap.xml`, `/llms.txt` — cheap *per hit* but cold-start-taxed) or I/O (`/auth/*`). All authenticated CPU is session-gated. All API/webhook/cron endpoints are internet-facing (a bot can cold-start them) but do **no heavy work before rejecting** — the residual cost is the cold-start init itself, not the reject logic.

---

## 2. Public routes & the bot surface (TASK 2)

**Prerendered vs live — confirmed:** `/`, `/scan`, `/sitemap.xml`, `/robots.txt`, `/llms.txt` are **live functions** (not in the prerender list; no static files in `public/` — verified `ls public/` has no robots/sitemap/llms). `/` "stays dynamic" solely because its loader redirects `?shop` visitors to `/app` (`_index/route.tsx:64`) — the single line that blocks prerendering the whole marketing homepage. _(MEASURED — code + prerender list.)_

**Generation cost:** `/robots.txt` = 8 constant lines (effectively free). `/sitemap.xml` and `/llms.txt` = in-memory string builds over the content registries (`getAllPosts()` eager `import.meta.glob` + static `FIXES`), no DB, no fetch — cheap per hit. **Their only real cost is cold-start × crawler frequency**, because each hit boots the full 1.1 MB bundle. _(MEASURED code; cost characterization INFERRED.)_

**Edge deflection — coverage gap.** `vercel.json` 308-redirects **10** probe patterns: `/wp-admin/*`, `/wp-login.php`, `/wordpress/*`, `/wp/*`, `/.env`, `/.env.:ext`, `/.git/*`, `/xmlrpc.php`, `/phpmyadmin/*`, `/phpinfo.php`. Long-cache header only on 3 brand assets. _(MEASURED — `vercel.json`.)_

The measured probe traffic (§5) hits **many paths NOT covered**, so they fall through to the function and 404 through React Router:
`/.vscode/sftp.json`, `/@vite/env`, `/api/.env`, `/backend/.env`, `/app/.env`, `/config/.env`, `/.envrc`, `/.env~`, `/config.php`, `/wp-config.php.bak`, `/.svn/wc.db`, `/dump.sql`, `/database.sql`, `/backup.sql`, `/secrets.json`, `/docker-compose.yml`, `/web.config`, `/actuator/heapdump`, `/ss.php`, and crucially **nested** `.git`/`.env` (`/frontend/.git/config`, `/v3/.git/config`) — the current `/.git/:path*` rule only matches root-level. _(MEASURED — cross-referencing the error clusters against `vercel.json`.)_

---

## 3. Compliance scan cost & the public `/scan` hole (TASK 3)

### Authenticated scan (`runComplianceScan`, `index.server.ts:70`)
- **~9 network fetches:** 4 Shopify GraphQL + homepage + ≤3 product pages + `/cart` (hidden-fee) + Google PageSpeed (30s timeout). Almost all I/O (cheap on Fluid).
- **~10 `cheerio.load()` full-DOM parses** — the dominant active CPU. Checks do **not** share parsed DOM; `hidden_fee_detection` alone re-parses homepage + 3 products + cart (`hidden-fee-detection.server.ts:104`), on top of the parses already done by checkout/structured-data/accessibility.
- **`stripHtml()` = 9 regex passes over the whole document** (`helpers.server.ts:35`), called many times (per policy, per about-page, per hidden-fee page).
- **No catastrophic-backtracking regex found** — cost is volume × document size, not backtracking. _(INFERRED — pattern review.)_
- **Relative weight: ≈ 50–200× a trivial page hit.** _(INFERRED — order-of-magnitude.)_

### Public `/scan` (`runPublicScan`, `public-scanner.server.ts:687`)
- **Up to ~14 outbound fetches** against an **attacker-supplied URL** (8–10 homepage/policies/products with fallbacks + ≤3 product pages + PageSpeed). N is capped at 3 products (`.slice(0,3)`, `:730`).
- **~5 `cheerio.load()` + ~8 `stripHtml` passes.** Relative weight ≈ **30–100× a trivial hit.** _(INFERRED.)_
- **A single request can hold the function ~30s** — the PageSpeed `AbortSignal.timeout(30_000)` (`:605`).

### The protection asymmetry (MEASURED from code)
| Endpoint | Auth | Rate limit | Quota |
|---|---|---|---|
| `POST /api/scan` (authenticated) | JWT (`api.scan.ts:76`) | **10/hour/shop** (`rate-limiter.server.ts`, `api.scan.ts:80`) | atomic `decrement_scan_quota` |
| `POST /scan` (public) | **none** | **NONE** | **none** |

`scan.tsx:74-121` goes straight from `form.get("intent")` to `await runPublicScan(rawUrl)` (`:85`). No IP extraction, no `checkRateLimit`, no CSRF/origin/nonce, no CAPTCHA. The only guard is SSRF private-IP DNS validation (`public-scanner.server.ts:85-116`), which limits *targets*, not *volume or document size*. The cheaper-to-abuse, more-expensive-per-call endpoint is the **unprotected** one.

**Is it currently being abused? Not measurably.** Public scans aren't persisted to `scans`; the only DB trace is `leads.public_risk_score`, which `scan.tsx:105` **updates only for a pre-existing leads row** (no insert) — so it records almost nothing. `leads_with_public_risk_score = 1`, `leads_created_30d = 25` (a mixed floor for human scan+unlock completions). **Conclusion: `/scan` is a latent worst-case hole, not a proven-active driver.** _(MEASURED — DB + code; abuse status: absence-of-evidence, not evidence-of-absence, since the path is barely logged.)_

---

## 4. Crons — the steady-drip suspect (TASK 4)

_(MEASURED — `vercel.json` + `.github/workflows/process-scan-triggers.yml`.)_

| Endpoint | Vercel Cron | GitHub Actions | Invocations/day | Handler profile |
|---|---|---|---|---|
| `reconcile-installs` | daily 03:00 | — | **1** | I/O — GraphQL probe per merchant, 500ms sleeps (wait, not CPU) |
| `reconcile-subscriptions` | daily 04:00 | — | **1** | I/O — Partner API per paid merchant (only 2 paid) |
| `process-scan-triggers` | daily 12:00 | every 6h (4/day) | **5** | I/O — `BATCH_SIZE=10` GraphQL enrichment; **no cheerio/HTML parsing**; empty queue = 1 SELECT + return |
| **Total scheduled** | | | **7/day** | |

Crons are **not CPU-heavy and not frequent.** DB confirms near-zero work: 3 pending triggers in 30d (0 backlog), 6 `products/update` webhooks (all dedup-skipped), 0 webhook failures. The GitHub cadence was already cut `*/30 → 0 */6` (48→4/day) — a deployment commit message calls that "**the biggest single CPU win available**," i.e. the obvious cron lever is **already pulled**. 7 fixed invocations/day is negligible against bot volume. _(MEASURED — DB + commit message text; note the commit claim is the author's assertion, not an MCP metric.)_

> **Two stale-doc flags surfaced (not CPU issues, worth correcting):** (1) `BATCH_SIZE=10`, not 1 as CLAUDE.md §5/§15 and the task brief state (`api.cron.process-scan-triggers.ts:46`). (2) `products/update` still writes inert `product_update` trigger rows despite v4 retiring that path — harmless CPU-wise, cleanup candidate.

---

## 5. Runtime data (TASK 5)

### Vercel MCP — **no CPU/invocation metrics exist in the toolset** (MEASURED negative)
Project `shieldkit` (`prj_p5YOw7kBjID32AbaXJE8rSLhDDbI`), framework `react-router`, node `24.x`, latest prod deploy `dpl_8etutKGYWeFogPJRpyL3JvbP4wVD` READY (commit `340e55d`, 2026-07-08). `lambdaRuntimeStats: {"nodejs":1}`. Grep of the full 867-line error dump for `cpu|duration|invocation|memory|gb-hr|billed|compute|ms` → **zero matches.** The MCP surfaces deployments, a **short** runtime-log buffer, and error clusters (occurrence counts of *errors*, not invocations/CPU). **Active CPU by route is not reachable via MCP — only the dashboard has it.**

**`get_runtime_errors` — the standout signal (MEASURED):**
- Largest cluster: **338 occurrences**, HTTP 404 "No route matches URL", 44 users, first 2026-02-26 → last 2026-07-09, paths like `/frontend/.git/config`, `/.github/workflows/deploy.yml`, `/config.json`. Pure vuln/secret-scanner probes, each **executing the React Router function and unwinding a full error**.
- **49 more clusters** of the same shape: `/.vscode/sftp.json` (11), `/@vite/env` (8), `/api/.env` (6), `/backend/.env` (4), `/config.php` (3), `/wp-config.php.bak` (3), `/dump.sql` (3), `/.svn/wc.db` (3), `/.env~` (3), `/secrets.json` (2), `/docker-compose.yml` (2), … — dozens of paths **not** covered by the edge redirects.
- One app cluster: `POST "/" with no action` — 15 occurrences / 11 users (minor).

**`get_runtime_logs` — tiny buffer (~9 lines; `since=24h` == `since=7d`, MEASURED):** top paths `/`=5, `/app`=1, `/scan`=1, `/wp-admin/`=1, `/sitemap.xml`=1; **every logged hit is `cache=MISS` and executes the function**, including `/wp-admin/` (a bot probe that 404'd through React Router). User-agent strings are not exposed in the log payload.

> A prior deployment commit message states the team hit "**100% of Hobby Fluid Active CPU cap**" and that "free-tier installs were subscribed app-wide … **~20k wasted serverless invocations/day**" (since fixed). Author's words, not an MCP metric — but it establishes that *invocation floods*, not scans, have been the historical CPU story.

### Supabase — heavy paths are demonstrably idle (MEASURED, independently re-run by me)
| Metric | Value |
|---|---|
| Scans last 30d / 7d / all-time | **20 / 6 / 101** |
| Scans by day (30d) | 15 active days, **max 3/day**, mostly 1/day, **100% `manual`** (0 automated) |
| Merchants (total / active / paid) | 49 / 48 / **2 monitoring** (47 free) |
| llms.txt requests (all-time) | **0** |
| `products/update` webhooks (30d) | 6 — **all `skip_already_queued`** |
| pending_scan_triggers (30d) | 3 processed, **0 backlog** |
| webhook_failures / scan_rate_limits rows | **0 / 0** (`/api/scan` endpoint effectively unused) |

**What this bounds:** merchant-triggered heavy work is near-zero. Scans ≈ 20 min of CPU across 3½ months. Paid-only heavy paths (llms.txt, enrichment) have ~0 volume with only 2 paid merchants. The Active-CPU spend is therefore **not** demand-driven by merchant features.

### PostHog — **UNAVAILABLE, and structurally blind to bots anyway**
No PostHog query tool is executable this session (`render-ui` returns "not found"; no `event-definition`/HogQL/`web-analytics` tool exposed). Even if it were: PostHog is **client-side JS analytics**, and bots don't run JS — it **systematically undercounts exactly the traffic under investigation.** Good for human traffic shape, useless for bot volume. The authoritative instrument is server-side Vercel logs grouped by route. _(MEASURED — tool errors; caveat is definitional.)_

---

## 6. Ranked suspects by estimated Active-CPU contribution

Separated into the three buckets the investigation asked for. Rank is a best estimate given the MCP cannot supply per-route CPU.

### A. Public / bot-exposed function routes — **the dominant bucket (INFERRED)**
1. **Cold-start module-init of the single 1.1 MB bundle, paid on every dynamic invocation.** _(Mechanism MEASURED: single bundle; `Sentry.init()` unconditional at `sentry.server.ts:43`; `shopifyApp()` at module load; 65% cold-start rate. Attribution to bot volume INFERRED.)_ Every crawler GET to `/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, and every uncovered probe-path 404 boots the full graph. This is the "many short hits each paying cold-start tax" shape that matches P75 88ms + 65% cold starts.
2. **Bot-probe 404 flood through React Router** — 338 + 49 clusters, uncovered by edge redirects, each executing the function. _(MEASURED occurrence counts; CPU-per INFERRED.)_
3. **`/` full-tree SSR** on cold/cache-miss hits, worse for bots (`onAllReady` buffered render). _(Code MEASURED; frequency INFERRED.)_
4. **`POST /scan` (latent):** highest CPU-per-call, zero throttle — but no measured current volume. Ranked low *now*, but it is the top **risk**.

### B. Authenticated routes — **not a bulk driver (MEASURED-low)**
Session-gated, ~48 merchants, human-paced, I/O-dominated. The only CPU-heavy path (`runScan`) is quota-gated and ran 20×/30d. Not a contributor at scale.

### C. Cron / scheduled — **minor, already optimized (MEASURED)**
7 invocations/day, near-zero work, no HTML parsing. The big cron lever (GH cadence) is already pulled. Each is one more cold-start of the bundle, but the count is trivial vs bots.

---

## 7. Conclusions

### (a) Single most likely dominant consumer + confidence
**Fixed cold-start CPU on the one combined 1.1 MB SSR function, incurred across a high count of low-value invocations — predominantly bot/crawler/scanner traffic to the public dynamic surface (marketing `/`, resource routes, and uncovered 404 probe paths).** Not the compliance scan.

**Confidence: MEDIUM-HIGH on the mechanism, MEDIUM on the bot attribution.**
- HIGH-confidence, MEASURED: scans are far too rare to matter; a single fat bundle boots on every dynamic hit; `Sentry.init` + `shopifyApp` run at module load; 65% of invocations are cold; bot probes execute the function; marketing paths log `cache=MISS`.
- The residual uncertainty is the **split** between (i) bot-GET traffic to 200-returning routes, (ii) probe-404 traffic, and (iii) cold-starts of legitimate low-traffic hits. The MCP exposes **no per-route CPU/invocation counts**, so that split is INFERRED, not measured.

### (b) Exact dashboard view to confirm (the API/MCP can't give this)
In the Vercel dashboard, project **shieldkit**, set the time range to the **current billing cycle**, then:
1. **Observability → Functions/Routes, metric = "Active CPU" (or "CPU Time"), grouped/broken-down by _Route_ (or _Path_), sorted descending.** This directly ranks routes by the CPU you're paying for. Expect `/` and the resource routes near the top if the cold-start-tax thesis holds; a spike on `/scan` would flag abuse.
2. **Observability → Requests/Invocations, grouped by _Path_, sorted descending**, and add the **Cache (HIT/MISS)** and **User-Agent / Bot** dimensions if available. This is where bot volume becomes visible (probe paths, crawler UAs, MISS ratio). This is the view that resolves the bot-vs-legit split §7a leaves open.
3. **Usage → Active CPU** for the cycle total/trend, and **Firewall/Bot management analytics** (top bots, blocked vs allowed) if enabled.
> Note: on Hobby, granular Observability retention is short (roughly last 24h without Observability Plus). Sample across a full day — or add temporary structured logging keyed by `request.url` + `user-agent` and group in `get_runtime_logs` — to get a representative route/UA breakdown. The **Usage → Active CPU** total is available regardless.

### (c) Ranked mitigations — no Vercel upgrade required
Each tagged with the suspect it removes.

1. **Make the tiny resource routes static → they leave the SSR function entirely.** _[removes: cold-start tax on crawler-magnet paths — Suspect A1]_
   Add a static `public/robots.txt` (its loader emits 8 constant lines) and add `/sitemap.xml` + marketing `/llms.txt` to the `prerender()` list (pure build-time-deterministic string builds). Crawlers hit these constantly; today each boots the 1.1 MB bundle. **Highest value / lowest effort.**
2. **Widen edge deflection to the probe paths actually seen.** _[removes: bot-probe-404 cold-start tax — Suspect A2]_
   Extend `vercel.json` `redirects` (or add Vercel **Firewall** custom deny rules — a limited number are free on Hobby) to cover `**/.git/*`, `**/.env*`, `/.vscode/*`, `/.svn/*`, `*.sql`, `/config.php`, `/wp-config.php*`, `/secrets.json`, `/docker-compose.yml`, `/actuator/*`, `/@vite/*`, `/web.config`, etc. Prefer a **broad pattern / Firewall rule** over enumerating — the current root-only `/.git/*` misses nested probes. Probes then 308/403 at the edge and never cold-start the function.
3. **Rate-limit the public `POST /scan`.** _[removes: the worst-case CPU amplification hole — Suspect A4]_
   Key on client IP (`x-forwarded-for`) with a small per-IP/hour cap (reuse the `scan_rate_limits` pattern or an in-memory+DB limiter), and/or add a Cloudflare Turnstile / proof-of-work token. Cheap insurance against a currently-unmetered vector that runs ~5 cheerio parses + ~8 regex sweeps + up to a 30s hold per unauthenticated call on an attacker-sized document.
4. **Trim per-cold-start module-init CPU (helps all 65% of cold invocations).** _[removes: fixed cold-start tax across every route — Suspect A1]_
   (a) Early-return from `initSentry()` when `SENTRY_DSN` is unset — today it calls `Sentry.init({dsn: undefined})` unconditionally at `sentry.server.ts:43` on every cold start. (b) Lazy-`import()` the heavy, route-specific deps (cheerio, Anthropic SDK, posthog-node) inside their handlers so trivial routes don't parse/compile them on cold start. Lower per-hit magnitude, but multiplies across every cold start.
5. **Prerender the marketing `/`.** _[removes: full-tree homepage SSR on cold/uncached hits — Suspect A3]_
   Move the single `?shop` redirect out of the loader (edge `rewrite`/middleware) so the homepage can be prerendered to static HTML. Eliminates `renderToPipeableStream` (and the bot `onAllReady` penalty) on the highest-traffic public path. Medium effort.
6. **Marginal cron trimming (optional).** _[removes: a sliver of scheduled cold-starts — Suspect C]_
   The big lever is already pulled (48→4/day). Optionally drop the daily Vercel `process-scan-triggers` failsafe if GitHub Actions is reliable (−1/day), and stop writing inert `product_update` trigger rows. Low priority.

> **Do not** reach for a Vercel plan upgrade — the spend is structural (fat-bundle cold starts + un-deflected bots), and items 1–2 alone should move the needle materially without paying Vercel.

---

## Appendix — evidence provenance
- **MEASURED (DB, independently re-run):** scan/merchant/llms/webhook/trigger/rate-limit counts (§5) — Supabase project `bhnpcirhutczdorkhibm`, 2026-07-09.
- **MEASURED (Vercel MCP):** project/deploy metadata, error clusters (338 + 49), log-sample path tally, absence of CPU metrics (§5).
- **MEASURED (build/source):** single 1.1 MB bundle (`build/server/nodejs_*/index.js`), prerender list, `vercel.json` redirects, `BATCH_SIZE=10`, unconditional `Sentry.init`, no static `public/{robots,sitemap,llms}` — all re-checked on disk.
- **MEASURED (user-supplied dashboard readings):** 83% team share, P75 88ms, 65% cold-start rate.
- **INFERRED:** relative scan weights (50–200× / 30–100×), the bot-attribution of cold-start CPU, the route-level CPU ranking — because the MCP exposes no per-route Active-CPU metric. Confirm via §7b.
- **UNAVAILABLE:** PostHog query tools (and structurally bot-blind regardless).

_Read-only investigation. No source, config, or deployment changes were made; working tree left clean._
