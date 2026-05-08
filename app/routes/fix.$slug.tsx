import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData, isRouteErrorResponse, useRouteError } from "react-router";

import { MarketingLayout } from "../components/marketing/MarketingLayout";
import { MarketingButton } from "../components/marketing/Button";
import { JsonLd } from "../components/marketing/JsonLd";
import { SITE } from "../lib/brand";
import { FIXES, getFixBySlug, type Fix } from "../content/fixes";
import marketingStyles from "../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Preserve embedded-app flow consistency with other public routes.
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/app?${url.searchParams.toString()}` },
    });
  }

  const slug = params.slug ?? "";
  const fix = getFixBySlug(slug);
  if (!fix) {
    throw new Response("Not found", { status: 404 });
  }
  return { fix };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: "Fix not found | ShieldKit" }];
  const fix = data.fix as Fix;
  const url = `${SITE.url}/fix/${fix.slug}`;
  return [
    { title: `${fix.title} | ShieldKit` },
    { name: "description", content: fix.description },
    { name: "keywords", content: fix.keywords.join(", ") },
    { property: "og:title", content: fix.title },
    { property: "og:description", content: fix.description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: url },
    { property: "og:image", content: SITE.url + SITE.ogImage },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: fix.title },
    { name: "twitter:description", content: fix.description },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

export default function FixPage() {
  const { fix } = useLoaderData<typeof loader>();
  const url = `${SITE.url}/fix/${fix.slug}`;

  const howToJsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: fix.title,
    description: fix.description,
    totalTime: "PT15M",
    step: fix.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.title,
      text: s.body,
    })),
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: fix.faqs.map((q) => ({
      "@type": "Question",
      name: q.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: q.answer,
      },
    })),
  };

  const relatedFixObjects = fix.relatedFixes
    .map((slug) => FIXES.find((f) => f.slug === slug))
    .filter((f): f is Fix => Boolean(f));

  return (
    <MarketingLayout mainLabel={fix.title}>
      <JsonLd data={howToJsonLd} />
      <JsonLd data={faqJsonLd} />
      <article className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
        <div className="mb-3 text-xs font-bold uppercase tracking-wider text-brand-gray-text">
          Fix Library
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-brand-navy leading-tight">
          {fix.title}
        </h1>
        <p className="mt-4 text-lg text-brand-gray-text leading-relaxed">
          {fix.description}
        </p>

        <aside
          aria-label="Google's exact error"
          className="mt-8 rounded-xl border border-brand-card-border bg-white p-5 shadow-card"
        >
          <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text">
            Google's exact error
          </div>
          <code className="mt-2 block font-mono text-base text-brand-navy">
            {fix.errorCode}
          </code>
        </aside>

        <section className="mt-12">
          <h2 className="text-2xl font-extrabold text-brand-navy">
            What this means
          </h2>
          <p className="mt-3 text-brand-gray-text leading-relaxed">
            {fix.cause}
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-extrabold text-brand-navy">
            How to fix it
          </h2>
          <ol className="mt-5 space-y-5">
            {fix.steps.map((step, i) => (
              <li
                key={step.title}
                className="rounded-xl border border-brand-card-border bg-white p-5 shadow-card"
              >
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-navy text-white text-sm font-bold">
                    {i + 1}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-brand-navy">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-brand-gray-text leading-relaxed">
                      {step.body}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {relatedFixObjects.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-extrabold text-brand-navy">
              Related fixes
            </h2>
            <div className="mt-5 grid sm:grid-cols-2 gap-4">
              {relatedFixObjects.map((rf) => (
                <a
                  key={rf.slug}
                  href={`/fix/${rf.slug}`}
                  className="block rounded-xl border border-brand-card-border bg-white p-5 shadow-card hover:border-brand-navy transition"
                >
                  <div className="text-xs font-mono text-brand-gray-text">
                    {rf.errorCode}
                  </div>
                  <div className="mt-1.5 font-bold text-brand-navy">
                    {rf.title}
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        {fix.relatedPosts.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-extrabold text-brand-navy">
              Related reading
            </h2>
            <ul className="mt-3 space-y-2">
              {fix.relatedPosts.map((slug) => (
                <li key={slug}>
                  <a
                    href={`/blog/${slug}`}
                    className="text-brand-navy underline hover:opacity-80"
                  >
                    /blog/{slug}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-12">
          <h2 className="text-2xl font-extrabold text-brand-navy">FAQ</h2>
          <div className="mt-5 space-y-3">
            {fix.faqs.map((faq) => (
              <details
                key={faq.question}
                className="group rounded-xl border border-brand-card-border bg-white p-5 shadow-card"
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-semibold text-brand-navy">
                  <span>{faq.question}</span>
                  <span className="text-xl leading-none text-brand-gray-text transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-brand-gray-text leading-relaxed text-[15px]">
                  {faq.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section className="mt-12 text-sm text-brand-gray-text">
          For Google's official policy on this error, see{" "}
          <a
            href={fix.outboundHelp.url}
            rel="noopener noreferrer"
            target="_blank"
            className="underline"
          >
            {fix.outboundHelp.label}
          </a>
          .
        </section>

        <section className="mt-16 rounded-2xl bg-brand-navy text-white p-8 sm:p-10 text-center shadow-card">
          <h2 className="text-2xl sm:text-3xl font-extrabold !text-white">
            Run a free compliance audit
          </h2>
          <p className="mt-3 text-white/80 max-w-xl mx-auto">
            ShieldKit's scanner runs the same 12 checks Google's AI crawlers
            run — find every issue on your store in five minutes, no install.
          </p>
          <div className="mt-6 flex justify-center">
            <MarketingButton to="/scan" variant="onLight" size="lg">
              Run Free Compliance Scan
            </MarketingButton>
          </div>
        </section>

        <p className="mt-12 text-xs text-brand-gray-text" aria-hidden>
          Page URL: {url}
        </p>
      </article>
    </MarketingLayout>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <MarketingLayout>
      <div className="mx-auto max-w-prose px-4 py-20 text-center">
        <h1 className="text-3xl font-extrabold">
          {status === 404 ? "Fix not found" : "Something went wrong"}
        </h1>
        <p className="mt-3 text-brand-gray-text">
          {status === 404
            ? "We don't have a fix page for that slug yet."
            : "Please try again in a moment."}
        </p>
        <p className="mt-6">
          <a className="underline" href="/blog">
            Browse the blog
          </a>{" "}
          or{" "}
          <a className="underline" href="/scan">
            run a compliance scan
          </a>
          .
        </p>
      </div>
    </MarketingLayout>
  );
}
