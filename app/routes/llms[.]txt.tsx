import { getAllPosts } from "../lib/blog";
import { FIXES } from "../content/fixes";
import { SITE } from "../lib/brand";

/**
 * /llms.txt — discovery file for AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
 * etc.). Mirrors the marketing surface area; rebuilds with each blog post or
 * fix entry add.
 */
export async function loader() {
  const posts = getAllPosts();

  const blogLines = posts
    .map((p) => `- [${p.title}](${SITE.url}/blog/${p.slug}) — ${p.description}`)
    .join("\n");

  // Newest fixes first.
  const sortedFixes = [...FIXES].sort((a, b) =>
    a.publishedAt < b.publishedAt ? 1 : -1
  );
  const fixLines = sortedFixes
    .map(
      (f) =>
        `- [${f.errorCode}: ${f.title}](${SITE.url}/fix/${f.slug})`
    )
    .join("\n");

  const body = `# ShieldKit
> Free Shopify compliance scanner that catches Google Merchant Center issues before they trigger ad suspension. Plus AI-search visibility tools — JSON-LD schema, llms.txt, and AI bot controls.

## Tools
- [Free compliance scan](${SITE.url}/scan)
- [Install on Shopify](${SITE.installUrl})

## Documentation
- [GMC compliance explainer](${SITE.url}/explainer)
- [Privacy Policy](${SITE.url}/privacy)
- [Terms of Service](${SITE.url}/terms)

## Blog
${blogLines}

## Fix Library
${fixLines}

## Contact
hello@shieldkit.app
`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
