/**
 * app/routes/app.bots.toggle.tsx
 * Route: /app/bots/toggle
 *
 * Phase 4.3 — AI Bot Access Control. Shield Max merchants choose whether to
 * allow or block each known AI training/runtime crawler. The page generates
 * a robots.txt snippet they paste into their theme's templates/robots.txt.liquid.
 *
 * State persists to merchants.pro_settings.bot_preferences (JSONB column —
 * same column as Block 7's pro-settings).
 *
 * No write_metafields scope is required because the merchant copies the
 * snippet into their theme manually. Phase 5 may automate this once
 * write_themes scope is granted.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  data,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
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

interface Bot {
  id: string;
  userAgent: string;
  vendor: string;
  description: string;
}

const BOTS: Bot[] = [
  { id: "GPTBot", userAgent: "GPTBot", vendor: "OpenAI", description: "Trains ChatGPT models." },
  { id: "ChatGPT-User", userAgent: "ChatGPT-User", vendor: "OpenAI", description: "Fetches pages live when ChatGPT users browse." },
  { id: "OAI-SearchBot", userAgent: "OAI-SearchBot", vendor: "OpenAI", description: "Indexes for ChatGPT Search results." },
  { id: "ClaudeBot", userAgent: "ClaudeBot", vendor: "Anthropic", description: "Trains Claude models." },
  { id: "anthropic-ai", userAgent: "anthropic-ai", vendor: "Anthropic", description: "Older Anthropic crawler." },
  { id: "Google-Extended", userAgent: "Google-Extended", vendor: "Google", description: "Trains Google AI products (separate from Googlebot)." },
  { id: "PerplexityBot", userAgent: "PerplexityBot", vendor: "Perplexity", description: "Indexes for Perplexity AI search." },
  { id: "Perplexity-User", userAgent: "Perplexity-User", vendor: "Perplexity", description: "Live page fetches for Perplexity users." },
  { id: "Bytespider", userAgent: "Bytespider", vendor: "ByteDance", description: "TikTok parent company AI crawler." },
  { id: "Amazonbot", userAgent: "Amazonbot", vendor: "Amazon", description: "Powers Alexa and Amazon AI products." },
  { id: "CCBot", userAgent: "CCBot", vendor: "Common Crawl", description: "Common Crawl corpus, used by many model trainers." },
];

type BotPref = "allow" | "block";
type BotPrefs = Record<string, BotPref>;

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { data: merchant, error } = await supabase
    .from("merchants")
    .select("tier, pro_settings")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  if (!merchant) return redirect("/app");

  const proSettings = ((merchant as any).pro_settings ?? {}) as {
    bot_preferences?: BotPrefs;
  };

  const columnMissing = !!error && (error.message ?? "").includes("pro_settings");

  return {
    tier: merchant.tier as string,
    botPreferences: proSettings.bot_preferences ?? {},
    columnMissing,
  };
};

// ─── Action — persist toggles ─────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const prefsJson = String(formData.get("bot_preferences") ?? "{}");
  let prefs: BotPrefs;
  try {
    prefs = JSON.parse(prefsJson);
  } catch {
    return data({ ok: false, error: "Invalid preferences payload." }, { status: 400 });
  }

  // Validate
  for (const [key, val] of Object.entries(prefs)) {
    if (val !== "allow" && val !== "block") {
      return data({ ok: false, error: `Invalid value for ${key}` }, { status: 400 });
    }
  }

  const { data: current } = await supabase
    .from("merchants")
    .select("pro_settings")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  const existing = ((current as any)?.pro_settings ?? {}) as Record<string, unknown>;
  const next = { ...existing, bot_preferences: prefs };

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSnippet(prefs: BotPrefs): string {
  const lines: string[] = [];
  lines.push("# ShieldKit AI bot rules — generated " + new Date().toISOString().slice(0, 10));
  lines.push("");
  for (const bot of BOTS) {
    const pref = prefs[bot.id] ?? "allow";
    lines.push(`User-agent: ${bot.userAgent}`);
    lines.push(pref === "block" ? "Disallow: /" : "Allow: /");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BotsTogglePage() {
  const { tier, botPreferences, columnMissing } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const saveFetcher = useFetcher();

  const [prefs, setPrefs] = useState<BotPrefs>(() => {
    const init: BotPrefs = {};
    for (const bot of BOTS) {
      init[bot.id] = (botPreferences[bot.id] as BotPref) ?? "allow";
    }
    return init;
  });

  const snippet = useMemo(() => buildSnippet(prefs), [prefs]);

  const onSave = useCallback(() => {
    saveFetcher.submit(
      { bot_preferences: JSON.stringify(prefs) },
      { method: "post", action: "/app/bots/toggle" },
    );
  }, [prefs, saveFetcher]);
  const saveRef = useWebComponentClick<HTMLElement>(onSave);

  const snippetRef = useRef<HTMLPreElement>(null);
  const onCopy = useCallback(() => {
    if (!snippetRef.current) return;
    void navigator.clipboard.writeText(snippet);
  }, [snippet]);
  const copyRef = useWebComponentClick<HTMLElement>(onCopy);

  if (tier !== "pro") {
    return (
      <s-page heading="AI Bot Access Control">
        <s-section>
          <s-banner tone="info" heading="Shield Max only">
            Choose which AI crawlers can train on or index your storefront.
            Upgrade to Shield Max to access this control.
          </s-banner>
          <s-link href="/app/plan-switcher">View plans</s-link>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="AI Bot Access Control">
      {columnMissing && (
        <s-section>
          <s-banner tone="warning" heading="Database column not yet applied">
            The merchants.pro_settings JSONB column is pending. Toggle changes
            won't persist until the SQL ALTER ships.
          </s-banner>
        </s-section>
      )}

      <s-section>
        <s-paragraph>
          Decide which AI crawlers can train on or index your storefront.
          Toggle a bot to "Block" if you want it to leave you alone; toggle
          "Allow" if you want your products visible in their AI products
          (ChatGPT shopping, Perplexity, Google AI Overviews, etc.).
        </s-paragraph>
        <s-paragraph>
          The list and the resulting <code>robots.txt</code> snippet update
          live below. After saving, paste the snippet into your theme's
          <code> templates/robots.txt.liquid</code> file (Online Store →
          Themes → Edit code).
        </s-paragraph>
      </s-section>

      <s-section heading="Bots">
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {BOTS.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              pref={prefs[bot.id]}
              onChange={(next) =>
                setPrefs((curr) => ({ ...curr, [bot.id]: next }))
              }
            />
          ))}
        </div>
      </s-section>

      <s-section heading="robots.txt snippet">
        <pre
          ref={snippetRef}
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#f6f6f7",
            padding: "16px",
            borderRadius: "8px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "13px",
            lineHeight: 1.6,
            margin: "0 0 12px",
          }}
        >
          {snippet}
        </pre>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <s-button variant="secondary" ref={copyRef}>
            Copy snippet
          </s-button>
          {/* @ts-ignore — s-button supports `loading` at runtime */}
          <s-button
            variant="primary"
            ref={saveRef}
            {...(saveFetcher.state !== "idle" ? { loading: "" } : {})}
          >
            {saveFetcher.state !== "idle" ? "Saving…" : "Save preferences"}
          </s-button>
        </div>
      </s-section>

      {(actionData?.ok || (saveFetcher.data as any)?.ok) && (
        <s-section>
          <s-banner tone="success">Preferences saved.</s-banner>
        </s-section>
      )}
      {(actionData?.error ||
        (saveFetcher.data as any)?.error) && (
        <s-section>
          <s-banner tone="critical" heading="Save failed">
            {actionData?.error ?? (saveFetcher.data as any)?.error}
          </s-banner>
        </s-section>
      )}

      <s-section heading="Want llms.txt at the root domain?">
        <s-paragraph>
          ShieldKit serves your llms.txt at <code>/apps/llms-txt</code> via
          App Proxy. To make it available at <code>/llms.txt</code> at the
          root, add this line near the top of your theme's
          <code> templates/robots.txt.liquid</code>:
        </s-paragraph>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#f6f6f7",
            padding: "12px",
            borderRadius: "8px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "13px",
            margin: "8px 0 0",
          }}
        >
          {`# Redirect /llms.txt to ShieldKit App Proxy\nSitemap: ${"{{ shop.url }}"}/apps/llms-txt\n`}
        </pre>
      </s-section>
    </s-page>
  );
}

// ─── Bot row ──────────────────────────────────────────────────────────────────

function BotRow({
  bot,
  pref,
  onChange,
}: {
  bot: Bot;
  pref: BotPref;
  onChange: (next: BotPref) => void;
}) {
  const onAllow = useCallback(() => onChange("allow"), [onChange]);
  const onBlock = useCallback(() => onChange("block"), [onChange]);
  const allowRef = useWebComponentClick<HTMLElement>(onAllow);
  const blockRef = useWebComponentClick<HTMLElement>(onBlock);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
        padding: "12px",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: "#0f172a" }}>
          {bot.userAgent}{" "}
          <span style={{ fontWeight: 400, color: "#6d7175" }}>
            ({bot.vendor})
          </span>
        </div>
        <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "2px" }}>
          {bot.description}
        </div>
      </div>
      <div style={{ display: "flex", gap: "6px" }}>
        <s-button
          ref={allowRef}
          variant={pref === "allow" ? "primary" : "secondary"}
        >
          Allow
        </s-button>
        <s-button
          ref={blockRef}
          variant={pref === "block" ? "primary" : "secondary"}
        >
          Block
        </s-button>
      </div>
    </div>
  );
}

// ─── Boundaries ───────────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
