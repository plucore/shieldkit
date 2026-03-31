import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against SHOPIFY_API_SECRET.
  const { payload, session, shop } = await authenticate.webhook(request);

  const current = payload.current as string[];

  if (session) {
    const { error } = await supabase
      .from("sessions")
      .update({ scope: current.toString() })
      .eq("id", session.id);

    if (error) {
      console.error(
        `[webhooks.app.scopes_update] Failed to update scope for session ${session.id}:`,
        error.message
      );
    }
  }

  return new Response();
};
