/**
 * app/hooks/useWebComponentClick.ts
 *
 * Hook for attaching click handlers to Shopify Polaris web components
 * (e.g. <s-button>). React's synthetic onClick does NOT fire on custom
 * elements — they use native DOM events that bypass React's event system.
 *
 * Usage:
 *   const ref = useWebComponentClick<HTMLElement>(handler);
 *   <s-button ref={ref}>Click me</s-button>
 */

import { useRef, useEffect } from "react";

export function useWebComponentClick<T extends HTMLElement = HTMLElement>(
  handler: (() => void) | undefined,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !handler) return;
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [handler]);

  return ref;
}
