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
  useFetcher,
  useLoaderData,
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
import { useSingleFlight } from "../hooks/useSingleFlight";
import { wrapAdminClient, getShopInfo } from "../lib/shopify-api.server";
import { generateAppealLetter } from "../lib/llm/appeal-letter.server";
import { hasPaidAccess } from "../lib/billing/plans";
import {
  AI_MONTHLY_CAP,
  checkAndConsumeAiCredit,
  windowResetIso,
} from "../lib/ai-usage.server";
import {
  reserveAppealSlot,
  finalizeAppealSlot,
  releaseAppealSlot,
} from "../lib/appeal-letters.server";
import { buildHistoryTitles, type SavedLetter } from "../lib/appeal-history";

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
    // Count only FINALIZED letters — exclude NULL-letter reservations (in-flight
    // or abandoned). Counting reservations here would let a leaked row (a crash
    // between reserve and finalize) inflate the count, disable the Generate
    // button (remaining===0), and thereby block the reserve RPC that reclaims
    // stale reservations — a self-lock. The RPC remains the authoritative cap
    // and counts reservations for enforcement; this is display-only.
    const { count } = await supabase
      .from("appeal_letters")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchant.id)
      .eq("scan_id", latestScan.id)
      .not("generated_letter", "is", null);
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
    // Exclude in-flight reservations (generated_letter NULL) so a slot that's
    // mid-generation never renders as an empty saved-letter card.
    .not("generated_letter", "is", null)
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
        error: "Run a compliance scan first. The appeal letter references your scan results.",
        letter: null,
      },
      { status: 400 },
    );
  }

  // Per-scan cap (3 letters per scan) — enforced FIRST and atomically so
  // concurrent submits can't each slip under the cap (the TOCTOU that let 5
  // letters through for one scan). reserveAppealSlot serializes callers for
  // this scan on a per-scan advisory lock and inserts a placeholder row only
  // when under the cap. An over-cap attempt is rejected here, before any AI
  // credit or Anthropic call is spent.
  const reservation = await reserveAppealSlot(
    merchant.id,
    latestScan.id,
    APPEAL_LIMIT_PER_SCAN,
  );
  if (!reservation.accepted || !reservation.letterId) {
    return data(
      {
        ok: false,
        error: `Maximum ${APPEAL_LIMIT_PER_SCAN} appeal letter generations per scan. Run a new scan to generate more.`,
        letter: null,
      },
      { status: 429 },
    );
  }
  const reservedLetterId = reservation.letterId;

  // Monthly AI cap (12/window, shared across policies + appeal letters).
  // Consumed AFTER the cap reservation (so an over-cap attempt never burns a
  // credit) but BEFORE Anthropic (so a cap-reached request never costs a model
  // call). Release the reserved slot on any failure below so a failed
  // generation doesn't consume one of the 3 per-scan slots.
  const credit = await checkAndConsumeAiCredit(merchant.id);
  if (!credit.allowed) {
    await releaseAppealSlot(reservedLetterId);
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
    await releaseAppealSlot(reservedLetterId);
    return data(
      { ok: false, error: "Could not load store info, please try again.", letter: null },
      { status: 500 },
    );
  }

  // Today's date, computed server-side, so the letter is dated correctly.
  const todayIso = new Date().toISOString().slice(0, 10);

  let letter: string;
  try {
    letter = await generateAppealLetter({
      shopInfo,
      suspensionReason,
      fixesMade,
      todayIso,
    });
  } catch (err) {
    console.error("[appeal-letter] generation failed:", err);
    await releaseAppealSlot(reservedLetterId);
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
    await releaseAppealSlot(reservedLetterId);
    return data(
      { ok: false, error: "Empty or too-short response, please retry.", letter: null },
      { status: 502 },
    );
  }

  // Fill the reserved row with the generated letter.
  await finalizeAppealSlot(reservedLetterId, suspensionReason, letter);

  return data({ ok: true, error: null, letter });
};

// ─── Copy button ────────────────────────────────────────────────────────────

// Reused by the just-generated letter and every history entry. Its own
// component so useWebComponentClick is called once per instance (calling it
// inside a parent .map() would break the rules of hooks).
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {
        /* clipboard denied, text stays on screen for manual copy */
      },
    );
  }, [text]);
  const copyRef = useWebComponentClick<HTMLElement>(copy);
  return (
    // @ts-ignore — s-button ref via useWebComponentClick (Polaris web-component type gap)
    <s-button variant="secondary" ref={copyRef}>
      {copied ? "Copied" : label}
    </s-button>
  );
}

const preStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#f6f6f7",
  padding: "16px",
  borderRadius: "8px",
  fontFamily: "inherit",
  fontSize: "14px",
  lineHeight: 1.6,
  margin: "12px 0 0",
};

// ─── History (collapsed, dated) ──────────────────────────────────────────────

// Native <details> gives a zero-JS accordion, collapsed by default.
function HistoryItem({ entry, title }: { entry: SavedLetter; title: string }) {
  return (
    <details
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 16px",
        margin: "12px 0 0",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          fontSize: "14px",
          color: "#0f172a",
        }}
      >
        {title}
      </summary>
      {entry.suspensionReason && (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: "13px",
            color: "var(--p-color-text-subdued, #6d7175)",
          }}
        >
          <strong>Suspension reason:</strong> {entry.suspensionReason}
        </p>
      )}
      <pre style={preStyle}>{entry.letter}</pre>
      <div style={{ marginTop: "12px" }}>
        <CopyButton text={entry.letter} />
      </div>
    </details>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AppealLetterPage() {
  const { hasScan, usedCount, limit, shopName, savedLetters } =
    useLoaderData<typeof loader>();
  // useFetcher (not a raw <form> submit): the busy state actually updates on
  // submit, so the single-flight guard + disabled/loading gate engage (a raw
  // <form> did a native browser POST that useNavigation never tracked, so the
  // button never locked and a fast second click fired a second POST). fetcher
  // also surfaces the result immediately (no manual refresh) and auto-
  // revalidates the loader so the history + remaining count refresh.
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const isGenerating = fetcher.state !== "idle";

  const remaining = Math.max(0, limit - usedCount);
  const atCap = remaining === 0;

  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = useCallback(() => {
    if (formRef.current) fetcher.submit(formRef.current, { method: "POST" });
  }, [fetcher]);
  const submitDisabled = isGenerating || atCap;
  const submitOnce = useSingleFlight(submitForm, isGenerating);
  const submitRef = useWebComponentClick<HTMLElement>(submitOnce, submitDisabled);

  const historyTitles = buildHistoryTitles(savedLetters);

  if (!hasScan) {
    return (
      <s-page heading="GMC Appeal Letter Generator">
        <s-section>
          <s-banner tone="warning">
            Run a compliance scan first. The appeal letter references your scan
            results, so we need at least one scan on file.
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

      {atCap && (
        <s-section>
          <s-banner tone="warning" heading="Appeal letter limit reached">
            You've reached the limit of {limit} appeal letters for this scan. Run
            a new compliance scan to generate more.
          </s-banner>
        </s-section>
      )}

      <s-section heading="Tell us what happened">
        {/* preventDefault: if the <s-button> default-submits this form, cancel
            the native (untracked) browser POST so ONLY the guarded
            fetcher.submit below fires. fetcher.submit reads the form data
            directly and does not dispatch a submit event, so it's unaffected. */}
        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
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
              Be specific, e.g. "updated refund policy with 30-day window",
              "added phone number to contact page".
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
            {...(submitDisabled ? { disabled: "" } : {})}
          >
            {isGenerating ? "Generating…" : "Generate appeal letter"}
          </s-button>
        </form>
      </s-section>

      {result?.error && (
        <s-section>
          <s-banner tone="critical" heading="Generation failed">
            {result.error}
          </s-banner>
        </s-section>
      )}

      {result?.ok && result.letter && (
        <s-section heading="Your appeal letter">
          <s-paragraph>
            Copy and paste this into the GMC appeal form. Review it before
            submitting, it's a starting point, not a finished legal document.
          </s-paragraph>
          <pre style={preStyle}>{result.letter}</pre>
          <div style={{ marginTop: "12px" }}>
            <CopyButton text={result.letter} label="Copy letter" />
          </div>
        </s-section>
      )}

      {savedLetters.length > 0 && (
        <s-section heading="Your saved appeal letters">
          <s-paragraph>
            Every letter you generate is saved here so you can return to it
            later. Open one to read it and copy it again.
          </s-paragraph>
          {savedLetters.map((entry) => (
            <HistoryItem
              key={entry.id}
              entry={entry}
              title={historyTitles[entry.id]}
            />
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
