/**
 * app/routes/privacy.tsx
 * Route: /privacy  (public)
 *
 * ShieldKit privacy policy. Plain HTML / inline CSS, no Polaris dependency
 * since this renders to public visitors and Shopify reviewers, not embedded
 * merchants.
 */

import type { HeadersFunction } from "react-router";

import { SITE } from "../lib/brand";

// Cache the privacy policy at Vercel's edge for 24h, stale-while-revalidate
// for 7 days. The page changes only on legal review, which is rare enough
// that 7 days of staleness is acceptable. Cuts Fast Origin Transfer.
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800",
});

export const meta = () => {
  const title = "Privacy Policy — ShieldKit";
  const description =
    "How ShieldKit collects, stores, and handles data from connected Shopify stores.";
  const url = SITE.url + "/privacy";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: url },
    { property: "og:image", content: SITE.url + SITE.ogImage },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

export default function Privacy() {
  return (
    <div
      style={{
        maxWidth: "720px",
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        color: "#202223",
        lineHeight: 1.65,
      }}
    >
      <h1 style={{ fontSize: "32px", fontWeight: 700, margin: "0 0 24px" }}>
        Privacy Policy
      </h1>

      <p>
        ShieldKit is a Shopify Embedded App that scans Shopify stores for Google
        Merchant Center compliance issues and surfaces AI-search visibility
        tools. This policy describes what data ShieldKit collects, how we use
        it, who we share it with, and how merchants can request deletion. Plain
        English first, then specifics.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Who runs ShieldKit
      </h2>
      <p>
        ShieldKit is built by Plucore. Questions about this policy or your data
        can go to <a href="mailto:hello@shieldkit.app">hello@shieldkit.app</a>.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Shopify scopes we request
      </h2>
      <p>
        ShieldKit follows the principle of least privilege. The exact scopes
        requested at install are:
      </p>
      <ul>
        <li>
          <code>read_products</code> — read product titles, descriptions,
          variants, images, and metafields to run compliance checks (data
          quality, image hosting, structured data).
        </li>
        <li>
          <code>write_products</code> — used <strong>only</strong> on Shield
          Max to write GTIN, MPN, and brand metafields back to your products
          via the GTIN/MPN/Brand Auto-Filler. We never modify product titles,
          descriptions, prices, inventory, or images.
        </li>
        <li>
          <code>read_content</code> — read your shop's pages and blog content
          (e.g. About, Contact pages) to run the contact-information and
          business-identity-consistency checks.
        </li>
        <li>
          <code>read_legal_policies</code> — read your published refund,
          shipping, privacy, and terms policies to run policy-completeness
          checks.
        </li>
        <li>
          <code>read_themes</code>, <code>write_themes</code> — read theme
          structure for the JSON-LD schema theme-app-extension and (Shield
          Max) install schema blocks. We do not modify theme template files
          beyond adding/removing our own app blocks.
        </li>
        <li>
          <code>read_shipping</code>, <code>read_locations</code> — read
          shipping zones and store locations to run the shipping-policy check
          and contact-information check.
        </li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        About the "View customer data" install prompt
      </h2>
      <p>
        At install, Shopify shows a "View customer data" disclosure listing
        device and activity data, geolocation, IP address, browser, and
        operating system. Shopify auto-generates this disclosure because
        ShieldKit declares an <strong>App Proxy</strong> (the{" "}
        <code>/apps/llms-txt</code> endpoint that powers the optional Shield
        Max llms.txt feature). When a storefront visitor (or an AI crawler)
        requests <code>/apps/llms-txt</code>, Shopify forwards the request to
        ShieldKit's server along with the visitor's IP, User-Agent, and other
        HTTP request metadata. This is what Shopify is disclosing.
      </p>
      <p>
        We do <strong>not</strong> request <code>read_customers</code>,{" "}
        <code>read_orders</code>, or any other order/customer scope. We never
        receive your customers' names, emails, addresses, order history, or
        payment details. The "customer data" referenced in the prompt is the
        request metadata described in the next section.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Data we collect
      </h2>
      <p>
        When you install ShieldKit on your Shopify store, we collect and store:
      </p>
      <ul>
        <li>
          <strong>Shopify OAuth tokens.</strong> Encrypted with AES-256-GCM
          before being written to our database. Used solely to make Shopify
          Admin API calls on your store's behalf.
        </li>
        <li>
          <strong>Shop metadata.</strong> Domain, shop name, billing address
          country, currency, primary locale — read from the Shopify Admin API
          at scan time so we can run compliance checks against your store's
          configuration.
        </li>
        <li>
          <strong>Public storefront pages.</strong> During a compliance scan
          we fetch your store's homepage, up to three product pages, the cart
          page, and pages referenced by your published policies. We parse the
          HTML to detect compliance signals (payment icons, structured data,
          contact info). We retain the parsed signals as part of the scan
          record; we do not retain full page HTML.
        </li>
        <li>
          <strong>Scan results.</strong> Compliance scores, individual check
          results, the URLs we fetched, parsed signals, and any violation
          details we surfaced. Linked to your shop ID.
        </li>
        <li>
          <strong>Billing state.</strong> Plan tier, billing cycle, Shopify
          subscription identifier, subscription start time. We do not see or
          store credit card details — Shopify handles all payment data via
          Shopify Managed Pricing.
        </li>
        <li>
          <strong>Merchant-supplied content.</strong> Anything you type into
          the app: AI-policy-generator inputs, GMC re-review appeal letter
          inputs, Pro settings (logo URL, support email, social URLs,
          search URL template) stored in <code>pro_settings</code>, AI bot
          allow/block preferences.
        </li>
        <li>
          <strong>AI-generated artifacts.</strong> The HTML store policies
          and appeal letters Claude generates for you, stored alongside your
          merchant record so you can return to them later.
        </li>
        <li>
          <strong>Schema enrichment audit log (paid plans).</strong> When the
          GTIN/MPN/Brand Auto-Filler writes metafields to your products, we
          log which product and which fields were written for diagnostic
          purposes.
        </li>
        <li>
          <strong>Lead email.</strong> The shop owner's email address (read
          from <code>shop.email</code> via the Shopify Admin API) is stored
          once at first scan in our <code>leads</code> table to send the
          weekly health digest and (rarely) product update emails.
        </li>
        <li>
          <strong>App Proxy request logs (llms.txt endpoint only).</strong>{" "}
          When a storefront visitor or AI crawler requests{" "}
          <code>/apps/llms-txt</code>, we log the request's User-Agent, the
          identified crawler name (if recognised), and a privacy-preserving
          IP hash. The IP is truncated before hashing — for IPv4 we drop the
          last octet, for IPv6 we drop the last 64 bits — so the hash
          identifies a /24 or /64 network rather than a specific household.
          We never receive the visitor's name, email, or any identifying
          information beyond what their browser sends in HTTP headers.
        </li>
      </ul>

      <p>
        ShieldKit does <strong>not</strong> read your store's customer
        records, order history, addresses, or payment data. The Shopify
        scopes we request do not grant access to those resources. The GDPR{" "}
        <code>customers/data_request</code> and{" "}
        <code>customers/redact</code> webhooks return HTTP 200 immediately
        because we have nothing to return or delete.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        How we use the data
      </h2>
      <ul>
        <li>Run the 12-point compliance scan and generate fix instructions.</li>
        <li>
          Generate AI-assisted store policies and GMC appeal letters using
          Anthropic's Claude API. Inputs you provide are sent to Anthropic's
          API for inference; we do not retain them after the response is
          returned beyond the database row that stores the generated artifact.
        </li>
        <li>
          Run the GTIN/MPN/Brand Auto-Filler (paid plan) — write
          identifier metafields back to your products to satisfy Google
          Merchant Center's identifier requirements.
        </li>
        <li>
          Serve a cached llms.txt file at <code>/apps/llms-txt</code> for
          paid merchants so AI search agents can discover your products and
          policies. Requests to this endpoint are logged as described in
          "Data we collect" above.
        </li>
        <li>
          Submit the merchant's public storefront URL (and product page URLs)
          to Google's PageSpeed Insights API for the mobile performance check.
        </li>
        <li>Operate the app: authentication, billing reconciliation, error logging.</li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Data we share
      </h2>
      <p>
        We do not sell, rent, or share your data with third parties for
        marketing or any commercial purpose. The only third parties that touch
        your data are infrastructure subprocessors required to run the app:
      </p>
      <ul>
        <li>
          <strong>Supabase</strong> — primary database (PostgreSQL). All scan
          results, billing state, and encrypted OAuth tokens live here.
        </li>
        <li>
          <strong>Vercel</strong> — application hosting and Cron job execution.
        </li>
        <li>
          <strong>Anthropic</strong> — Claude API for AI policy generation and
          appeal letter drafting. Inputs you provide for these features are
          sent to Anthropic for inference.
        </li>
        <li>
          <strong>Resend</strong> — transactional email delivery for the
          weekly health digest.
        </li>
        <li>
          <strong>Google PageSpeed Insights</strong> — public storefront URLs
          are submitted to Google's PageSpeed API as part of compliance check
          #9. No private store data is sent.
        </li>
        <li>
          <strong>Shopify</strong> — for billing, webhooks, and the Admin API
          calls that drive the scanner.
        </li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Data retention
      </h2>
      <p>
        We retain data for as long as the app remains installed on your shop.
      </p>
      <ul>
        <li>
          When you uninstall ShieldKit, your Shopify session is deleted
          immediately and your merchant row is soft-deleted (marked with an
          <code>uninstalled_at</code> timestamp). Scans, violations, digest
          history, and webhook audit logs are kept for the 48-hour window
          Shopify gives merchants to reinstall before the GDPR{" "}
          <code>shop/redact</code> webhook fires.
        </li>
        <li>
          When the <code>shop/redact</code> webhook fires (typically 48 hours after
          uninstall), we hard-delete your merchant row and everything that
          cascades: scans, violations, billing history, Pro settings,
          digest email logs, AI-generated artifacts, schema enrichment
          records, and llms.txt request logs.
        </li>
        <li>
          App Proxy request logs (<code>llms_txt_requests</code>) for shops
          that uninstall are deleted in the same cascade. For shops that
          remain installed, we retain these logs indefinitely so the weekly
          digest can show you which AI crawlers have read your llms.txt.
        </li>
        <li>
          Database backups are retained for 7 days by Supabase. After 7 days
          a deleted record is gone from backups too.
        </li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Your rights
      </h2>
      <ul>
        <li>
          <strong>Access:</strong> request a copy of the data we hold about
          your store by emailing <a href="mailto:hello@shieldkit.app">hello@shieldkit.app</a>.
        </li>
        <li>
          <strong>Deletion:</strong> uninstall the app — within 48 hours
          everything is hard-deleted by the Shopify <code>shop/redact</code> webhook.
          You can also email us to request immediate deletion.
        </li>
        <li>
          <strong>Correction:</strong> most settings are editable inside the
          app. For data you can't edit yourself (e.g. cached scan history),
          email us.
        </li>
        <li>
          <strong>GDPR / CCPA / UK GDPR:</strong> the rights above apply to
          residents of the EEA, UK, and California. Contact us at the email
          above to exercise them.
        </li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Security
      </h2>
      <p>
        Shopify OAuth tokens are encrypted at rest with AES-256-GCM before
        being written to the database. Database access uses Supabase's service
        role key, scoped server-side; the key never reaches the browser.
        Application traffic is HTTPS-only. We follow the principle of least
        privilege when requesting Shopify API scopes — see your store's
        Apps & sales channels page for the exact scopes ShieldKit requests.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Changes to this policy
      </h2>
      <p>
        We update this page when our practices change. Material changes will
        be highlighted in the app or via a one-time email to your shop owner
        address.
      </p>

      <footer
        style={{
          marginTop: "48px",
          paddingTop: "24px",
          borderTop: "1px solid #e1e3e5",
          fontSize: "13px",
          color: "#6d7175",
          display: "flex",
          gap: "16px",
        }}
      >
        <a href="/" style={{ color: "#6d7175", textDecoration: "underline" }}>
          Home
        </a>
        <a href="/terms" style={{ color: "#6d7175", textDecoration: "underline" }}>
          Terms
        </a>
        <span>© ShieldKit</span>
      </footer>
    </div>
  );
}
