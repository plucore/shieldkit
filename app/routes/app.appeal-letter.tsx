/**
 * app/routes/app.appeal-letter.tsx
 * Route: /app/appeal-letter
 *
 * Phase 3.4 — GMC Re-Review Appeal Letter Generator.
 *
 * Form: suspension reason + fixes made → server action → Anthropic Claude →
 * appeal_letters row inserted, generated letter rendered as <pre> for copy.
 *
 * Cap: 3 letters per scan (regardless of plan tier — the plan applies the cap
 * to all merchants who have run a scan). The "scan" in scope is the latest
 * scan for that merchant; running a new scan resets the counter (because
 * each scan_id has its own row count).
 *
 * Recovery-gated as of v3 (2026-05-14). Available to tier='recovery' and
 * grandfathered tier='pro' (Shield Max). Free / monitoring / shield see a
 * 403 from the action and a redirect from the loader.
 */

import { useCallback, useRef, useState } from "react";
import {
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
  redirect,
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
import { wrapAdminClient, getShopInfo } from "../lib/shopify-api.server";
import { generateAppealLetter } from "../lib/llm/appeal-letter.server";
import { hasPaidAccess } from "../lib/billing/plans";
import {
  AI_MONTHLY_CAP,
  checkAndConsumeAiCredit,
  windowResetIso,
} from "../lib/ai-usage.server";

const APPEAL_LIMIT_PER_SCAN = 3;

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, shop_name, tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  if (!merchant) {
    return redirect("/app");
  }

  // Recovery-gated as of v3. NavMenu hides the link for non-recovery tiers,
  // but defend the route too in case a merchant lands here via bookmark.
  if (!hasPaidAccess(merchant.tier)) {
    return redirect("/app/upgrade");
  }

  // Latest scan for this merchant defines the "current scan" cap window.
  const { data: latestScan } = await supabase
    .from("scans")
    .select("id, created_at")
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let usedCount = 0;
  if (latestScan) {
    const { count } = await supabase
      .from("appeal_letters")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchant.id)
      .eq("scan_id", latestScan.id);
    usedCount = count ?? 0;
  }

  // Every generated letter is persisted to appeal_letters by the action.
  // Surface this merchant's recent letters (most recent first) so they
  // remain available across reloads / navigation instead of vanishing once
  // the action response clears.
  const { data: savedLettersRaw } = await supabase
    .from("appeal_letters")
    .select("id, suspension_reason, generated_letter, created_at")
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const savedLetters = (
    (savedLettersRaw ?? []) as Array<{
      id: string;
      suspension_reason: string | null;
      generated_letter: string | null;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    suspensionReason: row.suspension_reason ?? null,
    letter: row.generated_letter ?? "",
    createdAt: row.created_at,
  }));

  return {
    hasScan: !!latestScan,
    usedCount,
    limit: APPEAL_LIMIT_PER_SCAN,
    shopName: merchant.shop_name ?? session.shop,
    savedLetters,
  };
};

