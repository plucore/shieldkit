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
 *
 * Pass `disabled` (e.g. a submitting/in-flight flag) to ignore clicks while an
 * action is running. This complements the `disabled` attribute on the button:
 * the attribute prevents clicks after React re-renders, and this gate stops any
 * that still reach the native listener. For synchronous same-tick re-entrancy
 * (mashing before state flips), wrap the handler with useSingleFlight.
 */

import { useRef, useEffect } from "react";

export function useWebComponentClick<T extends HTMLElement = HTMLElement>(
  handler: (() => void) | undefined,
  disabled = false,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !handler) return;
    const listener = () => {
      if (disabled) return;
      handler();
    };
    el.addEventListener("click", listener);
    return () => el.removeEventListener("click", listener);
  }, [handler, disabled]);

  return ref;
}
