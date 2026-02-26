import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies X-Shopify-Hmac-Sha256 against SHOPIFY_API_SECRET.
  // Throws a 401 Response automatically if HMAC verification fails.
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} GDPR webhook for ${shop}`);

  // GDPR: customers/redact
  // Shopify requires: delete or anonymise the specified customer's data.
  // ShieldKit is a merchant-facing compliance scanner — it stores no personal
  // customer PII (scans analyse storefront configuration, not customer records).
  // Nothing to delete. Log for audit trail.
  console.log(
    `[GDPR] customers/redact for shop ${shop}:`,
    JSON.stringify(payload)
  );

  return new Response(null, { status: 200 });
};
