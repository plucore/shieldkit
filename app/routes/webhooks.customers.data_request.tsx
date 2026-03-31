import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against SHOPIFY_API_SECRET.
  // Throws a 401 Response automatically if HMAC verification fails.
  await authenticate.webhook(request);

  // GDPR: customers/data_request
  // ShieldKit stores no personal customer PII — nothing to provide.
  return new Response(null, { status: 200 });
};
