import { getAllPosts } from "../lib/blog";
import { FIXES } from "../content/fixes";
import { SITE } from "../lib/brand";

interface Entry {
  loc: string;
  /**
   * `lastmod` is optional. If omitted the entry is emitted without a
   * `<lastmod>` element. Per Google's sitemap guidance, an inaccurate
   * lastmod is worse than no lastmod — so static entries omit it unless
   * we have a real last-changed date.
   */
  lastmod?: string;
  changefreq: "weekly" | "monthly" | "yearly";
  priority: string;
}

/**
 * /sitemap.xml — generated server-side from the static page list, the
 * blog post registry, and the programmatic /fix/<slug> library. No
 * component export; loader returns XML directly.
 *
 * Static entries (/, /scan, /explainer, /blog) intentionally omit
 * <lastmod> — using `new Date()` on every request told Google those pages
 * changed daily, which trained it to ignore the signal. Blog and fix entries
 * use real `publishedAt` dates from their source registries.
 *
 * The /fix index page is new — today is the honest initial lastmod, set
 * once at module load below.
 */
const FIX_INDEX_LASTMOD = new Date().toISOString().slice(0, 10);

export async function loader() {
  const posts = getAllPosts();

  const staticEntries: Entry[] = [
    { loc: "/", changefreq: "monthly", priority: "1.0" },
    { loc: "/scan", changefreq: "monthly", priority: "0.9" },
    { loc: "/explainer", changefreq: "monthly", priority: "0.8" },
    { loc: "/blog", changefreq: "weekly", priority: "0.8" },
    {
      loc: "/fix",
      lastmod: FIX_INDEX_LASTMOD,
      changefreq: "monthly",
      priority: "0.8",
    },
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
      .map((e) => {
        const lastmodEl = e.lastmod
          ? `\n    <lastmod>${e.lastmod}</lastmod>`
          : "";
        return `  <url>\n    <loc>${SITE.url}${e.loc}</loc>${lastmodEl}\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`;
      })
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
