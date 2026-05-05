/**
 * app/lib/ai-visibility/identify-crawler.server.ts
 *
 * Phase 7.2 — Server-side re-export. The actual implementation lives in
 * the non-server sibling so client components (AIVisibilityCard) can
 * import it without dragging server-only deps into the bundle.
 */

export { identifyCrawler, wowDeltaPct } from "./identify-crawler";
