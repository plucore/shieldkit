/**
 * app/lib/appeal-letters.server.ts
 *
 * Race-safe per-scan appeal-letter cap (SHIELDKIT-2 — 2026-07-12).
 *
 * The cap (3 letters per scan) was previously a non-atomic count-then-insert in
 * the route: concurrent submits — e.g. an ungated button firing several POSTs
 * before it locked — each read count<3 before any insert landed, so all passed
 * (TOCTOU). Live incident: 5 letters generated for one scan.
 *
 * The fix is a two-phase reservation, mirroring the atomic decrement_scan_quota
 * pattern:
 *
 *   1. reserveAppealSlot -> insert_appeal_letter_if_under_cap RPC serializes
 *      concurrent callers for the scan on a per-scan advisory lock and inserts a
 *      placeholder row ONLY when under the cap. An over-cap attempt is rejected
 *      here, before any AI credit or Anthropic call is spent.
 *   2. On success the caller finalizeAppealSlot()s the reserved row with the
 *      generated letter; on any failure it releaseAppealSlot()s (deletes) it so
 *      a failed generation doesn't burn a cap slot.
 *
 * A non-atomic fallback keeps the feature working if the RPC isn't deployed yet
 * (same degradation strategy as checkAndConsumeAiCredit).
 */

import { supabase } from "../supabase.server";

export interface AppealReservation {
  /** True when a slot was reserved (row inserted); false when over the cap. */
  accepted: boolean;
  /** Id of the reserved appeal_letters row — finalize or release it. */
  letterId: string | null;
  /** Rows for the scan after this attempt (for messaging). */
  usedCount: number;
}

/**
 * Atomically reserve one appeal-letter slot for a scan. Returns
 * `{ accepted: false }` when the scan is already at the cap (no row inserted,
 * so no AI credit or model call should follow).
 */
export async function reserveAppealSlot(
  merchantId: string,
  scanId: string,
  cap: number,
): Promise<AppealReservation> {
  const { data, error } = await supabase.rpc(
    "insert_appeal_letter_if_under_cap",
    { p_merchant_id: merchantId, p_scan_id: scanId, p_cap: cap },
  );

  if (error) {
    // RPC missing / DB error — degrade to a non-atomic reserve so a missing
    // migration doesn't take the feature offline. NOT race-safe.
    return await fallbackReserve(merchantId, scanId, cap);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    // The function always returns exactly one row; treat anything else as a
    // conservative rejection.
    return { accepted: false, letterId: null, usedCount: cap };
  }

  const row = data[0] as {
    accepted: boolean;
    letter_id: string | null;
    used_count: number;
  };
  return {
    accepted: row.accepted,
    letterId: row.letter_id,
    usedCount: row.used_count,
  };
}

/** Fills a reserved row with the generated letter (happy path). */
export async function finalizeAppealSlot(
  letterId: string,
  suspensionReason: string,
  letter: string,
): Promise<void> {
  await supabase
    .from("appeal_letters")
    .update({ suspension_reason: suspensionReason, generated_letter: letter })
    .eq("id", letterId);
}

/**
 * Deletes a reserved row when the generation fails (or a later precondition
 * rejects), so a failed attempt never consumes one of the 3 cap slots.
 */
export async function releaseAppealSlot(letterId: string): Promise<void> {
  await supabase.from("appeal_letters").delete().eq("id", letterId);
}

/** Non-atomic fallback used only when the RPC isn't deployed. */
async function fallbackReserve(
  merchantId: string,
  scanId: string,
  cap: number,
): Promise<AppealReservation> {
  const { count } = await supabase
    .from("appeal_letters")
    .select("id", { count: "exact", head: true })
    .eq("scan_id", scanId);
  const used = count ?? 0;
  if (used >= cap) {
    return { accepted: false, letterId: null, usedCount: used };
  }
  const { data } = await supabase
    .from("appeal_letters")
    .insert({ merchant_id: merchantId, scan_id: scanId })
    .select("id")
    .maybeSingle();
  return {
    accepted: true,
    letterId: (data?.id as string | undefined) ?? null,
    usedCount: used + 1,
  };
}