// ─── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const suspensionReason = String(formData.get("suspension_reason") ?? "").trim();
  const fixesMade = String(formData.get("fixes_made") ?? "").trim();

  if (!suspensionReason || !fixesMade) {
    return data(
      {
        ok: false,
        error: "Both fields are required.",
        letter: null,
      },
      { status: 400 },
    );
  }

  // Look up merchant + latest scan for the cap.
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();
  if (!merchant) {
    return data(
      { ok: false, error: "Merchant not found.", letter: null },
      { status: 404 },
    );
  }

  if (!hasPaidAccess(merchant.tier)) {
    return data(
      {
        ok: false,
        error: "A paid plan is required to generate appeal letters.",
        letter: null,
      },
      { status: 403 },
    );
  }

  const { data: latestScan } = await supabase
    .from("scans")
    .select("id")
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestScan) {
    return data(
      {
        ok: false,
        error: "Run a compliance scan first — the appeal letter references your scan results.",
        letter: null,
      },
      { status: 400 },
    );
  }

  // Per-scan cap (UX nudge — 3 letters per scan).
  const { count } = await supabase
    .from("appeal_letters")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchant.id)
    .eq("scan_id", latestScan.id);
  if ((count ?? 0) >= APPEAL_LIMIT_PER_SCAN) {
    return data(
      {
        ok: false,
        error: `Maximum ${APPEAL_LIMIT_PER_SCAN} appeal letter generations per scan. Run a new scan to generate more.`,
        letter: null,
      },
      { status: 429 },
    );
  }

  // Monthly AI cap (12/window, shared across policies + appeal letters).
  // Consumed BEFORE we hit Anthropic so a cap-reached request never
  // costs a model call.
  const credit = await checkAndConsumeAiCredit(merchant.id);
  if (!credit.allowed) {
    const resetIso = windowResetIso(credit.resetAt);
    const resetDate = resetIso
      ? new Date(resetIso).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "soon";
    return data(
      {
        ok: false,
        error: `You've used all ${AI_MONTHLY_CAP} AI generations this month. Your limit resets on ${resetDate}.`,
        letter: null,
      },
      { status: 429 },
    );
  }

  // Pull store info for prompt context.
  const executor = wrapAdminClient(admin.graphql);
  const shopInfo = await getShopInfo(executor);
  if (!shopInfo) {
    return data(
      { ok: false, error: "Could not load store info — please try again.", letter: null },
      { status: 500 },
    );
  }

  let letter: string;
  try {
    letter = await generateAppealLetter({ shopInfo, suspensionReason, fixesMade });
  } catch (err) {
    console.error("[appeal-letter] generation failed:", err);
    return data(
      {
        ok: false,
        error: "AI generation failed. Please try again in a moment.",
        letter: null,
      },
      { status: 502 },
    );
  }

  if (!letter || letter.length < 50) {
    return data(
      { ok: false, error: "Empty or too-short response — please retry.", letter: null },
      { status: 502 },
    );
  }

  await supabase.from("appeal_letters").insert({
    merchant_id: merchant.id,
    scan_id: latestScan.id,
    suspension_reason: suspensionReason,
    generated_letter: letter,
  });

  return data({ ok: true, error: null, letter });
};

// ─── Saved-letter card ──────────────────────────────────────────────────────────

interface SavedLetter {
  id: string;
  suspensionReason: string | null;
  letter: string;
  createdAt: string;
}

