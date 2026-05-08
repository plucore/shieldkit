import { getAllPosts } from "../lib/blog";
import { FIXES } from "../content/fixes";
import { SITE } from "../lib/brand";

interface Entry {
  loc: string;
  lastmod: string;
  changefreq: "weekly" | "monthly" | "yearly";
  priority: string;
}

/**
 * /sitemap.xml — generated server-side from the static page list, the
 * blog post registry, and the programmatic /fix/<slug> library. No
 * component export; loader returns XML directly.
 */
export async function loader() {
  const today = new Date().toISOString().slice(0, 10);
  const posts = getAllPosts();

  const staticEntries: Entry[] = [
    { loc: "/", lastmod: today, changefreq: "monthly", priority: "1.0" },
    { loc: "/scan", lastmod: today, changefreq: "monthly", priority: "0.9" },
    { loc: "/explainer", lastmod: today, changefreq: "monthly", priority: "0.8" },
    { loc: "/blog", lastmod: today, changefreq: "weekly", priority: "0.8" },
  ];

  const postEntries: Entry[] = posts.map((p) => ({
    loc: `/blog/${p.slug}`,
    lastmod: p.publishedAt,
    changefreq: "monthly",
    priority: "0.7",
  }));

  const fixEntries: Entry[] = FIXES.map((f) => ({
    loc: `/fix/${f.slug}`,
    lastmod: f.publishedAt,
    changefreq: "monthly",
    priority: "0.6",
  }));

  const all = [...staticEntries, ...postEntries, ...fixEntries];

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    all
      .map(
        (e) =>
          `  <url>\n    <loc>${SITE.url}${e.loc}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
