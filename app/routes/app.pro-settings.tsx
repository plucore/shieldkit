/**
 * app/routes/app.pro-settings.tsx
 * Route: /app/pro-settings
 *
 * Phase 4.1 — Shield Max merchants enter their Organization + WebSite
 * schema values + AI bot preferences here. Persisted to merchants.pro_settings
 * (a JSONB column proposed in Block 7's SQL ALTER, applied separately).
 *
 * For now (Phase 4) the values feed the Liquid block settings: the merchant
 * has to copy them into the theme editor manually. Phase 5 will sync them
 * via metafields once write_products scope is approved.
 *
 * Tier gate: tier='pro' (Shield Max) only. Lower tiers see an upgrade nudge.
 */

import { useCallback, useRef } from "react";
import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { useWebComponentClick } from "../hooks/useWebComponentClick";

interface ProSettings {
  logo_url?: string;
  support_email?: string;
  twitter_url?: string;
  facebook_url?: string;
  instagram_url?: string;
  tiktok_url?: string;
  linkedin_url?: string;
  youtube_url?: string;
  search_url_template?: string;
  bot_preferences?: Record<string, "allow" | "block">;
}

type StringField = Exclude<keyof ProSettings, "bot_preferences">;

const FIELDS: Array<{ id: StringField; label: string; help?: string }> = [
  { id: "logo_url", label: "Logo URL", help: "Absolute URL to your logo (PNG/JPG, ideally 600x60+)." },
  { id: "support_email", label: "Support email", help: "Used as Organization contactPoint email. Defaults to your shop email if blank." },
  { id: "twitter_url", label: "Twitter / X URL" },
  { id: "facebook_url", label: "Facebook URL" },
  { id: "instagram_url", label: "Instagram URL" },
  { id: "tiktok_url", label: "TikTok URL" },
  { id: "linkedin_url", label: "LinkedIn URL" },
  { id: "youtube_url", label: "YouTube URL" },
  { id: "search_url_template", label: "Search URL template", help: "Override the default site search URL. Use {search_term_string} as the placeholder. Leave blank for the default /search?q={search_term_string}." },
];

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // pro_settings column may not exist yet (SQL ALTER pending review).
  const { data: merchant, error } = await supabase
    .from("merchants")
    .select("id, tier, pro_settings")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  // If the column doesn't exist Supabase returns 42703 — treat as empty.
  const proSettings: ProSettings =
    !error && merchant && (merchant as any).pro_settings
      ? ((merchant as any).pro_settings as ProSettings)
      : {};

  if (!merchant) return redirect("/app");

  const columnMissing = !!error && (error.message ?? "").includes("pro_settings");

  return {
    tier: merchant.tier as string,
    settings: proSettings,
    columnMissing,
  };
};

// ─── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // Preserve any existing bot_preferences while updating string fields.
  const { data: current } = await supabase
    .from("merchants")
    .select("pro_settings")
    .eq("shopify_domain", session.shop)
    .maybeSingle();
  const existing = ((current as any)?.pro_settings ?? {}) as ProSettings;

  const next: ProSettings = {
    ...(existing.bot_preferences ? { bot_preferences: existing.bot_preferences } : {}),
  };
  for (const field of FIELDS) {
    const v = formData.get(String(field.id));
    if (typeof v === "string" && v.trim().length > 0) {
      (next as Record<string, string>)[field.id] = v.trim();
    }
  }

  const { error } = await supabase
    .from("merchants")
    .update({ pro_settings: next })
    .eq("shopify_domain", session.shop);

  if (error) {
    return data(
      {
        ok: false,
        error:
          (error.message ?? "").includes("pro_settings")
            ? "The pro_settings column hasn't been added yet — apply the pending SQL ALTER first."
            : error.message,
      },
      { status: 500 },
    );
  }

  return data({ ok: true, error: null });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProSettingsPage() {
  const { tier, settings, columnMissing } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isSaving = nav.state === "submitting" || nav.state === "loading";

  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);
  const submitRef = useWebComponentClick<HTMLElement>(submitForm);

  if (tier !== "pro") {
    return (
      <s-page heading="Shield Max settings">
        <s-section>
          <s-banner tone="info" heading="Shield Max only">
            These settings power the Organization & WebSite JSON-LD blocks
            shipped with Shield Max. Upgrade your plan to unlock them.
          </s-banner>
          <s-link href="/app/plan-switcher">View plans</s-link>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Shield Max settings">
      {columnMissing && (
        <s-section>
          <s-banner tone="warning" heading="Database column not yet applied">
            The merchants.pro_settings JSONB column is pending. Form values
            will not persist until the SQL ALTER ships — see the v2.8 commit
            notes for the statement.
          </s-banner>
        </s-section>
      )}

      <s-section>
        <s-paragraph>
          These values feed the Organization and WebSite JSON-LD blocks in
          the ShieldKit theme extension. Until Phase 5 adds metafield sync,
          you'll need to mirror these values in the theme editor: Online
          Store -&gt; Themes -&gt; Edit code, then open the ShieldKit blocks
          and paste the same URLs into the block settings.
        </s-paragraph>
      </s-section>

      <s-section heading="Brand identity">
        <form method="post" ref={formRef}>
          {FIELDS.map((field) => (
            <div key={String(field.id)} style={{ marginBottom: "16px" }}>
              <label
                htmlFor={String(field.id)}
                style={{ display: "block", fontWeight: 600, marginBottom: "4px" }}
              >
                {field.label}
              </label>
              {field.help && (
                <p
                  style={{
                    margin: "0 0 8px",
                    fontSize: "13px",
                    color: "var(--p-color-text-subdued, #6d7175)",
                  }}
                >
                  {field.help}
                </p>
              )}
              <input
                id={String(field.id)}
                name={String(field.id)}
                defaultValue={settings[field.id] ?? ""}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  fontSize: "14px",
                  fontFamily: "inherit",
                  border: "1px solid #c9cccf",
                  borderRadius: "6px",
                }}
              />
            </div>
          ))}
          {/* @ts-ignore — s-button supports `loading` at runtime */}
          <s-button
            variant="primary"
            ref={submitRef}
            {...(isSaving ? { loading: "" } : {})}
          >
            {isSaving ? "Saving…" : "Save settings"}
          </s-button>
        </form>
      </s-section>

      {actionData?.ok && (
        <s-section>
          <s-banner tone="success">Settings saved.</s-banner>
        </s-section>
      )}
      {actionData?.error && (
        <s-section>
          <s-banner tone="critical" heading="Save failed">
            {actionData.error}
          </s-banner>
        </s-section>
      )}
    </s-page>
  );
}

// ─── Boundaries ───────────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
