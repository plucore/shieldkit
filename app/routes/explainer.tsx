import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";

import { MarketingArticleLayout } from "../components/marketing/MarketingArticleLayout";
import { JsonLd } from "../components/marketing/JsonLd";
import { SITE } from "../lib/brand";
import marketingStyles from "../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

const PUBLISHED_AT = "2026-05-04";
const TITLE =
  "Google Merchant Center Suspension on Shopify: The Complete 2026 Guide";
const DESCRIPTION =
  "Everything Shopify merchants need to know about GMC misrepresentation suspensions in 2026 — triggers, recovery process, prevention.";

export async function loader({ request }: LoaderFunctionArgs) {
  // Bounce embedded-app traffic just like the homepage / scan page.
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/app?${url.searchParams.toString()}` },
    });
  }
  return null;
}

export const meta: MetaFunction = () => {
  const url = SITE.url + "/explainer";
  return [
    { title: TITLE + " | ShieldKit" },
    { name: "description", content: DESCRIPTION },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "article" },
    { property: "og:url", content: url },
    { property: "og:image", content: SITE.url + SITE.ogImage },
    { property: "article:published_time", content: PUBLISHED_AT },
    { property: "article:author", content: "ShieldKit Team" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: TITLE },
    { name: "twitter:description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

export default function ExplainerPage() {
  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: TITLE,
    description: DESCRIPTION,
    author: { "@type": "Organization", name: "ShieldKit Team" },
    publisher: {
      "@type": "Organization",
      name: "ShieldKit",
      logo: { "@type": "ImageObject", url: SITE.url + "/logo-main.png" },
    },
    datePublished: PUBLISHED_AT,
    dateModified: PUBLISHED_AT,
    mainEntityOfPage: SITE.url + "/explainer",
  };

  return (
    <>
      <JsonLd data={articleJsonLd} />
      <MarketingArticleLayout
        title={TITLE}
        subtitle="Why Google suspends Shopify stores, what triggers misrepresentation flags, and how to recover fast — plus what to build into your store so you never get hit again."
        publishedAt={PUBLISHED_AT}
      >
        <h2>What is GMC Misrepresentation Suspension?</h2>
        <p>
          A Google Merchant Center misrepresentation suspension is the action
          Google takes when it concludes — algorithmically, or after manual
          review — that your storefront, your data feed, or your business
          practices misrepresent yourself to shoppers. It is the single most
          common reason Shopify stores lose access to Google Shopping. According
          to industry analysis published by Swell in early 2026, roughly 60% of
          all Shopify GMC suspensions cite misrepresentation as the policy
          violation, eclipsing every other category combined.
        </p>
        <p>
          The practical impact is brutal and immediate. The moment the
          suspension lands, your products stop appearing in free Shopping
          listings and across the Shopping ads network. Every active campaign
          tied to the affected Merchant Center account is paused. Organic
          shopping traffic — which for many DTC brands accounts for 15–30% of
          weekly revenue — vanishes. And because Performance Max and Demand Gen
          campaigns lean on Merchant feed signals, even non-Shopping placements
          get destabilized for the duration of the suspension.
        </p>
        <p>
          The frustrating part: the email Google sends rarely tells you what
          specifically triggered it. You get a one-line "your account has been
          suspended for misrepresentation" and a link to the same generic
          policy page every other suspended merchant gets. The work of
          diagnosing what changed — or what was always missing — falls
          entirely on you.
        </p>

        <h2>The 7 Most Common Triggers</h2>

        <h3>1. Insufficient contact information</h3>
        <p>
          Google wants two of the following three on a public page: a phone
          number, an email address (ideally on your store domain rather than a
          generic gmail/outlook address), and a physical street address. PO
          boxes don't count. A "Contact us" page that only contains a form is
          insufficient — the contact details themselves must be visible without
          submitting anything. This is one of the easiest issues to introduce
          accidentally during a theme redesign, and one of the most common
          triggers for first-time suspensions.
        </p>

        <h3>2. Missing or incomplete refund/return policy</h3>
        <p>
          Your refund policy needs to specify three things, in plain language:
          the return window (e.g. "within 30 days of delivery"), the condition
          the item must be returned in (e.g. "unworn, with tags attached, in
          original packaging"), and the method by which refunds are issued (to
          the original payment method, as store credit, etc.). Shopify's
          default policy generator covers all three; if you've customized the
          policy and removed sections, you may have removed signals Google's
          systems are explicitly looking for.
        </p>

        <h3>3. Missing shipping policy</h3>
        <p>
          Same idea as the refund policy: a shipping policy with vague language
          like "we ship most orders quickly" is treated as missing. Google
          wants explicit delivery timeframes ("orders ship within 1–2 business
          days, US delivery 3–7 business days") and explicit shipping costs
          ("free over $50, $5.99 flat rate otherwise"). Free-text language
          like "calculated at checkout" is acceptable but only if it appears
          alongside concrete cost ranges or a cost table.
        </p>

        <h3>4. Missing terms of service / privacy policy</h3>
        <p>
          Privacy policy is non-negotiable — beyond GMC, GDPR (EU) and CCPA
          (California) require one regardless. Terms of service is technically
          optional under GMC policy but in practice its absence is a strong
          negative signal. Both should be linked from your storefront footer
          and accessible to anyone (no login required).
        </p>

        <h3>5. Hidden fees not disclosed in policy</h3>
        <p>
          This is one of the most under-appreciated triggers. If your
          storefront mentions handling fees, restocking fees, processing fees,
          surcharges, convenience fees, or service fees anywhere — on a
          product page, in a FAQ, in your cart-page copy — those fees must
          also appear in your shipping policy or refund policy. Google's
          systems crawl product pages alongside policy pages and flag the
          mismatch. A "$5 handling fee on all orders under $25" mentioned in
          your cart but absent from your shipping policy will trigger
          misrepresentation reliably.
        </p>

        <h3>6. Storefront password protection still enabled</h3>
        <p>
          You wouldn't think this happens, but it does — particularly for
          merchants who run a soft launch, capture a few orders, then submit
          to Merchant Center before remembering to remove the password gate.
          Google's crawler hits the password page, can't reach your products,
          and suspends the account. Check Online Store → Preferences →
          Restrict access — make sure that checkbox is off.
        </p>

        <h3>7. Dropshipper-hosted product images</h3>
        <p>
          Products whose <code>descriptionHtml</code> references images on
          known dropshipping CDNs — cdn.cjdropshipping.com, alicdn.com,
          aliexpress-img.alicdn.com — telegraph to Google that you're reselling
          someone else's catalog without value-add. This alone often won't
          trigger suspension, but combined with thin product descriptions or
          missing structured data, it becomes the deciding factor. Self-host
          your product imagery on Shopify's CDN.
        </p>

        <h2>Step-by-Step Recovery Process</h2>
        <ol>
          <li>
            <strong>Run a compliance audit.</strong> Before anything else,
            establish a clear list of what Google might be flagging. You can
            run our <a href="/scan">free public scanner</a> against your store
            URL — it surfaces 8 of the most common triggers in under a minute.
            Document everything you find.
          </li>
          <li>
            <strong>Fix the highest-severity issues first.</strong> Critical
            triggers (missing policies, password gate, contact info) get fixed
            before warnings. The cleaner your fix list, the faster the
            re-review.
          </li>
          <li>
            <strong>Document every fix you made.</strong> Write down each
            issue, the fix, and the date — including screenshots of before and
            after. You'll paste this into your re-review request. Reviewers
            move faster when you give them the audit trail.
          </li>
          <li>
            <strong>Submit a re-review request through GMC dashboard.</strong>{" "}
            In Merchant Center → Diagnostics → "Request review". Be specific:
            "We added a phone number and physical address to our Contact page
            on 2026-05-12, generated a Refund Policy with 30-day window and
            unworn-condition language, and disabled the storefront password."
            Vague requests get vague responses.
          </li>
          <li>
            <strong>Wait 3–7 business days.</strong> Most reinstatements land
            in this window. Don't submit a second request — it resets the
            queue position.
          </li>
          <li>
            <strong>If still suspended after 14 days, escalate.</strong>{" "}
            Twitter/X works (tag @AskShopping). Paid Google Ads support can
            sometimes intercede on Merchant Center cases for active
            advertisers. Recovery agencies like KeyCommerce, StubGroup, and
            FeedArmy have direct Google reseller channels and can move
            stalled cases that DIY can't.
          </li>
        </ol>

        <h2>How to Prevent Suspension Going Forward</h2>
        <p>
          The recovery cycle is exhausting. Most merchants who go through it
          once have a strong incentive never to repeat it. The core
          prevention discipline is continuous monitoring — running a
          compliance scan on a regular cadence (weekly is standard) so that
          any regression introduced by a theme update, a new app, a policy
          edit, or a copy change gets caught before Google's crawler finds
          it. ShieldKit's <strong>Shield Pro</strong> tier runs an automated
          weekly scan against your store and emails you a digest of any new
          issues, fixed issues, or score regressions.
        </p>
        <p>
          The other prevention vectors are less obvious. Theme updates are a
          common silent regression vector — a theme creator updates their
          product template and accidentally removes a JSON-LD block, or
          changes the structure of the contact page. Your store's compliance
          score quietly drops the day you click "update theme" and you have
          no way of knowing until Google sends the suspension email weeks
          later. Scanning before AND after every theme update closes that
          loop.
        </p>

        <h2>When to Hire a Professional vs. DIY</h2>
        <p>
          For first-time suspensions where the triggers are obvious (missing
          policy, password gate, hidden fees), DIY is fast and cheap. Run a
          scan, fix what's flagged, document the changes, submit the
          re-review request — most stores are reinstated within a week.
        </p>
        <p>
          For repeat suspensions, ambiguous triggers ("we did everything and
          it's still suspended"), or suspensions on accounts with significant
          ad spend, professional recovery services pay for themselves quickly.{" "}
          <strong>KeyCommerce</strong> publishes that they've reinstated 300+
          stores; <strong>StubGroup</strong> is a Google Premier Partner with
          a Merchant Center practice; <strong>FeedArmy</strong> specializes
          in feed-level disapprovals that look like account suspensions but
          actually need feed work. None of these are competitors to ShieldKit
          — we're the prevention layer; they're the recovery layer. The two
          stack cleanly.
        </p>
        <p>
          The pattern we see most often: merchants pay a recovery service to
          get reinstated, then install ShieldKit to make sure the same thing
          doesn't happen six months later.
        </p>
      </MarketingArticleLayout>
    </>
  );
}
