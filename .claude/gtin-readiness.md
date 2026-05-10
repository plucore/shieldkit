# GTIN Auto-Fill Readiness — shieldkit-16

## TL;DR

**Code: ready. Vercel env: needs one update before the feature actually runs.**

The `write_products` scope is now in `shopify.app.toml` access_scopes, but every gate in the codebase reads `process.env.SCOPES` (not the toml) at request time. Until the Vercel `SCOPES` env var includes `write_products`, the loader and webhook will continue to fall through scope-pending paths and the action will return HTTP 501.

## Audit Results

### `app/routes/app.gtin-fill.tsx`
- Line 37–38: `WRITE_METAFIELDS_SCOPE_ENABLED = (process.env.SCOPES ?? "").includes("write_products")` — derives from runtime env.
- Loader returns `scopeReady` to the UI; component renders a "scope pending" warning banner when false (lines 430–438) and disables both submit buttons (lines 503, 512).
- Action gate at lines 223–228 returns HTTP 501 with the "scope pending" message when `WRITE_METAFIELDS_SCOPE_ENABLED` is false.
- No other early returns or stale comments tied to scope status. Action logic from line 230 onward executes the real `metafieldsSet` mutation, batches at 25, persists `schema_enrichments` rows on success.

### `app/lib/enrichment/gtin-enrichment.server.ts`
- No `process.env.SCOPES` check inside the lib itself — the scope gate lives at the call site (the webhook). The lib fully writes metafields when invoked.
- No "scope pending" stubs or early returns.

### `app/routes/webhooks.products.update.tsx`
- Line 132–141: `if (!(process.env.SCOPES ?? "").includes("write_products"))` → logs `outcome: "skip_scope"` to `enrichment_webhook_log` and acks 200.
- Tier gate (line 122) requires `tier === "pro"`. 24h dedup against `schema_enrichments`. 3s safety budget.
- Phase 7.3 scan-trigger insert at line 119 runs **before** the scope/tier gates, so weekly-scan triggers continue working independently of GTIN enrichment status — good.

### Tests + build
- `npm test` → 121/121 passing.
- `npm run build` → succeeds (vite 6.4.2, server bundle 1099 kB).

## Is it ready to use on a dev store right now?

**Conditional yes — once the Vercel `SCOPES` env var is updated.**

Required to flip the feature live:

1. **Vercel env var.** Set `SCOPES=read_products,read_content,read_legal_policies,write_products,read_shipping,read_locations,read_themes,write_themes` in Vercel Production env (and Preview if you test there). Redeploy. **No code change needed.**
2. **Existing merchants must re-grant scope.** When `shopify.app.toml` access_scopes change and `shopify app deploy` ships them, existing installs are flagged stale by Shopify but **not auto-prompted**. Each merchant on shieldkit-16 will see the scope-grant consent the next time they open the app — they must click through it before write actions work for them. Until they do, the loader will see the old session scope string and the `metafieldsSet` mutation will fail with insufficient scope (the env-derived flag will say "ready" but the per-session token won't have it). The `app/scopes_update` webhook will fire once granted and update the session row.
3. **Dev store fresh installs** are simpler: install on a fresh dev shop after the toml deploy and the consent screen will include `write_products` from the first install.

## Exact UI test sequence

Pre-req: a dev store with at least one product that has either a SKU or a barcode but is missing `custom.gtin` / `custom.mpn` / `custom.brand` metafields.

1. **Confirm scope in Vercel env.** Open Vercel project → Settings → Environment Variables → confirm `SCOPES` includes `write_products`. If not, update + redeploy first.
2. **Install / re-auth on a dev store.** If shieldkit-16 is freshly deployed, install on a brand-new dev shop. If you're using an existing dev install, open `/app` once and accept the scope-grant consent screen.
3. **Upgrade to Shield Max.** GTIN fill is `tier='pro'` only. Use the in-app plan switcher → Shopify Managed Pricing → pick Shield Max. Wait ~5s for the `app_subscriptions/update` webhook to write `tier='pro'` to `merchants`. Reload `/app` to confirm the "Shield Max settings", "GTIN auto-filler", and "AI bot access" links appear in the side nav.
4. **Open `/app/gtin-fill`.** Expected: no warning banner ("write_products scope pending" should be **absent**), product count > 0, both "Auto-Fill identifiers" and "Mark no identifier exists" buttons enabled.
5. **Click "Auto-Fill identifiers".** Expected: button shows loading state → success banner "Wrote metafields for N products". Behind the scenes: `metafieldsSet` mutation in batches of 25, `schema_enrichments` rows upserted.
6. **Verify in Shopify admin.** Open one of the listed products → Metafields → confirm `custom.gtin`, `custom.mpn`, `custom.brand` are populated. GTIN should equal the variant barcode, MPN should equal the variant SKU, brand should equal vendor (or shop name as fallback).
7. **Verify continuous enrichment (Phase 7.1).** Edit a different product (one not yet enriched) in Shopify admin → save → Shopify fires `products/update`. Within ~3s the `enrichment_webhook_log` table should have an `outcome='enriched'` row for that product. Confirm via Supabase SQL editor:
   ```sql
   SELECT product_id, outcome, written_keys, error_message, inserted_at
   FROM enrichment_webhook_log
   ORDER BY inserted_at DESC LIMIT 10;
   ```

## Gotchas

- **Existing merchants will see "scope pending" for one session.** As above — toml scope changes don't auto-trigger a re-consent. Each existing install will hit the scope-grant prompt on next open. Until they accept, the in-product write fails with insufficient-scope errors even though `WRITE_METAFIELDS_SCOPE_ENABLED` is true.
- **Action gate uses env, but actual write uses session token.** `WRITE_METAFIELDS_SCOPE_ENABLED` is a build-time-ish boolean that reflects what the *app* asks for, not what an individual *merchant* has granted. There's no per-session check before calling `metafieldsSet`. If an old session lacks the scope, the mutation will return `userErrors` with an insufficient-scope message — the action handler does surface those errors via `actionData.errors`, but the UX is suboptimal (button looked enabled, then errors after submit). Worth a small follow-up: read session.scope at loader time and degrade UI for that specific merchant. Not a blocker.
- **Webhook safety budget is 3s.** A slow Admin API on the metafieldsSet round-trip will cause the webhook to log `outcome='error', errorMessage='timeout_3s'` and ack 200. Shopify won't retry. The next products/update for the same product (after the 24h dedup window) gets another shot. For backfill, the bulk route is the right tool, not webhooks.
- **Brand fallback chain.** Both bulk + webhook lib use vendor → shop.name. The `extensions/json-ld-schema/blocks/product-schema.liquid` adds an extra step at the front (`metafields.custom.brand` → vendor → shop.name). Once the Auto-Filler runs and writes `custom.brand`, the JSON-LD block will pick it up automatically — keep both call sites in sync if you change the order (already noted in CLAUDE.md §11).
- **Bulk route fetches up to 250 products** for the loader-side count and up to 500 (10 pages × 50) for the action. Stores with > 500 SKUs need multiple action runs. Acceptable for v1.
- **`pending_scan_triggers` insert runs even on free tier merchants** — wait, it doesn't (line 61: `if (opts.tier !== "shield" && opts.tier !== "pro") return;`). That's correct, no fix needed.

## Recommended follow-ups (not blockers)

- Per-session scope check in the loader so the UI accurately reflects what *this* merchant has granted, not what the app declares.
- Telemetry counter for `outcome='skip_scope'` in `enrichment_webhook_log` to track how many existing merchants haven't re-consented yet — informs whether to do an in-app re-consent nudge.
