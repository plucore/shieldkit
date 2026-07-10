import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Slugs are sourced from the content registries at build time so the prerender
// list never drifts from the actual routes. We read the files directly rather
// than importing app/lib/blog.ts because that module uses `import.meta.glob`,
// a Vite-only transform that is not applied to this config file.
const CONTENT_DIR = join(process.cwd(), "app", "content");

function blogSlugs(): string[] {
  const dir = join(CONTENT_DIR, "blog");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => {
      const src = readFileSync(join(dir, file), "utf8");
      const match = src.match(/slug:\s*["']([^"']+)["']/);
      if (!match) {
        throw new Error(`blog post ${file} has no slug in its frontmatter`);
      }
      return match[1];
    });
}

function fixSlugs(): string[] {
  const src = readFileSync(join(CONTENT_DIR, "fixes.ts"), "utf8");
  const slugs = [...src.matchAll(/^\s*slug:\s*["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
  if (slugs.length === 0) {
    throw new Error("no fix slugs found in app/content/fixes.ts");
  }
  return slugs;
}

export default {
  ssr: true,
  presets: [vercelPreset()],
  // Prerender the static marketing routes to HTML at build time so Vercel
  // serves them from the CDN instead of cold-starting a streaming SSR function
  // on every hit. `/` is intentionally excluded — its loader redirects
  // ?shop=... visitors to /app and must stay dynamic.
  //
  // /sitemap.xml and /llms.txt are resource routes (loader-only) whose bodies
  // are pure functions of the static content registries — no per-request data —
  // so they prerender to static files too, keeping crawler/AI-bot hits off the
  // 1.1MB SSR function. (/robots.txt is served as a static public/ file.)
  async prerender() {
    return [
      "/blog",
      "/fix",
      "/explainer",
      "/privacy",
      "/terms",
      "/sitemap.xml",
      "/llms.txt",
      ...blogSlugs().map((slug) => `/blog/${slug}`),
      ...fixSlugs().map((slug) => `/fix/${slug}`),
    ];
  },
} satisfies Config;
