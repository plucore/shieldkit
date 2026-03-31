/**
 * app/hooks/useScanToast.ts
 *
 * Fires a toast notification when a scan completes. Deduplicates by scanId
 * so the same scan doesn't trigger multiple toasts on revalidation.
 */

import { useEffect, useState } from "react";

export function useScanToast(
  fetcherState: string,
  scanId: string | undefined,
  showToast: (message: string) => void,
  revalidate: () => void,
): void {
  const [lastToastId, setLastToastId] = useState<string | null>(null);

  useEffect(() => {
    if (fetcherState === "idle" && scanId && scanId !== lastToastId) {
      showToast("Compliance checked");
      setLastToastId(scanId);
      revalidate();
    }
  }, [fetcherState, scanId, showToast, revalidate, lastToastId]);
}
