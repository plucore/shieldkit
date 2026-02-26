import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against SHOPIFY_API_SECRET.
  // Throws a 401 Response automatically if HMAC verification fails.
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} GDPR webhook for ${shop}`);

  // GDPR: shop/redact
  // Shopify sends this 48 hours after app uninstallation.
  // We must permanently delete all data associated with this shop.
  // The app/uninstalled webhook has already removed sessions and soft-deleted
  // the merchant row; this webhook performs the hard delete.

  const { data: merchant, error: lookupError } = await supabase
    .from("merchants")
    .select("id")
    .eq("shopify_domain", shop)
    .maybeSingle();

  if (lookupError) {
    console.error(
      `[GDPR] shop/redact lookup error for ${shop}:`,
      lookupError.message
    );
  }

  if (merchant) {
    // ON DELETE CASCADE propagates: merchant → scans → violations
    const { error: deleteError } = await supabase
      .from("merchants")
      .delete()
      .eq("id", merchant.id);

    if (deleteError) {
      console.error(
        `[GDPR] shop/redact failed to delete merchant data for ${shop}:`,
        deleteError.message
      );
      // Return 200 regardless — Shopify does not retry GDPR redact webhooks on 5xx.
    } else {
      console.log(`[GDPR] shop/redact: deleted all data for ${shop}`);
    }
  } else {
    console.log(
      `[GDPR] shop/redact: no merchant record found for ${shop} — already deleted or never installed`
    );
  }

  // Ensure any lingering sessions are also removed.
  await supabase.from("sessions").delete().eq("shop", shop);

  console.log(
    `[GDPR] shop/redact complete for shop ${shop}:`,
    JSON.stringify(payload)
  );

  return new Response(null, { status: 200 });
};
