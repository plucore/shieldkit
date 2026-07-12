import type {
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";

// Cache fix index at Vercel's edge for 24h, stale-while-revalidate for 7 days.
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
});
import { Link } from "react-router";

import { MarketingLayout } from "../components/marketing/MarketingLayout";
import { MarketingButton } from "../components/marketing/Button";
import { JsonLd } from "../components/marketing/JsonLd";
import { SITE } from "../lib/brand";
import { FIXES, type Fix } from "../content/fixes";
import marketingStyles from "../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

export async function loader({ request }: LoaderFunctionArgs) {
  // Preserve embedded-app flow consistency with other public routes.
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
  const title =
    "Shopify Google Merchant Center Errors, Fix Library | ShieldKit";
  const description =
    "Step-by-step fixes for every Google Merchant Center error on Shopify, missing GTIN, untrustworthy promotions, hidden fees, account suspensions, and 26 more.";
  const url = SITE.url + "/fix";
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

/**
 * Fix library category grouping.
 *
 * Each category lists the canonical fix slugs (in display order) plus a short
 * intro paragraph. Slugs must match entries in `app/content/fixes.ts` — verified
 * at module load below.
 */
interface Category {
  title: string;
  intro: string;
  slugs: string[];
}

const CATEGORIES: Category[] = [
  {
    title: "Product data errors",
    intro:
      "Feed-level errors caused by missing identifiers, attributes, or product fields. Most are 5-minute fixes once you know what Google's looking for.",
    slugs: [
      "missing-gtin",
      "missing-mpn",
      "missing-brand",
      "missing-identifier-exists",
      "condition-not-declared",
      "missing-product-image",
      "insufficient-product-data",
      "missing-tax-information",
    ],
  },
  {
    title: "Pricing & availability",
    intro:
      "Mismatch errors between your feed and your live storefront. Usually caused by sync delays, theme bugs, or third-party apps that change displayed prices.",
    slugs: [
      "price-mismatch",
      "availability-mismatch",
      "variants-not-matching-feed",
      "feed-not-matching-website",
    ],
  },
  {
    title: "Image issues",
    intro:
      "Disapprovals tied to product imagery, hot-linked supplier images, sale overlays, or title quality flags that ride alongside image checks.",
    slugs: [
      "dropshipping-cdn-images",
      "promotional-overlay-image",
      "excessive-capitalization",
    ],
  },
  {
    title: "Policy & disclosure",
    intro:
      "Missing or incomplete policy pages, undisclosed checkout fees, and contact-information gaps. The most common cause of misrepresentation suspensions.",
    slugs: [
      "missing-shipping-policy",
      "missing-refund-policy",
      "missing-contact-information",
      "missing-checkout-transparency",
      "business-information-mismatch",
      "hidden-fees",
      "untrustworthy-promotions",
    ],
  },
  {
    title: "Account suspensions",
    intro:
      "Account-level enforcement actions that suspend your entire Merchant Center or Google Ads account. Recovery means a documented re-review appeal.",
    slugs: [
      "account-suspension-misrepresentation",
      "account-suspension-counterfeit",
      "google-ads-suspension",
      "limited-performance-warning",
    ],
  },
  {
    title: "Restricted & prohibited",
    intro:
      "Category-specific bans and counterfeit flags. The hardest suspensions to appeal, fixes require either documentation or removing the affected products.",
    slugs: ["counterfeit-goods", "restricted-product"],
  },
  {
    title: "Visibility & technical",
    intro:
      "Crawler-access and indexing problems. Products may pass GMC diagnostics cleanly and still never appear in Shopping because Google can't reach the pages.",
    slugs: ["landing-page-not-working", "products-not-showing"],
  },
];

// Sanity check at module load: every fix in the registry should appear in
// exactly one category, and every category slug should be a real fix.
{
  const allCategorySlugs = CATEGORIES.flatMap((c) => c.slugs);
  const fixSlugSet = new Set(FIXES.map((f) => f.slug));
  const categorySlugSet = new Set(allCategorySlugs);

  for (const slug of allCategorySlugs) {
    if (!fixSlugSet.has(slug)) {
      throw new Error(`fix._index: category slug "${slug}" not in FIXES`);
    }
  }
  for (const fix of FIXES) {
    if (!categorySlugSet.has(fix.slug)) {
      throw new Error(`fix._index: fix slug "${fix.slug}" not in any category`);
    }
  }
  if (allCategorySlugs.length !== new Set(allCategorySlugs).size) {
    throw new Error("fix._index: a fix slug appears in more than one category");
  }
}

function getFix(slug: string): Fix {
  const fix = FIXES.find((f) => f.slug === slug);
  if (!fix) throw new Error(`fix._index: missing fix "${slug}"`);
  return fix;
}

export default function FixIndex() {
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "ShieldKit Google Merchant Center Fix Library",
    itemListOrder: "https://schema.org/ItemListUnordered",
    numberOfItems: FIXES.length,
    itemListElement: CATEGORIES.flatMap((c) => c.slugs).map((slug, i) => {
      const fix = getFix(slug);
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${SITE.url}/fix/${fix.slug}`,
        name: fix.title,
      };
    }),
  };

  return (
    <MarketingLayout mainLabel="ShieldKit fix library">
      <JsonLd data={itemListJsonLd} />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 pt-14 sm:pt-20 pb-10">
        <div className="text-center max-w-3xl mx-auto">
          <span className="inline-flex items-center rounded-full bg-white/70 border border-brand-card-border px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand-navy">
            Fix Library
          </span>
          <h1 className="mt-4 text-4xl sm:text-5xl font-extrabold leading-[1.1] text-brand-navy">
            Google Merchant Center Error Fix Library for Shopify
          </h1>
          <p className="mt-5 text-lg text-brand-gray-text">
            {FIXES.length} step-by-step fixes for the specific errors Google
            Merchant Center surfaces on Shopify stores, from missing GTINs to
            account-level suspensions. Every page lists Google's exact error
            text, the cause, and the fix.
          </p>
          <p className="mt-3 text-base text-brand-gray-text">
            Browse by category below, or use the{" "}
            <Link to="/scan" className="underline font-semibold text-brand-navy">
              free compliance scan
            </Link>{" "}
            to find which errors apply to your store.
          </p>
        </div>
      </section>

      {/* Categories */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 pb-12">
        {CATEGORIES.map((cat) => (
          <div key={cat.title} className="mt-12 first:mt-0">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-brand-navy">
              {cat.title}
            </h2>
            <p className="mt-2 text-brand-gray-text">{cat.intro}</p>
            <div className="mt-6 grid sm:grid-cols-2 gap-4">
              {cat.slugs.map((slug) => {
                const fix = getFix(slug);
                return (
                  <Link
                    key={slug}
                    to={`/fix/${slug}`}
                    className="group block rounded-xl bg-white border border-brand-card-border shadow-card p-5 hover:border-brand-navy/30 transition"
                  >
                    <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text font-mono">
                      {fix.errorCode}
                    </div>
                    <h3 className="mt-2 text-base font-bold text-brand-navy leading-snug group-hover:underline">
                      {fix.title}
                    </h3>
                    <p className="mt-2 text-sm text-brand-gray-text leading-relaxed">
                      {fix.description}
                    </p>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 pb-20">
        <div className="rounded-3xl bg-brand-navy text-white p-10 sm:p-14 text-center shadow-card">
          <h2 className="text-3xl sm:text-4xl font-extrabold !text-white">
            Not sure which error is yours?
          </h2>
          <p className="mt-3 text-white/80 max-w-xl mx-auto">
            Run a free compliance scan in under two minutes. We surface the
            specific errors your store is tripping and link straight to each
            fix.
          </p>
          <div className="mt-7 flex justify-center gap-3 flex-wrap">
            <MarketingButton to="/scan" variant="onLight" size="lg">
              Run Free Scan
            </MarketingButton>
            <MarketingButton
              to="/blog"
              size="lg"
              className="bg-transparent border border-white !text-white hover:bg-white/10"
            >
              Read the blog
            </MarketingButton>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
