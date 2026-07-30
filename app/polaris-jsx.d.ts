/**
 * app/polaris-jsx.d.ts
 *
 * JSX declarations for the Polaris web components this app uses.
 *
 * ── WHY THIS REPLACES @shopify/polaris-types ────────────────────────────────
 *
 * `npm run typecheck` carried 44 standing errors and could therefore never
 * pass, which is not a gate — proving "no regression" in PR #19 meant stashing
 * a base commit and diffing error sets by hand. Nearly all 44 came from
 * @shopify/polaris-types being wrong about this codebase in three ways, none of
 * which are fixable in a component:
 *
 *  1. `s-card` is not declared AT ALL (18 errors: "Property 's-card' does not
 *     exist on type 'JSX.IntrinsicElements'").
 *  2. Element refs are typed `Ref<Button>`, but `useWebComponentClick` returns
 *     `RefObject<HTMLElement | null>` — and RefObject is invariant, so the
 *     assignment can never succeed (17 errors). The hook is deliberate: React's
 *     synthetic onClick does not fire on these elements (claude.md §11), so a
 *     native listener via ref is the only option.
 *  3. The `IconType` union in polaris.d.ts is STALE AGAINST THE RUNTIME
 *     MANIFEST SHIPPED IN THE SAME PACKAGE. `x-circle-filled`, `info-filled`
 *     and `alert-triangle-filled` are all present in
 *     dist/custom-elements.json (appended after the base union) and absent from
 *     dist/polaris.d.ts, so valid icons were reported as errors (3).
 *
 * claude.md §11 says these gaps work at runtime and must NOT be "fixed" in the
 * components. Honouring that while keeping a usable gate means the declarations
 * have to move, so this file supersedes the package (removed from
 * tsconfig.compilerOptions.types). No component was changed.
 *
 * ── WHAT IS STILL CHECKED ───────────────────────────────────────────────────
 *
 * This is deliberately NOT a blanket `[tag: string]: any` escape hatch:
 *
 *  - Only the ten tags this app actually uses are declared, so `<s-crad>` or a
 *    tag nobody has vetted still fails.
 *  - `tone` keeps the REAL union from custom-elements.json. That is load-bearing:
 *    it is what still catches `tone="subdued"` in PlanStatusCard.tsx:173,180 —
 *    a genuine bug (subdued is a valid `background`/`borderColor` value but has
 *    never been a valid `tone`), deliberately left visible rather than masked.
 *    The intended muted tone is `neutral`.
 *  - `size` unions are kept where they are small and stable.
 *
 * `type` on s-icon is intentionally `string`: the authoritative list is
 * custom-elements.json, which the bundled .d.ts already disagrees with, so
 * pinning a union here would just re-import the staleness. Validate icon names
 * against dist/custom-elements.json, not against a copy in this repo.
 *
 * If Polaris ships types that know about s-card, accept a widened ref, and match
 * their own manifest, delete this file and put the package back in `types`.
 */

import type * as React from "react";

/** The real tone union, from dist/custom-elements.json. Keep it strict. */
type PolarisTone =
  | "auto"
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

/**
 * Base props shared by every Polaris element.
 *
 * The index signature covers the long tail of element-specific attributes
 * (`variant`, `submit`, `loading`, `heading`, `href`, …) which are real at
 * runtime and which claude.md §11 documents as absent from the TS defs.
 * Explicitly declared members below still take precedence, so narrowing a prop
 * (see `tone`) continues to be enforced.
 *
 * `ref` is `any` on purpose — this is gap (2) above. Every call site goes
 * through useWebComponentClick, whose RefObject<HTMLElement | null> cannot be
 * assigned to an invariant RefObject<SpecificElement>.
 */
interface PolarisBaseProps {
  children?: React.ReactNode;
  key?: React.Key | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref?: any;
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  slot?: string;
  /**
   * Native DOM events — these elements are web components, so the payload is a
   * real `Event` and `currentTarget` is the custom element, NOT a React
   * SyntheticEvent. Declared explicitly rather than left to the index signature
   * because an inline `onChange={(e) => …}` would otherwise have no contextual
   * type and trip noImplicitAny at the call site.
   *
   * `currentTarget` is widened to include `value` so the text-field pattern
   * `e.currentTarget.value` type-checks without a cast.
   */
  onClick?: (event: Event) => void;
  onChange?: (event: Event & { currentTarget: EventTarget & { value: string } }) => void;
  onInput?: (event: Event & { currentTarget: EventTarget & { value: string } }) => void;
  onSubmit?: (event: Event) => void;
  [attribute: string]: unknown;
}

interface PolarisTonedProps extends PolarisBaseProps {
  tone?: PolarisTone;
}

declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        "s-page": PolarisBaseProps;
        "s-section": PolarisBaseProps;
        "s-card": PolarisBaseProps;
        "s-paragraph": PolarisBaseProps;
        "s-link": PolarisBaseProps;
        "s-text-field": PolarisBaseProps;
        "s-button": PolarisTonedProps;
        "s-banner": PolarisTonedProps;
        "s-badge": PolarisTonedProps;
        "s-icon": PolarisTonedProps & {
          /** See the header: custom-elements.json is authoritative, not a union here. */
          type?: string;
          size?: "small" | "base" | "large";
        };
      }
    }
  }
}

/**
 * `fetchpriority` is a real HTML attribute (used on the LCP image in
 * app._index.tsx) that @types/react has not added yet. Interface augmentation
 * on the specific element, so every other img attribute stays checked.
 *
 * Deliberately NOT a global `[elemName: string]: unknown` index signature — that
 * would silence type checking on every standard HTML element in the app, which
 * is a far bigger hole than the one being closed.
 */
declare module "react" {
  interface ImgHTMLAttributes<T> {
    fetchpriority?: "high" | "low" | "auto";
  }
}

export {};
