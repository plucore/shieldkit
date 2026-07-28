/**
 * app/lib/install-events.server.ts
 *
 * The append-only merchant lifecycle ledger. This is the ONLY durable record of
 * churn this app has.
 *
 * WHY IT EXISTS. Shopify's GDPR `shop/redact` webhook fires 48h after every
 * uninstall, and `webhooks.shop.redact.tsx` hard-deletes the merchants row. All
 * seven child FKs CASCADE, so the merchant's entire history — scans, violations,
 * enrichments, `uninstalled_at` itself — goes with it. `uninstalled_at IS NOT
 * NULL` is a state with a 48-hour half-life on a row scheduled for deletion, so a
 * point-in-time query can essentially never observe it. That is why the merchants
 * table showed ZERO churn across five months while ~40 shops had actually left,
 * reconstructable only from orphaned `leads` rows — and that method catches only
 * the ~47% who had run an authenticated scan.
 *
 * THE ONE RULE: **NO FOREIGN KEY TO merchants.** Every one of the seven existing
 * child tables declares `REFERENCES merchants(id) ON DELETE CASCADE`, and that is
 * precisely why none of them survived to record the churn. `merchant_id` here is
 * an intentionally unconstrained UUID: a convenience join key while the merchant
 * row exists, a dangling historical reference afterwards. That is correct.
 *
 * GDPR POSTURE. This table is designed to outlive `shop/redact`, so its contents
 * are deliberately minimal: shop domain (a business identifier), the lifecycle
 * event, a timestamp, and the plan tier. NO email, owner name, address, or
 * catalog data — all of which remain subject to the cascade. Do not add PII here.
 * If a stricter posture is ever needed, hash `shop_domain` rather than dropping
 * the table.
 *
 * Every write is best-effort and never throws: a webhook ACK or an OAuth
 * completion must never fail because analytics did.
 */

import { supabase } from "../supabase.server";
import { sentry } from "./sentry.server";

export type InstallEventType = "install" | "uninstall" | "redact";

export interface RecordInstallEventOpts {
  shopDomain: string;
  eventType: InstallEventType;
  /** Plan tier at the moment of the event. Null when unknown. */
  tier?: string | null;
  /** Denormalised for convenience. NOT a foreign key — may dangle. */
  merchantId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append one lifecycle row. Never throws, never blocks a caller on failure.
 *
 * Deliberately NOT deduplicated: Shopify can redeliver a webhook, and two
 * `uninstall` rows are strictly better than zero. Readers should use
 * `min(occurred_at)` per (shop_domain, event_type) — see
 * docs/churn-and-conversion-queries.md.
 */
export async function recordInstallEvent(
  opts: RecordInstallEventOpts,
): Promise<void> {
  try {
    const { error } = await supabase.from("install_events").insert({
      shop_domain: opts.shopDomain,
      event_type: opts.eventType,
      tier: opts.tier ?? null,
      merchant_id: opts.merchantId ?? null,
      metadata: opts.metadata ?? {},
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    // If this write fails we lose the only durable churn record for this shop,
    // so it is worth a Sentry capture even though it must not throw.
    sentry.captureException(err, {
      tags: { area: "install-events", event: opts.eventType },
      extra: { shop: opts.shopDomain },
    });
    console.error(
      `[install-events] FAILED to record ${opts.eventType} for ${opts.shopDomain}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
