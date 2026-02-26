import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against SHOPIFY_API_SECRET.
  // Throws a 401 Response automatically if verification fails.
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete all OAuth sessions for this shop. Safe to run on duplicate delivery.
  const { error: sessionError } = await supabase
    .from("sessions")
    .delete()
    .eq("shop", shop);

  if (sessionError) {
    console.error(
      `[webhooks.app.uninstalled] Failed to delete sessions for ${shop}:`,
      sessionError.message
    );
  }

  // Soft-delete the merchant — preserves billing history and scan data.
  // GDPR shop/redact webhook (48h later) will hard-delete everything.
  const { error: merchantError } = await supabase
    .from("merchants")
    .update({ uninstalled_at: new Date().toISOString() })
    .eq("shopify_domain", shop);

  if (merchantError) {
    console.error(
      `[webhooks.app.uninstalled] Failed to mark merchant uninstalled for ${shop}:`,
      merchantError.message
    );
    // Do not throw — always return 200 to Shopify to prevent unnecessary retries.
  }

  return new Response();
};
