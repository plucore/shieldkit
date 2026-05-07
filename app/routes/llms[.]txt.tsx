import { getAllPosts } from "../lib/blog";
import { SITE } from "../lib/brand";

/**
 * /llms.txt — discovery file for AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
 * etc.). Mirrors the marketing surface area; rebuilds with each blog post add.
 */
export async function loader() {
  const posts = getAllPosts();

  const blogLines = posts
    .map((p) => `- [${p.title}](${SITE.url}/blog/${p.slug}) — ${p.description}`)
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
