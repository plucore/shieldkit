/**
 * app/lib/rate-limiter.server.ts
 *
 * Persistent rate limiter for scan requests, keyed on an arbitrary string.
 * Uses the Supabase `scan_rate_limits` table for persistence across serverless
 * invocations and deploys, falling back to in-memory limiting if the DB table
 * doesn't exist yet.
 *
 * Callers pass whatever identity they want to limit on:
 *   - the authenticated /api/scan endpoint keys on the shop domain (default max)
 *   - the public /scan action keys on the client IP (`ip:<addr>`) with a
 *     tighter cap (PUBLIC_SCAN_RATE_LIMIT_MAX), since it is unauthenticated and
 *     each scan fetches + parses several pages against an attacker-supplied URL.
 */

import { supabase } from "../supabase.server";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;

/** Cap for the unauthenticated public /scan endpoint (per client IP, per hour). */
export const PUBLIC_SCAN_RATE_LIMIT_MAX = 5;

// In-memory fallback (used if DB table not yet deployed)
const scanRateMap = new Map<string, number[]>();

export async function checkRateLimit(
  key: string,
  max: number = RATE_LIMIT_MAX
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  // Try persistent check first
  const { data, error } = await supabase
    .from("scan_rate_limits")
    .select("requested_at")
    .eq("shop", key)
    .gte("requested_at", cutoff)
    .order("requested_at", { ascending: true });

  if (error) {
    // Table might not exist yet — fall back to in-memory
    return checkRateLimitInMemory(key, max);
  }

  // Clean up old records (fire-and-forget)
  supabase
    .from("scan_rate_limits")
    .delete()
    .lt("requested_at", cutoff)
    .then(() => {});

  const count = data?.length ?? 0;

  if (count >= max) {
    const oldest = data![0].requested_at;
    const oldestMs = new Date(oldest).getTime();
    const retryAfterSeconds = Math.ceil(
      (oldestMs + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000
    );
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  return { allowed: true, remaining: max - count, retryAfterSeconds: 0 };
}

export async function recordScanRequest(key: string): Promise<void> {
  const { error } = await supabase
    .from("scan_rate_limits")
    .insert({ shop: key });

  if (error) {
    // Fall back to in-memory if table doesn't exist
    recordScanRequestInMemory(key);
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────

function checkRateLimitInMemory(
  key: string,
  max: number
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (scanRateMap.get(key) ?? []).filter((t) => t > cutoff);
  scanRateMap.set(key, timestamps);

  if (timestamps.length >= max) {
    const oldestInWindow = timestamps[0];
    const retryAfterSeconds = Math.ceil(
      (oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000
    );
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return { allowed: true, remaining: max - timestamps.length, retryAfterSeconds: 0 };
}

function recordScanRequestInMemory(key: string): void {
  const timestamps = scanRateMap.get(key) ?? [];
  timestamps.push(Date.now());
  scanRateMap.set(key, timestamps);
}

/** Exposed for testing — max requests allowed per window (authenticated default). */
export const RATE_LIMIT_MAX_REQUESTS = RATE_LIMIT_MAX;
