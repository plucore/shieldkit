/**
 * app/lib/rate-limiter.server.ts
 *
 * In-memory rate limiter for scan API requests.
 * Tracks request timestamps per shop within a sliding window.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;
const scanRateMap = new Map<string, number[]>();

export function checkRateLimit(shop: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (scanRateMap.get(shop) ?? []).filter((t) => t > cutoff);
  scanRateMap.set(shop, timestamps);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const oldestInWindow = timestamps[0];
    const retryAfterSeconds = Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - timestamps.length, retryAfterSeconds: 0 };
}

export function recordScanRequest(shop: string): void {
  const timestamps = scanRateMap.get(shop) ?? [];
  timestamps.push(Date.now());
  scanRateMap.set(shop, timestamps);
}

/** Exposed for testing — max requests allowed per window. */
export const RATE_LIMIT_MAX_REQUESTS = RATE_LIMIT_MAX;
