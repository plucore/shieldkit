import type { ReactNode } from "react";
import { MarketingLayout } from "./MarketingLayout";
import { MarketingButton } from "./Button";

interface ArticleLayoutProps {
  title: string;
  subtitle?: string;
  publishedAt?: string;
  author?: string;
  children: ReactNode;
  /** Optional final CTA — defaults to a "run a free scan" card. */
  cta?: ReactNode;
}

/**
 * Shared layout for the explainer page and individual blog posts.
 * Renders the marketing chrome + a centered article column with prose
 * styling defined in marketing.css (.shieldkit-prose).
 */
export function MarketingArticleLayout({
  title,
  subtitle,
  publishedAt,
  author = "ShieldKit Team",
  children,
  cta,
}: ArticleLayoutProps) {
  return (
    <MarketingLayout mainLabel={title}>
      <article className="mx-auto max-w-prose px-4 sm:px-6 pt-12 sm:pt-16 pb-8">
        <header className="mb-10">
          <h1 className="text-3xl sm:text-5xl font-extrabold text-brand-navy leading-[1.1]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-4 text-lg text-brand-gray-text leading-relaxed">
              {subtitle}
            </p>
          )}
          <div className="mt-5 text-sm text-brand-gray-text flex items-center gap-3">
            <span>By {author}</span>
            {publishedAt && (
              <>
                <span aria-hidden>·</span>
                <time dateTime={publishedAt}>
                  {new Date(publishedAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
              </>
            )}
          </div>
        </header>

        <div className="shieldkit-prose">{children}</div>
      </article>

      <section className="mx-auto max-w-prose px-4 sm:px-6 pb-20">
        {cta ?? <DefaultCta />}
      </section>
    </MarketingLayout>
  );
}

function DefaultCta() {
  return (
    <div className="rounded-2xl bg-brand-navy text-white p-8 text-center shadow-card">
      <h3 className="text-2xl font-extrabold">
        Find out what's flagged on your store
      </h3>
      <p className="mt-2 text-white/80">
        Run a free 8-point compliance scan in under 60 seconds.
      </p>
      <div className="mt-5 flex justify-center">
        <MarketingButton
          to="/scan"
          size="md"
          className="bg-white !text-brand-navy hover:bg-white/90"
        >
          Run a free scan
        </MarketingButton>
      </div>
    </div>
  );
}
