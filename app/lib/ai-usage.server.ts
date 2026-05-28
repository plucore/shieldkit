/**
 * app/lib/ai-usage.server.ts
 *
 * AI usage cap (v4 §5 — 2026-05-28). Shared across all Anthropic-backed
 * features: AI policy generation (refund/shipping/privacy/terms) and the
 * GMC re-review appeal letter generator.
 *
 * Cap is a rolling 30-day window per merchant. Per-type policy regen
 * (`policy_regen_used`, 2/type) and per-scan appeal-letter limits
 * (3/scan) still apply as UX nudges INSIDE this monthly budget — they
 * stack: the per-type/per-scan limits prevent runaway regens of one
 * surface, the monthly cap prevents abuse across surfaces.
 *
 * Atomicity: the actual increment runs in the `consume_ai_credit`
 * Supabase RPC (defined in supabase/schema.sql + the
 * 20260528121738_ai_usage_cap.sql migration). A single SQL statement
 * branches on reset-window age, so two parallel requests cannot race
 * past the cap.
 */

import { supabase } from "../supabase.server";

/** Maximum AI generations a merchant can make per rolling 30-day window. */
export const AI_MONTHLY_CAP = 12;

export interface AiCreditResult {
  allowed: boolean;
  /** Generations remaining in the current window after this attempt. */
  remaining: number;
  /** Window-reset timestamp (ISO 8601). Useful for user-facing messages. */
  resetAt: string | null;
}

/**
 * Atomic check + consume in a single RPC call. Returns
 * `{ allowed: true, remaining }` after a successful consume, or
 * `{ allowed: false, remaining: 0 }` when the merchant has already
 * exhausted the cap for the current window.
 *
 * Callers MUST invoke this BEFORE hitting Anthropic. On `allowed: false`
 * the caller should return a user-facing 429 with the resetAt date and
 * NOT make the model call.
 */
export async function checkAndConsumeAiCredit(
  merchantId: string,
): Promise<AiCreditResult> {
  const { data, error } = await supabase.rpc("consume_ai_credit", {
    p_merchant_id: merchantId,
    p_cap: AI_MONTHLY_CAP,
  });

  if (error) {
    // RPC missing or DB error — fall back to non-atomic best-effort so a
    // missing migration doesn't take the feature offline. Read counter,
    // reset if stale, increment. NOT race-safe; only a degraded fallback.
    return await fallbackConsume(merchantId);
  }

  // RPC returned zero rows = cap reached.
  if (!data || !Array.isArray(data) || data.length === 0) {
    // Read the current window so we can tell the merchant when they reset.
    const { data: row } = await supabase
      .from("merchants")
      .select("ai_generations_reset_at")
      .eq("id", merchantId)
      .maybeSingle();
    const resetAt = (row?.ai_generations_reset_at as string | null) ?? null;
    return { allowed: false, remaining: 0, resetAt };
  }

  const row = data[0] as { new_used: number; reset_at: string };
  return {
    allowed: true,
    remaining: Math.max(0, AI_MONTHLY_CAP - row.new_used),
    resetAt: row.reset_at,
  };
}

/**
 * Compute when the merchant's current window expires (i.e. when their
 * cap resets back to 12). Used for user-facing copy on the cap-reached
 * response. Returns an ISO string or null when reset_at is unknown.
 */
export function windowResetIso(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const start = new Date(resetAt).getTime();
  if (Number.isNaN(start)) return null;
  return new Date(start + 30 * 24 * 60 * 60 * 1000).toISOString();
}

/** Non-atomic fallback used when the RPC isn't deployed yet. */
async function fallbackConsume(merchantId: string): Promise<AiCreditResult> {
  const { data: row } = await supabase
    .from("merchants")
    .select("ai_generations_used, ai_generations_reset_at")
    .eq("id", merchantId)
    .maybeSingle();

  if (!row) {
    // No merchant row — refuse to consume rather than silently bypass.
    return { allowed: false, remaining: 0, resetAt: null };
  }

  const resetMs = row.ai_generations_reset_at
    ? new Date(row.ai_generations_reset_at as string).getTime()
    : 0;
  const stale = Date.now() - resetMs > 30 * 24 * 60 * 60 * 1000;
  const currentUsed = stale ? 0 : (row.ai_generations_used as number);

  if (currentUsed >= AI_MONTHLY_CAP) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: (row.ai_generations_reset_at as string | null) ?? null,
    };
  }

  const newUsed = currentUsed + 1;
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    ai_generations_used: newUsed,
  };
  if (stale) update.ai_generations_reset_at = nowIso;

  await supabase.from("merchants").update(update).eq("id", merchantId);

  return {
    allowed: true,
    remaining: AI_MONTHLY_CAP - newUsed,
    resetAt: stale ? nowIso : (row.ai_generations_reset_at as string),
  };
}
