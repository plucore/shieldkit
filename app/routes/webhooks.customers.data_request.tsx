import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against SHOPIFY_API_SECRET.
  // Throws a 401 Response automatically if HMAC verification fails.
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} GDPR webhook for ${shop}`);

  // GDPR: customers/data_request
  // Shopify requires: respond 200, then provide the customer's data within 30 days.
  // ShieldKit is a merchant-facing compliance scanner — it stores no personal
  // customer PII. Log the request for audit purposes only.
  console.log(
    `[GDPR] customers/data_request for shop ${shop}:`,
    JSON.stringify(payload)
  );

  return new Response(null, { status: 200 });
};
