/**
 * app/lib/rate-limiter.server.ts
 *
 * Persistent rate limiter for scan API requests.
 * Uses the Supabase `scan_rate_limits` table for persistence across
 * serverless invocations and deploys.
 *
 * Falls back to in-memory limiting if the DB table doesn't exist yet.
 */

import { supabase } from "../supabase.server";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;

// In-memory fallback (used if DB table not yet deployed)
const scanRateMap = new Map<string, number[]>();

export async function checkRateLimit(
  shop: string
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  // Try persistent check first
  const { data, error } = await supabase
    .from("scan_rate_limits")
    .select("requested_at")
    .eq("shop", shop)
    .gte("requested_at", cutoff)
    .order("requested_at", { ascending: true });

  if (error) {
    // Table might not exist yet — fall back to in-memory
    return checkRateLimitInMemory(shop);
  }

  // Clean up old records (fire-and-forget)
  supabase
    .from("scan_rate_limits")
    .delete()
    .lt("requested_at", cutoff)
    .then(() => {});

  const count = data?.length ?? 0;

  if (count >= RATE_LIMIT_MAX) {
    const oldest = data![0].requested_at;
    const oldestMs = new Date(oldest).getTime();
    const retryAfterSeconds = Math.ceil(
      (oldestMs + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000
    );
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - count, retryAfterSeconds: 0 };
}

export async function recordScanRequest(shop: string): Promise<void> {
  const { error } = await supabase
    .from("scan_rate_limits")
    .insert({ shop });

  if (error) {
    // Fall back to in-memory if table doesn't exist
    recordScanRequestInMemory(shop);
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────

function checkRateLimitInMemory(
  shop: string
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (scanRateMap.get(shop) ?? []).filter((t) => t > cutoff);
  scanRateMap.set(shop, timestamps);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const oldestInWindow = timestamps[0];
    const retryAfterSeconds = Math.ceil(
      (oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000
    );
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - timestamps.length, retryAfterSeconds: 0 };
}

function recordScanRequestInMemory(shop: string): void {
  const timestamps = scanRateMap.get(shop) ?? [];
  timestamps.push(Date.now());
  scanRateMap.set(shop, timestamps);
}

/** Exposed for testing — max requests allowed per window. */
export const RATE_LIMIT_MAX_REQUESTS = RATE_LIMIT_MAX;
