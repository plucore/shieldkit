/**
 * app/routes/webhooks.themes.update.tsx
 *
 * Subscribes to themes/update + themes/publish via shopify.app.toml. The
 * subscription is preserved so Shopify's webhook registration stays valid
 * (removing it would require a scope re-review push), but the handler is
 * a no-op since v4 dropped automated scans on theme changes — paid plans
 * are now strictly on-demand re-scans.
 *
 * Always returns 200. HMAC is verified by authenticate.webhook so invalid
 * deliveries return 401 automatically.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC verify — throws 401 Response on failure.
  const { shop, topic } = await authenticate.webhook(request);

  // v4 no-op: dropped storefront-monitoring scan triggers. The webhook
  // subscription stays so Shopify keeps registering the URL, but we just
  // log + ACK.
  console.log(`[webhooks.themes.update] noop ack: topic=${topic} shop=${shop}`);

  return new Response();
};
