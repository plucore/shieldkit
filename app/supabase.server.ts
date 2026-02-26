import { createClient } from "@supabase/supabase-js";

declare global {
  // eslint-disable-next-line no-var
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var supabaseGlobal: any;
}

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables"
    );
  }

  return createClient(url, key, {
    auth: {
      // Disable Supabase's built-in auth — we manage sessions ourselves via
      // the Shopify session storage layer.
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

// Singleton pattern mirrors db.server.ts — prevents multiple connections on
// hot reload in development.
if (process.env.NODE_ENV !== "production") {
  if (!global.supabaseGlobal) {
    global.supabaseGlobal = createSupabaseClient();
  }
}

export const supabase = global.supabaseGlobal ?? createSupabaseClient();
