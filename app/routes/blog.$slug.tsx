import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData, isRouteErrorResponse, useRouteError } from "react-router";

import { MarketingArticleLayout } from "../components/marketing/MarketingArticleLayout";
import { MarketingLayout } from "../components/marketing/MarketingLayout";
import { JsonLd } from "../components/marketing/JsonLd";
import { SITE } from "../lib/brand";
import { getPostBySlug, type PostFrontmatter } from "../lib/blog";
import marketingStyles from "../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/app?${url.searchParams.toString()}` },
    });
  }

  const slug = params.slug ?? "";
  const post = getPostBySlug(slug);
  if (!post) {
    throw new Response("Not found", { status: 404 });
  }

  // We can't return the React component over the loader boundary (it's not
  // serializable), so we re-resolve it inside the component via the same
  // helper. Loader returns frontmatter + slug only.
  return { slug, frontmatter: post.frontmatter };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: "Post not found | ShieldKit" }];
  const fm = data.frontmatter as PostFrontmatter;
  const url = `${SITE.url}/blog/${fm.slug}`;
  return [
    { title: `${fm.title} | ShieldKit` },
    { name: "description", content: fm.description },
    { name: "keywords", content: (fm.keywords ?? []).join(", ") },
    { property: "og:title", content: fm.title },
    { property: "og:description", content: fm.description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: url },
    { property: "og:image", content: SITE.url + SITE.ogImage },
    { property: "article:published_time", content: fm.publishedAt },
    { property: "article:author", content: "ShieldKit Team" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: fm.title },
    { name: "twitter:description", content: fm.description },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

export default function BlogPost() {
  const { slug, frontmatter } = useLoaderData<typeof loader>();
  const post = getPostBySlug(slug);

  if (!post) {
    return (
      <MarketingLayout>
        <div className="mx-auto max-w-prose px-4 py-20 text-center">
          <h1 className="text-3xl font-extrabold">Post not found</h1>
        </div>
      </MarketingLayout>
    );
  }

  const Content = post.default;
  const fm = frontmatter as PostFrontmatter;
  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: fm.title,
    description: fm.description,
    keywords: (fm.keywords ?? []).join(", "),
    author: { "@type": "Organization", name: "ShieldKit Team" },
    publisher: {
      "@type": "Organization",
      name: "ShieldKit",
      logo: { "@type": "ImageObject", url: SITE.url + "/logo-main.png" },
    },
    datePublished: fm.publishedAt,
    dateModified: fm.publishedAt,
    mainEntityOfPage: `${SITE.url}/blog/${fm.slug}`,
  };

  return (
    <>
      <JsonLd data={articleJsonLd} />
      <MarketingArticleLayout
        title={fm.title}
        subtitle={fm.description}
        publishedAt={fm.publishedAt}
      >
        <Content />
      </MarketingArticleLayout>
    </>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <MarketingLayout>
      <div className="mx-auto max-w-prose px-4 py-20 text-center">
        <h1 className="text-3xl font-extrabold">
          {status === 404 ? "Post not found" : "Something went wrong"}
        </h1>
        <p className="mt-3 text-brand-gray-text">
          {status === 404
            ? "The post you're looking for doesn't exist."
            : "Please try again in a moment."}
        </p>
      </div>
    </MarketingLayout>
  );
}
