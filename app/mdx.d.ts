/**
 * Type declaration for *.mdx imports — required so TS understands what an
 * imported MDX module exposes (a React component default + named exports).
 */
declare module "*.mdx" {
  import type { ComponentType } from "react";
  export const frontmatter: {
    title: string;
    slug: string;
    description: string;
    publishedAt: string;
    keywords?: string[];
  };
  const Component: ComponentType<{ components?: Record<string, ComponentType<unknown>> }>;
  export default Component;
}
