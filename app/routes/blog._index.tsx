import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { Link, useLoaderData } from "react-router";

import { MarketingLayout } from "../components/marketing/MarketingLayout";
import { SITE } from "../lib/brand";
import { getAllPosts } from "../lib/blog";
import marketingStyles from "../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/app?${url.searchParams.toString()}` },
    });
  }
  return { posts: getAllPosts() };
}

export const meta: MetaFunction = () => {
  const title = "Compliance & Visibility Blog | ShieldKit";
  const description =
    "Practical guides for Shopify merchants on Google Merchant Center compliance, suspension recovery, and AI search visibility.";
  const url = SITE.url + "/blog";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: url },
    { property: "og:image", content: SITE.url + SITE.ogImage },
    { name: "twitter:card", content: "summary_large_image" },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

export default function BlogIndex() {
  const { posts } = useLoaderData<typeof loader>();
  return (
    <MarketingLayout mainLabel="ShieldKit blog">
      <section className="mx-auto max-w-5xl px-4 sm:px-6 pt-14 sm:pt-20 pb-10">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-extrabold leading-[1.1]">
            Compliance & Visibility Blog
          </h1>
          <p className="mt-4 text-lg text-brand-gray-text">
            How Shopify merchants stay compliant with Google and visible in AI
            search.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 sm:px-6 pb-20">
        {posts.length === 0 ? (
          <p className="text-center text-brand-gray-text">
            No posts published yet.
          </p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-6">
            {posts.map((post) => (
              <Link
                key={post.slug}
                to={`/blog/${post.slug}`}
                className="group rounded-2xl bg-white border border-brand-card-border shadow-card p-6 hover:border-brand-navy/30 transition"
              >
                <time
                  dateTime={post.publishedAt}
                  className="text-xs font-bold uppercase tracking-wider text-brand-gray-text"
                >
                  {new Date(post.publishedAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
                <h2 className="mt-3 text-xl font-extrabold text-brand-navy leading-snug group-hover:underline">
                  {post.title}
                </h2>
                <p className="mt-2 text-brand-gray-text text-sm leading-relaxed">
                  {post.description}
                </p>
                <span className="mt-4 inline-flex items-center text-sm font-semibold text-brand-navy">
                  Read more →
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </MarketingLayout>
  );
}
