/**
 * app/routes/app.dmca-takedowns.tsx
 *
 * The DMCA Legal Engine feature has been deferred for a future release.
 * This route is kept as a redirect so any bookmarked or cached links
 * land safely on the Pricing page rather than a 404.
 */

import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app/pricing");
};

// No default export needed — the loader always redirects.
