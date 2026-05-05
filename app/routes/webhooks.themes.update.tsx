/**
 * app/routes/webhooks.themes.update.tsx
 *
 * Phase 7.3 — Theme-change scan trigger.
 *
 * Subscribes to themes/update + themes/publish. On any delivery from a
 * paid merchant (tier IN ('shield','pro')) we insert a pending_scan_triggers
 * row, dedup'd to one open trigger per merchant per 24h. The cron route
 * api.cron.process-scan-triggers drains the queue daily.
 *
 * Always acks 200. Webhook errors are logged but never thrown.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function ack(): Response {
  return new Response();
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC verify — throws 401 Response on failure.
  const { shop, topic } = await authenticate.webhook(request);

  try {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id, tier")
      .eq("shopify_domain", shop)
      .maybeSingle();

    if (!merchant) {
      console.warn(`[webhooks.themes.update] unknown shop ${shop}`);
      return ack();
    }

    // Tier gate — paid only (skip_tier).
    if (merchant.tier !== "shield" && merchant.tier !== "pro") {
      return ack();
    }

    // 24h dedup — skip if there's already an unprocessed trigger.
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: existing } = await supabase
      .from("pending_scan_triggers")
      .select("id")
      .eq("merchant_id", merchant.id)
      .is("processed_at", null)
      .gte("trigger_at", cutoff)
      .limit(1);

    if (existing && existing.length > 0) {
      // Already queued.
      return ack();
    }

    await supabase.from("pending_scan_triggers").insert({
      merchant_id: merchant.id,
      trigger_type: topic === "themes/publish" ? "theme_publish" : "theme_update",
    });
  } catch (err) {
    console.error(
      `[webhooks.themes.update] handler failed for ${shop}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return ack();
};