// One card per persisted letter. Lives in its own component so the
// useWebComponentClick hook is called exactly once per render (calling it
// inside the parent's .map() would violate the rules of hooks).
function SavedLetterCard({ entry }: { entry: SavedLetter }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!entry.letter || !navigator.clipboard) return;
    navigator.clipboard.writeText(entry.letter).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {
        /* clipboard denied — the text stays on screen for manual copy */
      },
    );
  }, [entry.letter]);
  const copyRef = useWebComponentClick<HTMLElement>(copy);

  const date = new Date(entry.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "16px",
        margin: "12px 0 0",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
          marginBottom: "8px",
        }}
      >
        <strong style={{ fontSize: "13px" }}>Generated {date}</strong>
        {/* @ts-ignore — s-button ref via useWebComponentClick (Polaris web-component type gap) */}
        <s-button variant="secondary" ref={copyRef}>{copied ? "Copied" : "Copy"}</s-button>
      </div>
      {entry.suspensionReason && (
        <p
          style={{
            margin: "0 0 8px",
            fontSize: "13px",
            color: "var(--p-color-text-subdued, #6d7175)",
          }}
        >
          <strong>Suspension reason:</strong> {entry.suspensionReason}
        </p>
      )}
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "#f6f6f7",
          padding: "16px",
          borderRadius: "8px",
          fontFamily: "inherit",
          fontSize: "14px",
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        {entry.letter}
      </pre>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AppealLetterPage() {
  const { hasScan, usedCount, limit, shopName, savedLetters } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isGenerating = nav.state === "submitting" || nav.state === "loading";

  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);
  const submitRef = useWebComponentClick<HTMLElement>(submitForm);

  const remaining = Math.max(0, limit - usedCount);

  if (!hasScan) {
    return (
      <s-page heading="GMC Appeal Letter Generator">
        <s-section>
          <s-banner tone="warning">
            Run a compliance scan first. The appeal letter references your scan
            results so we need at least one scan on file.
          </s-banner>
          <s-link href="/app">Return to dashboard</s-link>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="GMC Appeal Letter Generator">
      <s-section>
        <s-paragraph>
          Generate a re-review request letter for a Google Merchant Center
          suspension. Tell us Google's stated reason and the fixes you've made,
          and ShieldKit drafts a letter you can paste into the GMC appeal form.
        </s-paragraph>
        <s-paragraph>
          <strong>{remaining}</strong> of {limit} generations remaining for the
          current scan ({shopName}). Run a new scan to reset the counter.
        </s-paragraph>
      </s-section>

      <s-section heading="Tell us what happened">
        <form method="post" ref={formRef}>
          <div style={{ marginBottom: "16px" }}>
            <label
              htmlFor="suspension_reason"
              style={{ display: "block", fontWeight: 600, marginBottom: "4px" }}
            >
              What did Google say your suspension reason was?
            </label>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "13px",
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              Paste the exact text from your suspension notice.
            </p>
            <textarea
              id="suspension_reason"
              name="suspension_reason"
              required
              rows={6}
              style={{
                width: "100%",
                padding: "10px 12px",
                fontSize: "14px",
                fontFamily: "inherit",
                lineHeight: 1.5,
                border: "1px solid #c9cccf",
                borderRadius: "6px",
                resize: "vertical",
              }}
            />
          </div>
          <div style={{ marginBottom: "16px" }}>
            <label
              htmlFor="fixes_made"
              style={{ display: "block", fontWeight: 600, marginBottom: "4px" }}
            >
              List the fixes you've made
            </label>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "13px",
                color: "var(--p-color-text-subdued, #6d7175)",
              }}
            >
              Be specific — "updated refund policy with 30-day window", "added phone number to contact page", etc.
            </p>
            <textarea
              id="fixes_made"
              name="fixes_made"
              required
              rows={6}
              style={{
                width: "100%",
                padding: "10px 12px",
                fontSize: "14px",
                fontFamily: "inherit",
                lineHeight: 1.5,
                border: "1px solid #c9cccf",
                borderRadius: "6px",
                resize: "vertical",
              }}
            />
          </div>
          {/* @ts-ignore — s-button supports `loading` and `disabled` as runtime attrs */}
          <s-button
            variant="primary"
            ref={submitRef}
            {...(isGenerating ? { loading: "" } : {})}
            {...(remaining === 0 ? { disabled: "" } : {})}
          >
            {isGenerating ? "Generating…" : "Generate appeal letter"}
          </s-button>
        </form>
      </s-section>

      {actionData?.error && (
        <s-section>
          <s-banner tone="critical" heading="Generation failed">
            {actionData.error}
          </s-banner>
        </s-section>
      )}

      {actionData?.ok && actionData.letter && (
        <s-section heading="Your appeal letter">
          <s-paragraph>
            Copy and paste this into the GMC appeal form. Review it before
            submitting — it's a starting point, not a finished legal document.
          </s-paragraph>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#f6f6f7",
              padding: "16px",
              borderRadius: "8px",
              fontFamily: "inherit",
              fontSize: "14px",
              lineHeight: 1.6,
              margin: "12px 0 0",
            }}
          >
            {actionData.letter}
          </pre>
        </s-section>
      )}

      {savedLetters.length > 0 && (
        <s-section heading="Your saved appeal letters">
          <s-paragraph>
            Every letter you generate is saved here so you can return to it
            later — these stay available when you reload or leave the page.
          </s-paragraph>
          {savedLetters.map((entry) => (
            <SavedLetterCard key={entry.id} entry={entry} />
          ))}
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
