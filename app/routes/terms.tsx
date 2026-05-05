/**
 * app/routes/terms.tsx
 * Route: /terms  (public)
 *
 * ShieldKit terms of service.
 */

const LAST_UPDATED = "May 5, 2026";

export const meta = () => [
  { title: "Terms of Service — ShieldKit" },
  {
    name: "description",
    content:
      "Terms of service for the ShieldKit Shopify app — eligibility, billing, acceptable use, and warranties.",
  },
];

export default function Terms() {
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
        Terms of Service
      </h1>

      <p>
        Welcome to ShieldKit. By installing the ShieldKit Shopify app on your
        store, you agree to these terms. If you don't agree, uninstall the
        app — that's the cleanest way to opt out.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        The service
      </h2>
      <p>
        ShieldKit is a B2B SaaS Shopify Embedded App that scans Shopify stores
        for Google Merchant Center compliance issues, generates fix
        instructions, and provides AI-search visibility tools (Merchant
        Listings JSON-LD enrichment, llms.txt, AI bot allow/block controls).
        ShieldKit is not affiliated with, endorsed by, or sponsored by Google
        or Shopify.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Eligibility
      </h2>
      <p>
        You must be the merchant of record for the Shopify store you install
        ShieldKit on, or have explicit authorisation from that merchant.
        ShieldKit is for legitimate businesses only — no use with stores
        engaged in fraud, illegal goods, or other policy violations.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Plans and billing
      </h2>
      <ul>
        <li>
          <strong>Free</strong> — one compliance scan per 30 days, plus the
          JSON-LD theme extension, plus fix instructions for surfaced findings.
        </li>
        <li>
          <strong>Shield Pro</strong> — $14 / month or $140 / year. Unlimited
          scans, continuous weekly monitoring, weekly health digest email,
          AI policy generator, GMC re-review appeal letter, hidden fee
          detection, image hosting audit.
        </li>
        <li>
          <strong>Shield Max</strong> — $39 / month or $390 / year. Everything
          in Shield Pro, plus Merchant Listings JSON-LD enrichment, GTIN /
          MPN / brand auto-filler, Organization & WebSite schema blocks,
          llms.txt at the App Proxy URL, AI bot allow/block toggle, the
          dedicated Shield Max settings page.
        </li>
      </ul>
      <p>
        All paid plans are billed by Shopify under their App Subscriptions
        billing API. Charges appear on your Shopify invoice. Annual plans are
        billed up front. Recurring charges renew automatically until you
        cancel via the in-app plan switcher (or by uninstalling the app).
      </p>
      <p>
        Plan switches are prorated automatically by Shopify. Cancellations
        take effect immediately: paid features stop, and your account
        returns to the Free plan with one fresh scan available.
      </p>
      <p>
        Refunds: ShieldKit does not issue refunds for partial billing
        periods, but Shopify's proration handles cancellations and downgrades
        cleanly. If you believe you were charged in error, email{" "}
        <a href="mailto:hello@shieldkit.app">hello@shieldkit.app</a> within 14
        days and we'll work with Shopify to resolve it.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        AI-generated content
      </h2>
      <p>
        Several ShieldKit features use Anthropic's Claude API to generate
        text — store policies, GMC appeal letters, and other drafts. AI
        outputs are starting points, not finished legal documents.
      </p>
      <ul>
        <li>
          <strong>Review before publishing.</strong> Read every AI-generated
          policy before pasting it into your store. AI may produce inaccurate
          or jurisdiction-inappropriate language.
        </li>
        <li>
          <strong>Not legal advice.</strong> ShieldKit is not your lawyer.
          Generated content does not constitute legal, tax, or compliance
          advice. Consult a qualified professional for material decisions.
        </li>
        <li>
          <strong>You own what you publish.</strong> Once you publish a
          generated policy on your store, it's your content. You're
          responsible for keeping it accurate.
        </li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Acceptable use
      </h2>
      <p>You agree not to:</p>
      <ul>
        <li>Reverse-engineer, scrape, or attempt to extract the source code or scan logic.</li>
        <li>Use ShieldKit to scan stores you don't own or aren't authorised to administer.</li>
        <li>Abuse the scanner — for example, automated rapid re-scans designed to overwhelm rate limits.</li>
        <li>Use the AI features to generate content that violates Shopify's or Google's policies.</li>
        <li>Attempt to bypass the plan tier (e.g. modifying client-side state to access Shield Max features without subscribing).</li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Service availability
      </h2>
      <p>
        ShieldKit is provided on a best-effort basis. We aim for high
        availability but do not commit to a formal uptime SLA at the current
        plan tiers. Scheduled maintenance and unexpected outages will happen.
        Cron jobs (weekly scans, monthly resets, weekly digests) are subject
        to Vercel's Cron platform availability.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Compliance disclaimers
      </h2>
      <ul>
        <li>
          ShieldKit is a <em>compliance-aid</em> tool. Passing all 12 checks
          does not guarantee Google Merchant Center will approve your account
          or keep it active. GMC enforcement is opaque, situational, and
          subject to change.
        </li>
        <li>
          AI-search visibility (llms.txt, Organization schema, GTIN
          enrichment) is also best-effort. We can structure your store so AI
          search engines can ingest it correctly; we cannot make any specific
          model rank or surface your products.
        </li>
        <li>
          Performance scoring uses Google's PageSpeed Insights API and is
          subject to that API's availability and accuracy.
        </li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Warranty disclaimer
      </h2>
      <p>
        ShieldKit is provided "as is" without warranties of any kind, express
        or implied, including merchantability, fitness for a particular
        purpose, and non-infringement. We do not warrant the service will be
        uninterrupted or error-free, that defects will be corrected, or that
        the service or the server that makes it available are free of viruses
        or other harmful components.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Limitation of liability
      </h2>
      <p>
        To the extent permitted by law, in no event shall ShieldKit, its
        operators, or its subprocessors be liable for any indirect,
        incidental, consequential, or punitive damages arising out of your
        use of the service, including but not limited to loss of revenue,
        data, or business opportunity. Total aggregate liability shall not
        exceed the amount you paid for the service in the 3 months preceding
        the event giving rise to the claim.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Termination
      </h2>
      <p>
        You can terminate at any time by uninstalling the app or by cancelling
        your subscription in the in-app plan switcher. We can terminate or
        suspend your access if you breach these terms or use the service in a
        way that risks the integrity of the platform. On termination, the
        Privacy Policy retention rules apply.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Changes to these terms
      </h2>
      <p>
        We may update these terms over time. Material changes will be
        highlighted in the app or via a one-time email to your shop owner
        address. Continued use of ShieldKit after a change means you accept
        the updated terms.
      </p>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Contact
      </h2>
      <p>
        Questions, complaints, or refund requests:{" "}
        <a href="mailto:hello@shieldkit.app">hello@shieldkit.app</a>.
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
        <a href="/privacy" style={{ color: "#6d7175", textDecoration: "underline" }}>
          Privacy
        </a>
        <span>© ShieldKit</span>
      </footer>
    </div>
  );
}
