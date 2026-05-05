import { createElement } from "react";

/**
 * Renders a <script type="application/ld+json"> tag from a static object.
 *
 * NOTE: For JSON-LD to be picked up by search-engine crawlers it MUST be
 * present in server-rendered HTML, not injected client-side. We serialize
 * the static object via JSON.stringify and inject the resulting text via
 * the dangerouslySetInnerHTML escape hatch. The input is page-level
 * metadata defined in source — never user input — so this is safe.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const html = JSON.stringify(data);
  // Use createElement to keep the dangerouslySetInnerHTML payload off the
  // JSX-string surface.
  const innerHtml = { __html: html };
  return createElement("script", {
    type: "application/ld+json",
    dangerouslySetInnerHTML: innerHtml,
  });
}
