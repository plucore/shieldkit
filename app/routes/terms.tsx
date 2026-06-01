/**
 * app/routes/terms.tsx
 * Route: /terms  (public)
 *
 * ShieldKit terms of service.
 */

import type { HeadersFunction } from "react-router";

import { SITE } from "../lib/brand";

// Cache the terms of service at Vercel's edge for 24h, stale-while-revalidate
// for 7 days. The page changes only on legal review, which is rare enough
// that 7 days of staleness is acceptable. Cuts Fast Origin Transfer.
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
});

export const meta = () => {
  const title = "Terms of Service — ShieldKit";
  const description =
    "Terms of service for the ShieldKit Shopify app — eligibility, billing, acceptable use, and warranties.";
  const url = SITE.url + "/terms";
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
          <strong>Monitoring</strong> — $49 / month or $449 / year. The
          single paid tier. Unlocks unlimited on-demand compliance scans,
          AI-written store policies (refund, shipping, privacy, terms), the
          GMC re-review appeal letter generator, bulk GTIN / MPN / brand
          fill on the existing catalog, ongoing per-product enrichment on
          newly-updated products, llms.txt at the App Proxy URL, AI
          crawler allow/block controls, the store schema settings page,
          and the Organization &amp; WebSite JSON-LD theme blocks.
          AI generations (policies + appeal letters combined) are capped
          at 12 per rolling 30-day window.
        </li>
      </ul>
      <p>
        Paid plans are billed by Shopify under Shopify Managed Pricing.
        Charges appear on your Shopify invoice. Annual plans are billed up
        front. Recurring charges renew automatically until you cancel via
        Shopify's Managed Pricing page (also reachable from the in-app plan
        switcher) or by uninstalling the app.
      </p>
      <p>
        Plan switches are prorated automatically by Shopify. Cancellations
        take effect immediately: paid features stop, and your account
        returns to the Free plan. The free plan grants one compliance scan
        at install; it is not refilled on cancellation.
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
        Product writes (paid plan)
      </h2>
      <p>
        The paid plan writes identifier metafields back to your products via
        the <code>write_products</code> Shopify scope: continuous enrichment
        on newly-updated products plus the bulk Auto-Filler that fills
        missing identifiers across the existing catalog. Scope of writes:
      </p>
      <ul>
        <li>
          We write only to the <code>custom</code> metafield namespace, on
          the keys <code>gtin</code>, <code>mpn</code>, <code>brand</code>,
          and <code>identifier_exists</code>.
        </li>
        <li>
          We never modify product titles, descriptions, prices, inventory,
          images, or variant fields.
        </li>
        <li>
          You can review every product the Auto-Filler will touch before
          confirming, and you can mark products as "no identifier exists"
          (handmade / vintage) to opt them out.
        </li>
        <li>
          On products/create and products/update webhooks, we may
          continuously enrich the same metafields for newly added products,
          with a 24-hour deduplication window per product.
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
        <li>Attempt to bypass the plan tier (e.g. modifying client-side state to access paid features without subscribing).</li>
      </ul>

      <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "32px 0 12px" }}>
        Service availability
      </h2>
      <p>
        ShieldKit is provided on a best-effort basis. We aim for high
        availability but do not commit to a formal uptime SLA at the current
        plan tiers. Scheduled maintenance and unexpected outages will happen.
        Background jobs (subscription reconciliation, install reconciliation,
        JSON-LD verification, product-enrichment drainer) are subject to
        Vercel's Cron platform availability.
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
