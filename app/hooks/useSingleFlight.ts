/**
 * app/hooks/useSingleFlight.ts
 *
 * Wraps a mutating callback so it fires at most once until its action settles.
 *
 * Why: generation/mutation buttons fire concurrent POSTs when mashed. Setting
 * the button's `disabled` attribute only helps AFTER React re-renders with the
 * in-flight state — clicks in the SAME event-loop tick (before the state flips)
 * still get through, which is exactly how 5 appeal letters were generated from
 * one scan. A synchronous ref guard closes that window: the first call flips
 * the guard immediately, so any same-tick repeats bail out. The guard resets
 * once `busy` returns to false (the action finished).
 *
 * Usage:
 *   const isScanning = fetcher.state !== "idle";
 *   const runScanOnce = useSingleFlight(runScan, isScanning);
 *   const ref = useWebComponentClick(runScanOnce, isScanning);
 *   <s-button ref={ref} {...(isScanning ? { loading: "", disabled: "" } : {})} />
 */

import { useCallback, useEffect, useRef } from "react";

export function useSingleFlight(
  fn: () => void,
  busy: boolean,
): () => void {
  const firedRef = useRef(false);

  // Release the guard once the action is no longer in flight.
  useEffect(() => {
    if (!busy) firedRef.current = false;
  }, [busy]);

  return useCallback(() => {
    if (busy || firedRef.current) return;
    firedRef.current = true;
    fn();
  }, [fn, busy]);
}
