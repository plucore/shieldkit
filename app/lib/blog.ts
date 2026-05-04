/**
 * app/lib/blog.ts
 *
 * Blog post registry. Sources of truth are the .mdx files in
 * app/content/blog/. Each post exports a `frontmatter` object and a
 * default React component (the rendered MDX).
 */
import type { ComponentType } from "react";

export interface PostFrontmatter {
  title: string;
  slug: string;
  description: string;
  publishedAt: string; // ISO date YYYY-MM-DD
  keywords?: string[];
}

export interface PostModule {
  frontmatter: PostFrontmatter;
  default: ComponentType;
}

// import.meta.glob with eager:true gives us synchronous access to the
// modules at build time, which is what we want for both the listing
// loader and the per-slug renderer.
const modules = import.meta.glob<PostModule>("../content/blog/*.mdx", {
  eager: true,
});

export interface PostSummary extends PostFrontmatter {
  /** Internal map key — only used by getPostBySlug. */
  _key: string;
}

const allPosts: PostSummary[] = Object.entries(modules)
  .map(([key, mod]) => ({ _key: key, ...mod.frontmatter }))
  .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

export function getAllPosts(): PostSummary[] {
  return allPosts;
}

export function getPostBySlug(slug: string): PostModule | null {
  for (const [key, mod] of Object.entries(modules)) {
    if (mod.frontmatter.slug === slug) {
      // Type discriminant: include the original module key for debug only.
      void key;
      return mod;
    }
  }
  return null;
}
