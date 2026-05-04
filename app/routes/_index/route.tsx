import type { LoaderFunctionArgs, MetaFunction, LinksFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";

import { MarketingLayout } from "../../components/marketing/MarketingLayout";
import { MarketingButton } from "../../components/marketing/Button";
import { HeroMock } from "../../components/marketing/HeroMock";
import { JsonLd } from "../../components/marketing/JsonLd";
import { SITE } from "../../lib/brand";
import marketingStyles from "../../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // PRESERVE EMBEDDED-APP FLOW: When the merchant lands here from inside the
  // Shopify admin (?shop=... query param), forward them to /app immediately.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  const marketingVersion =
    process.env.MARKETING_VERSION === "v2" ? "v2" : "v1";

  return { marketingVersion };
};

export const meta: MetaFunction = () => {
  const title =
    "ShieldKit — Fix Google Merchant Center Suspension on Shopify";
  const description =
    "10-point compliance audit + AI-powered policy generation for Shopify stores. Diagnose what Google flags, fix it fast, get back to selling.";
  const url = SITE.url + "/";
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
    { name: "twitter:image", content: SITE.url + SITE.ogImage },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

export default function HomePage() {
  const { marketingVersion } = useLoaderData<typeof loader>();
  const isV2 = marketingVersion === "v2";

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "ShieldKit",
    url: SITE.url,
    logo: SITE.url + "/logo-main.png",
    description:
      "GMC compliance and AI search visibility tools for Shopify merchants.",
  };

  return (
    <MarketingLayout mainLabel="ShieldKit homepage">
      <JsonLd data={orgJsonLd} />
      {isV2 ? <HeroV2 /> : <HeroV1 />}
      <HowItWorks />
      <FeatureGrid />
      <div id="pricing">{isV2 ? <PricingV2 /> : <PricingV1 />}</div>
      <FAQ isV2={isV2} />
      <FinalCta isV2={isV2} />
    </MarketingLayout>
  );
}

/* ─────────────────────────────────────────────────────────── HEROES ── */

function HeroV1() {
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-16 sm:pt-24 pb-16 sm:pb-24">
      <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <div>
          <span className="inline-flex items-center rounded-full bg-white/70 border border-brand-card-border px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand-navy">
            For Shopify merchants
          </span>
          <h1 className="mt-5 text-4xl sm:text-5xl lg:text-6xl font-extrabold text-brand-navy leading-[1.05]">
            Fix Your Google Merchant Center Suspension Before It Costs You Sales
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-brand-gray-text leading-relaxed max-w-xl">
            10-point compliance audit + AI-powered policy generation for
            Shopify stores. Diagnose what Google flags, fix it fast, get back
            to selling.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <MarketingButton to="/scan" size="lg">
              Run Free Compliance Scan
            </MarketingButton>
            <MarketingButton href={SITE.installUrl} variant="secondary" size="lg">
              Install on Shopify
            </MarketingButton>
          </div>
          <p className="mt-4 text-sm text-brand-gray-text">
            No credit card. Read-only — we never write to your store.
          </p>
        </div>
        <div className="lg:pl-8">
          <HeroMock />
        </div>
      </div>
    </section>
  );
}

