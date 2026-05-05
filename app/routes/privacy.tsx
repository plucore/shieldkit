/**
 * app/routes/privacy.tsx
 * Route: /privacy  (public)
 *
 * ShieldKit privacy policy. Plain HTML / inline CSS, no Polaris dependency
 * since this renders to public visitors and Shopify reviewers, not embedded
 * merchants.
 */

const LAST_UPDATED = "May 5, 2026";

export const meta = () => [
  { title: "Privacy Policy — ShieldKit" },
  {
    name: "description",
    content:
      "How ShieldKit collects, stores, and handles data from connected Shopify stores.",
  },
];

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
      <p style={{ fontSize: "13px", color: "#6d7175", margin: "0 0 24px" }}>
        Last updated: {LAST_UPDATED}
      </p>
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
          <strong>Scan results.</strong> Compliance scores, individual check
          results, the URLs we fetched, the HTML snippets we analysed, and any
          violation details we surfaced. Linked to your shop ID.
        </li>
        <li>
          <strong>Billing state.</strong> Plan tier, billing cycle, Shopify
          subscription identifier, subscription start time. We do not see or
          store credit card details — Shopify handles all payment data.
        </li>
        <li>
          <strong>Merchant-supplied content.</strong> Anything you type into
          the app: AI-policy-generator inputs, GMC re-review appeal letter
          inputs, Shield Max settings (logo URL, social URLs, etc.), AI bot
          allow/block preferences.
        </li>
        <li>
          <strong>Lead email.</strong> The shop owner's email address (read
          from <code>shop.email</code> via the Shopify Admin API) is stored
          once at first scan to send the weekly health digest.
        </li>
      </ul>

      <p>
        ShieldKit does <strong>not</strong> collect or store any data about your
        store's <em>customers</em>. We do not read order data, customer profiles,
        addresses, or payment records. The GDPR <code>customers/data_request</code> and{" "}
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
        <li>Send the weekly health digest email when you're on a paid plan.</li>
        <li>
          Cache an llms.txt file for Shield Max merchants so AI search agents
          can discover your products and policies.
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
          <code>uninstalled_at</code> timestamp). Scans, violations, and
          digest history are kept for the 48-hour window Shopify gives
          merchants to reinstall before the GDPR <code>shop/redact</code> webhook
          fires.
        </li>
        <li>
          When the <code>shop/redact</code> webhook fires (typically 48 hours after
          uninstall), we hard-delete your merchant row and everything that
          cascades: scans, violations, billing history, Shield Max settings,
          digest email logs, and AI-generated artifacts.
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
        We update this page when our practices change. The "Last updated"
        date at the top reflects the most recent revision. Material changes
        will be highlighted in the app or via a one-time email to your shop
        owner address.
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
