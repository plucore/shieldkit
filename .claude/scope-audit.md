# "View customer data" install consent — Source Audit

## Question

shieldkit-16 install consent shows:

> **View customer data** — Device and activity data, Geolocation, IP address, browser and operating system

`shopify.app.toml` does **not** declare `read_customers`, `read_customer_events`, or any `customer_*` scope. Where is this disclosure coming from?

## Audit

### `[access_scopes]` (shopify.app.toml)
```
read_products, read_content, read_legal_policies, write_products,
read_shipping, read_locations, read_themes, write_themes
```
None of these are customer-data scopes. ✅ clean.

### Webhook subscriptions (shopify.app.toml)
- `app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, `products/create+update`, `themes/update+publish` — all app/store events, no implicit customer-data grant.
- GDPR mandatory: `customer_data_request`, `customer_deletion`, `shop_deletion` — these are **mandatory privacy webhooks every app must declare**. They do NOT grant customer-data access; they oblige the app to handle GDPR requests if the merchant ever asks. Shopify does not surface these as "customer data access" on the consent screen.

### Theme extension (`extensions/json-ld-schema/`)
- `shopify.extension.toml` declares blocks only (theme app extension type). No scope declarations possible at the extension level for theme apps.
- Liquid templates render server-side via Shopify's theme engine — they don't trigger app-level consent.
- ✅ clean.

### Cron handlers (`api.cron.weekly-scan.ts`, `api.cron.weekly-digest.ts`, `api.cron.monthly-reset.ts`)
- All bearer-token authenticated against `CRON_SECRET`. Not part of OAuth consent flow.
- The data they touch (scans, violations, digests) is store-owned data, not customer PII.
- ✅ clean.

### **App Proxy (`[app_proxy]` block in shopify.app.toml + `api.proxy.llms-txt.ts`)**

This is the source. **🚨**

```toml
[app_proxy]
url = "https://shieldkit.vercel.app/api/proxy/llms-txt"
prefix = "apps"
subpath = "llms-txt"
```

When an app declares an App Proxy, Shopify's install consent screen automatically discloses that the app may receive request metadata from store visitors — because proxy traffic is forwarded from the merchant's storefront through Shopify to the app's server. The metadata Shopify lists is exactly what the consent text shows: device/activity data, geolocation (Shopify forwards `Shop-Currency` etc. but more importantly the visitor's IP-derived geo), IP address, browser/OS (User-Agent).

This is **the proxy itself, not anything we coded**. Shopify treats incoming proxy requests as "customer data flowing to the app" because they originate from store visitors. The consent prompt is auto-generated whenever `[app_proxy]` is present in the toml.

Confirmation in our code: `api.proxy.llms-txt.ts` actually does receive and log this exact data:
- Line 71–77: `llms_txt_requests` insert writes `user_agent`, `crawler_name`, `ip_hash` (last octet stripped, then SHA-256).
- The proxy receives the visitor IP, UA, geolocation hints from Shopify on every request to `/apps/llms-txt`.

## Verdict

The "View customer data" prompt is **expected and unavoidable as long as App Proxy is declared**. It is not a misconfiguration. The shown data classes (Device/Geo/IP/UA) match the actual request metadata Shopify forwards through the proxy.

**Do not remove `[app_proxy]`.** It powers the Shield Max llms.txt feature (`/apps/llms-txt` → `api.proxy.llms-txt.ts`). Removing it kills that feature for every Shield Max merchant.

## What this means for privacy policy + listing copy

1. **Privacy policy must disclose** that we receive IP, user agent, geolocation, browser/OS data from storefront visitors who hit `/apps/llms-txt`, and that we store a hashed (truncated-then-SHA256) IP plus full UA + identified crawler name in the `llms_txt_requests` table.
2. **Listing screenshot showing the consent prompt** is correct — no need to "fix" it. Optionally we can mention in the listing description that the customer-data disclosure refers to the App Proxy used for the optional llms.txt feature.
3. **GDPR posture remains unchanged.** Truncated/hashed IPs are not directly personally identifying; we don't link them to a merchant's customer records. `customers/data_request` and `customers/redact` still legitimately return 200 because we don't tie this data to identified customers.

## Recommendation

- **Keep** `[app_proxy]` as-is.
- **Update** `privacy.tsx` to disclose llms.txt request metadata logging (handled in TASK 4).
- **No toml changes needed.**

## Sanity-check sources

- Shopify App Proxy docs (`shopify.dev/docs/apps/online-store/app-proxies`) describe the request metadata Shopify forwards: shop, path, signature, plus the visitor's IP and UA at the HTTP layer.
- Shopify's "Protected customer data" framework (`shopify.dev/docs/apps/launch/protected-customer-data`) classifies the same set of fields (IP, UA, device class, geolocation) as Level 1 protected data when received through the storefront — which is what App Proxy delivers.