function HeroV2() {
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-16 sm:pt-24 pb-16 sm:pb-24">
      <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <div>
          <span className="inline-flex items-center rounded-full bg-white/70 border border-brand-card-border px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand-navy">
            Trust + Visibility for Shopify
          </span>
          <h1 className="mt-5 text-4xl sm:text-5xl lg:text-6xl font-extrabold text-brand-navy leading-[1.05]">
            The Trust Layer for Shopify
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-brand-gray-text leading-relaxed max-w-xl">
            Stay compliant with Google. Be findable in AI search. Continuous
            monitoring, weekly reports, and AI-ready product schema — from
            $14/month.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <MarketingButton href={SITE.installUrl} size="lg">
              Start Free
            </MarketingButton>
            <MarketingButton to="/scan" variant="secondary" size="lg">
              Run Free Compliance Scan
            </MarketingButton>
          </div>
          <p className="mt-4 text-sm text-brand-gray-text">
            Free plan available. Cancel anytime.
          </p>
        </div>
        <div className="lg:pl-8">
          <HeroMock />
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── HOW IT WORKS ── */

function HowItWorks() {
  const steps = [
    {
      icon: <IconInstall />,
      title: "Install on Shopify",
      desc: "One-click install from the Shopify App Store. Read-only scopes, no theme changes.",
    },
    {
      icon: <IconScan />,
      title: "Run a scan",
      desc: "We crawl your store, policies, and product pages, then run a 10-point compliance check.",
    },
    {
      icon: <IconFix />,
      title: "Fix flagged issues",
      desc: "Each finding ships with plain-English fix instructions. Critical issues first.",
    },
  ];
  return (
    <section className="bg-white/40 border-y border-brand-card-border/60">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <h2 className="text-3xl sm:text-4xl font-extrabold text-brand-navy text-center">
          How it works
        </h2>
        <p className="mt-3 text-brand-gray-text text-center max-w-xl mx-auto">
          From install to fixed in under an hour.
        </p>
        <div className="mt-12 grid sm:grid-cols-3 gap-6">
          {steps.map((s, i) => (
            <div
              key={s.title}
              className="rounded-2xl bg-white border border-brand-card-border shadow-card p-6"
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-brand-navy/5 p-2">{s.icon}</div>
                <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text">
                  Step {i + 1}
                </div>
              </div>
              <h3 className="mt-4 text-xl font-bold">{s.title}</h3>
              <p className="mt-2 text-brand-gray-text">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────────────── FEATURES ── */

function FeatureGrid() {
  const features = [
    {
      title: "10-Point Compliance Audit",
      desc: "Automated scan against Google Merchant Center requirements — the same checks that decide whether your account stays live.",
      icon: <IconShield />,
    },
    {
      title: "AI-Powered Policy Generation",
      desc: "Refund, shipping, privacy, and terms drafted by Claude — tailored to your store and aligned with GMC requirements.",
      icon: <IconSparkle />,
    },
    {
      title: "Free JSON-LD Structured Data",
      desc: "Theme extension included on every plan. Product schema for Google Shopping with zero manual setup.",
      icon: <IconCode />,
    },
    {
      title: "Threat Level Assessment",
      desc: "Issues ranked Critical → Warning → Info so you fix what actually matters first.",
      icon: <IconAlert />,
    },
    {
      title: "Plain-English Fix Instructions",
      desc: "No jargon. Each finding tells you exactly what to change and where to change it in Shopify admin.",
      icon: <IconClipboard />,
    },
    {
      title: "Privacy-First & Read-Only",
      desc: "We request read scopes only. ShieldKit never writes to your store, never edits products, never touches checkout.",
      icon: <IconLock />,
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
      <h2 className="text-3xl sm:text-4xl font-extrabold text-brand-navy text-center">
        Everything you need to stay compliant
      </h2>
      <p className="mt-3 text-brand-gray-text text-center max-w-2xl mx-auto">
        ShieldKit consolidates the GMC checklist, fix workflow, and theme
        plumbing into a single Shopify-native experience.
      </p>
      <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-2xl bg-white border border-brand-card-border shadow-card p-6"
          >
            <div className="rounded-lg bg-brand-navy/5 inline-flex p-2">
              {f.icon}
            </div>
            <h3 className="mt-4 text-lg font-bold">{f.title}</h3>
            <p className="mt-2 text-brand-gray-text text-sm leading-relaxed">
              {f.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────── PRICING ── */

function PricingV1() {
  return (
    <section className="bg-white/40 border-y border-brand-card-border/60">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <h2 className="text-3xl sm:text-4xl font-extrabold text-brand-navy text-center">
          Simple, fair pricing
        </h2>
        <p className="mt-3 text-brand-gray-text text-center">
          Start free. Upgrade once if you need more.
        </p>
        <div className="mt-12 grid sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
          <PricingCard
            name="Free"
            price="$0"
            features={[
              "1 compliance scan",
              "Fix instructions for top issues",
              "Free JSON-LD structured data theme block",
              "Compliance score & threat assessment",
            ]}
            cta="Install on Shopify"
            ctaHref={SITE.installUrl}
          />
          <PricingCard
            name="Pro"
            price="$29"
            interval="one-time"
            highlight
            features={[
              "Everything in Free",
              "Unlimited compliance re-scans",
              "AI-powered policy generator (refund, shipping, privacy, terms)",
              "Priority support",
            ]}
            cta="Install on Shopify"
            ctaHref={SITE.installUrl}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * V2 pricing uses two hidden radio inputs as the source of truth for the
 * monthly|annual toggle. Sibling combinator CSS in marketing.css flips
 * which price spans show. No JS, no hydration.
 */
function PricingV2() {
  return (
    <section className="bg-white/40 border-y border-brand-card-border/60">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <h2 className="text-3xl sm:text-4xl font-extrabold text-brand-navy text-center">
          Pricing
        </h2>
        <p className="mt-3 text-brand-gray-text text-center">
          Free plan available. Switch or cancel anytime.
        </p>

        <div className="mt-8 sk-billing-toggle">
          <input type="radio" name="sk-billing" id="sk-billing-monthly" />
          <input
            type="radio"
            name="sk-billing"
            id="sk-billing-annual"
            defaultChecked
          />
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-1 rounded-full bg-white border border-brand-card-border p-1">
              <label
                htmlFor="sk-billing-monthly"
                className="cursor-pointer px-4 py-2 rounded-full text-sm font-semibold text-brand-gray-text"
                data-billing-label="monthly"
              >
                Monthly
              </label>
              <label
                htmlFor="sk-billing-annual"
                className="cursor-pointer px-4 py-2 rounded-full text-sm font-semibold text-brand-gray-text"
                data-billing-label="annual"
              >
                Annual{" "}
                <span className="ml-1 text-[10px] font-bold opacity-80">
                  SAVE 16%
                </span>
              </label>
            </div>
          </div>

          <div className="mt-10 grid lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
            <PricingCard
              name="Free"
              price="$0"
              features={[
                "1 scan/month",
                "Fix instructions for top 3 findings",
                "Free JSON-LD structured data",
              ]}
              cta="Start Free"
              ctaHref={SITE.installUrl}
            />
            <PricingCard
              name="Shield Pro"
              badge="Most popular"
              highlight
              priceMonthly="$14"
              priceAnnual="$140"
              annualSavings="16% off"
              features={[
                "Unlimited scans",
                "Continuous weekly monitoring",
                "Weekly health digest email",
                "AI policy generator",
                "GMC re-review appeal letter",
                "Hidden fee detector",
                "Image hosting audit",
              ]}
              cta="Start Free"
              ctaHref={SITE.installUrl}
            />
            <PricingCard
              name="Shield Max"
              priceMonthly="$39"
              priceAnnual="$390"
              features={[
                "Everything in Shield Pro",
                "Merchant Listings JSON-LD enricher",
                "GTIN/MPN/brand auto-filler",
                "Organization & WebSite schema blocks",
                "llms.txt at root",
                "AI bot allow/block toggle",
              ]}
              cta="Start Free"
              ctaHref={SITE.installUrl}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

interface PricingCardProps {
  name: string;
  price?: string;
  priceMonthly?: string;
  priceAnnual?: string;
  annualSavings?: string;
  interval?: string;
  features: string[];
  cta: string;
  ctaHref: string;
  highlight?: boolean;
  badge?: string;
}

function PricingCard({
  name,
  price,
  priceMonthly,
  priceAnnual,
  annualSavings,
  interval,
  features,
  cta,
  ctaHref,
  highlight,
  badge,
}: PricingCardProps) {
  return (
    <div
      className={`relative rounded-2xl bg-white border shadow-card p-7 flex flex-col ${
        highlight ? "border-brand-navy ring-2 ring-brand-navy/15" : "border-brand-card-border"
      }`}
    >
      {badge && (
        <span className="absolute -top-3 left-7 inline-flex items-center rounded-full bg-brand-navy text-white text-[11px] font-bold uppercase tracking-wider px-3 py-1">
          {badge}
        </span>
      )}
      <div className="text-lg font-bold text-brand-navy">{name}</div>
      <div className="mt-3 min-h-[3.25rem]">
        {price && (
          <div className="text-4xl font-extrabold text-brand-navy">
            {price}
            {interval && (
              <span className="text-base font-medium text-brand-gray-text"> {interval}</span>
            )}
          </div>
        )}
        {priceMonthly && priceAnnual && (
          <div>
            <span className="text-4xl font-extrabold text-brand-navy sk-price-monthly">
              {priceMonthly}
              <span className="text-base font-medium text-brand-gray-text">/mo</span>
            </span>
            <span className="text-4xl font-extrabold text-brand-navy sk-price-annual">
              {priceAnnual}
              <span className="text-base font-medium text-brand-gray-text">/yr</span>
            </span>
            {annualSavings && (
              <span className="ml-2 inline-flex items-center rounded-full bg-brand-green/10 text-brand-green text-xs font-bold px-2 py-0.5 sk-price-annual">
                {annualSavings}
              </span>
            )}
          </div>
        )}
      </div>
      <ul className="mt-5 space-y-2.5 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-brand-navy">
            <span className="mt-0.5 inline-flex items-center justify-center h-5 w-5 rounded-full bg-brand-green/10 text-brand-green flex-shrink-0">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <MarketingButton
          href={ctaHref}
          variant={highlight ? "primary" : "secondary"}
          size="md"
          className="w-full"
        >
          {cta}
        </MarketingButton>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────── FAQ ── */

function FAQ({ isV2 }: { isV2: boolean }) {
  const items: { q: string; a: React.ReactNode }[] = [
    {
      q: "How does the scan work?",
      a: (
        <>
          ShieldKit performs a read-only crawl of your storefront, your shop
          policies via the Shopify Admin API, and a sample of your product
          pages. We never make changes — only diagnose.
        </>
      ),
    },
    {
      q: "Do you write anything to my store?",
      a: (
        <>
          No. We request read-only scopes (
          <code>read_products</code>, <code>read_content</code>,{" "}
          <code>read_legal_policies</code>) and never write back to Shopify.
        </>
      ),
    },
    {
      q: "What does GMC misrepresentation actually mean?",
      a: (
        <>
          It's the most common cause of Google Merchant Center suspensions —
          Google believes your storefront is missing trust signals (contact
          info, policies, transparent pricing).{" "}
          <a href="/explainer" className="underline">Read the full explainer</a>.
        </>
      ),
    },
    {
      q: "How fast can I recover from a suspension?",
      a: (
        <>
          With clean fixes documented in your re-review request, most
          merchants are reinstated in 3–7 days. Repeat offenses or unclear
          fixes can extend that.
        </>
      ),
    },
    {
      q: "Is the free plan really free?",
      a: <>Yes — 1 scan{isV2 ? "/month" : ""}, no card required.</>,
    },
    isV2
      ? {
          q: "What's the difference between Shield Pro and Shield Max?",
          a: (
            <>
              Shield Pro ($14/mo) gives you unlimited scans, weekly
              monitoring, weekly digest email, AI policy generator, the GMC
              appeal-letter generator, and hidden-fee + dropshipper-image
              audits. Shield Max ($39/mo) adds the Merchant Listings schema
              enricher, Organization &amp; WebSite blocks, llms.txt at root,
              and AI bot allow/block toggles for AI search visibility.
            </>
          ),
        }
      : {
          q: "Can I cancel anytime?",
          a: (
            <>
              Pro is a one-time $29 charge — there's nothing to cancel. You
              own the unlock for the life of your install.
            </>
          ),
        },
  ];
  return (
    <section className="mx-auto max-w-3xl px-4 sm:px-6 py-16 sm:py-24">
      <h2 className="text-3xl sm:text-4xl font-extrabold text-brand-navy text-center">
        Frequently asked
      </h2>
      <div className="mt-10 space-y-3">
        {items.map((it) => (
          <details
            key={it.q}
            className="group rounded-xl bg-white border border-brand-card-border shadow-card p-5 open:bg-white"
          >
            <summary className="flex items-center justify-between cursor-pointer list-none font-semibold text-brand-navy">
              <span>{it.q}</span>
              <span className="ml-4 text-brand-gray-text group-open:rotate-45 transition-transform text-xl leading-none">+</span>
            </summary>
            <div className="mt-3 text-brand-gray-text leading-relaxed text-[15px]">
              {it.a}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────── FINAL CTA ── */

function FinalCta({ isV2 }: { isV2: boolean }) {
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20">
      <div className="rounded-3xl bg-brand-navy text-white p-10 sm:p-14 text-center shadow-card">
        <h2 className="text-3xl sm:text-4xl font-extrabold">
          {isV2
            ? "Ready to get found by Google and AI?"
            : "Ready to fix your suspension?"}
        </h2>
        <p className="mt-3 text-white/80 max-w-xl mx-auto">
          Run a free compliance scan in under two minutes. No install required
          to see your score.
        </p>
        <div className="mt-7 flex justify-center gap-3 flex-wrap">
          <MarketingButton
            to="/scan"
            size="lg"
            className="bg-white !text-brand-navy hover:bg-white/90"
          >
            Run Free Scan
          </MarketingButton>
          <MarketingButton
            href={SITE.installUrl}
            size="lg"
            className="bg-transparent border border-white !text-white hover:bg-white/10"
          >
            Install on Shopify
          </MarketingButton>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────── ICONS ── */

function IconShield() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z" stroke="#0f1f3d" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconSparkle() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3v6m0 6v6M3 12h6m6 0h6" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function IconCode() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 4l9 16H3l9-16zM12 10v5M12 18v.5" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconClipboard() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="6" y="4" width="12" height="17" rx="2" stroke="#0f1f3d" strokeWidth="1.8" />
      <path d="M9 4h6v2H9zM9 11h6M9 15h4" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="#0f1f3d" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 018 0v3" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function IconInstall() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 4v10m0 0l-4-4m4 4l4-4M4 18h16" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconScan() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function IconFix() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 6l4 4-9 9-4 1 1-4 8-10z" stroke="#0f1f3d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
