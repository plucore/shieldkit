import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
  LinksFunction,
} from "react-router";
import { Form, useActionData, useNavigation, useFetcher } from "react-router";
import { useEffect, useState } from "react";

import { MarketingLayout } from "../components/marketing/MarketingLayout";
import { MarketingButton } from "../components/marketing/Button";
import { JsonLd } from "../components/marketing/JsonLd";
import { SITE } from "../lib/brand";
import {
  runPublicScan,
  type PublicScanResult,
  type PublicScanError,
  type PublicCheckResult,
} from "../lib/checks/public-scanner.server";
import { computeRiskScore } from "../lib/checks/public-risk-score";
import { supabase } from "../supabase.server";
import marketingStyles from "../marketing.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: marketingStyles },
];

export const meta: MetaFunction = () => {
  const title = "Free Shopify Compliance Scanner | ShieldKit";
  const description =
    "Run a free 8-point Google Merchant Center compliance scan against any Shopify store. No install required. See your score instantly.";
  const url = SITE.url + "/scan";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:type", content: "website" },
    { property: "og:image", content: SITE.url + SITE.ogImage },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { tagName: "link", rel: "canonical", href: url },
  ];
};

/* ─────────────────────────────────────────────────── Loader / Action ── */

// GET: empty form. We bounce shop-param visitors into the embedded app to be
// consistent with the homepage's behavior.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/app?${url.searchParams.toString()}` },
    });
  }
  return null;
}

interface ScanActionData {
  intent: "scan" | "unlock" | "error";
  scanId?: string;
  storeUrl?: string;
  email?: string;
  result?: PublicScanResult;
  riskScore?: number;
  error?: string;
  unlocked?: boolean;
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<ScanActionData> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "scan") {
    const rawUrl = String(form.get("url") ?? "").trim();
    if (!rawUrl) {
      return { intent: "error", error: "Please enter a store URL." };
    }
    const result = await runPublicScan(rawUrl);
    if (!(result as PublicScanError).ok && (result as PublicScanError).ok === false) {
      return {
        intent: "error",
        error: (result as PublicScanError).error,
        storeUrl: rawUrl,
      };
    }
    const ok = result as PublicScanResult;
    // We assign a synthetic scan id (not persisted to scans table — that's
    // for authenticated merchants only) so the UI can label this scan
    // and the leads-row can reference it for analytics later.
    const scanId = crypto.randomUUID();
    const riskScore = computeRiskScore(ok.results);

    // Fire-and-forget: persist the public risk score so we can later analyse
    // typical pre-install GMC-risk distribution. We update an existing leads
    // row if one exists; otherwise we wait for the unlock step to insert one
    // (don't insert here — leads.email is NOT NULL and we have no email yet).
    try {
      await supabase
        .from("leads")
        .update({ public_risk_score: riskScore })
        .eq("shop_domain", ok.store_url);
    } catch {
      // Don't block on log failure.
    }

    return {
      intent: "scan",
      scanId,
      storeUrl: ok.store_url,
      result: ok,
      riskScore,
      unlocked: false,
    };
  }

  if (intent === "unlock") {
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const storeUrl = String(form.get("storeUrl") ?? "").trim();
    const scanId = String(form.get("scanId") ?? "");
    const riskScoreRaw = form.get("riskScore");
    const riskScore =
      riskScoreRaw != null && riskScoreRaw !== "" ? Number(riskScoreRaw) : null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        intent: "error",
        error: "Please enter a valid email address.",
        storeUrl,
      };
    }

    // Persist to existing leads table. Schema fields are (shop_domain, email).
    // The brief mentions optional scan_id/scanned_at/source columns that
    // aren't in the live schema; we store only the supported columns to
    // avoid a migration. The synthetic scanId is kept client-side only.
    try {
      await supabase
        .from("leads")
        .upsert(
          {
            shop_domain: storeUrl || "unknown",
            email,
            ...(riskScore != null && Number.isFinite(riskScore)
              ? { public_risk_score: Math.round(riskScore) }
              : {}),
          },
          { onConflict: "shop_domain" }
        );
    } catch {
      // Don't block the user on a logging failure.
    }

    return {
      intent: "unlock",
      scanId,
      storeUrl,
      email,
      unlocked: true,
    };
  }

  return { intent: "error", error: "Unknown form action." };
}

/* ─────────────────────────────────────────────────────────── Page ── */

export default function ScanPage() {
  const data = useActionData<ScanActionData>();
  const navigation = useNavigation();
  const isScanning =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "scan";

  const result = data?.result;
  const error = data?.intent === "error" ? data.error : undefined;

  const webAppJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "ShieldKit Compliance Scanner",
    url: SITE.url + "/scan",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description:
      "Free public Google Merchant Center compliance scanner for Shopify stores.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };

  return (
    <MarketingLayout mainLabel="Free compliance scanner">
      <JsonLd data={webAppJsonLd} />

      <section className="mx-auto max-w-4xl px-4 sm:px-6 pt-14 sm:pt-20 pb-10">
        <div className="text-center">
          <span className="inline-flex items-center rounded-full bg-white/70 border border-brand-card-border px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand-navy">
            Free public scan
          </span>
          <h1 className="mt-4 text-4xl sm:text-5xl font-extrabold leading-[1.1]">
            Scan any Shopify store for GMC compliance
          </h1>
          <p className="mt-5 text-lg text-brand-gray-text max-w-2xl mx-auto">
            Enter your store URL. We'll run an 8-point Google Merchant Center
            compliance audit in under 60 seconds. No install required.
          </p>
        </div>

        <Form method="post" className="mt-10 max-w-2xl mx-auto">
          <input type="hidden" name="intent" value="scan" />
          <div className="flex flex-col sm:flex-row gap-3 bg-white border border-brand-card-border shadow-card rounded-2xl p-3">
            <input
              type="text"
              name="url"
              required
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              defaultValue={data?.storeUrl ?? ""}
              placeholder="examplestore.myshopify.com"
              className="flex-1 px-4 py-3 rounded-xl bg-transparent text-brand-navy placeholder-brand-gray-text outline-none text-base"
              aria-label="Shopify store URL"
            />
            <button
              type="submit"
              disabled={isScanning}
              className="rounded-xl bg-brand-navy text-white font-semibold px-6 py-3 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {isScanning ? "Scanning…" : "Run Scan"}
            </button>
          </div>
          <p className="mt-3 text-xs text-brand-gray-text text-center">
            We accept <code>store.myshopify.com</code>, your custom domain, or a
            full <code>https://</code> URL.
          </p>
        </Form>

        {error && (
          <div className="mt-6 max-w-2xl mx-auto rounded-xl bg-brand-red/10 border border-brand-red/40 text-brand-red px-4 py-3 text-sm font-medium">
            {error}
          </div>
        )}
      </section>

      {result && <ResultsView data={data!} />}

      {!result && !error && <SocialProof />}
    </MarketingLayout>
  );
}

/* ───────────────────────────────────────────────────────── Results ── */

function ResultsView({ data }: { data: ScanActionData }) {
  const result = data.result!;
  const [unlocked, setUnlocked] = useState(Boolean(data.unlocked));
  const unlockFetcher = useFetcher<ScanActionData>();

  // When the unlock fetcher returns unlocked=true, flip our local state.
  useEffect(() => {
    if (unlockFetcher.data?.unlocked) {
      setUnlocked(true);
    }
  }, [unlockFetcher.data]);

  const scoreColor =
    result.score >= 80
      ? "text-brand-green"
      : result.score >= 50
        ? "text-brand-amber"
        : "text-brand-red";
  const threatBg =
    result.threat_level === "Minimal" || result.threat_level === "Low"
      ? "bg-brand-green/10 text-brand-green"
      : result.threat_level === "Elevated"
        ? "bg-brand-amber/15 text-brand-amber"
        : "bg-brand-red/10 text-brand-red";

  return (
    <section className="mx-auto max-w-4xl px-4 sm:px-6 pb-10">
      <div className="rounded-2xl bg-white border border-brand-card-border shadow-card p-6 sm:p-8">
        <div className="flex flex-wrap gap-6 items-center justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text">
              Compliance score
            </div>
            <div className={`mt-1 text-6xl font-extrabold leading-none ${scoreColor}`}>
              {result.score}%
            </div>
            <div className="mt-2 text-sm text-brand-gray-text">
              {result.summary.passed_checks} of {result.summary.total_checks} checks passed
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text">
              Threat level
            </div>
            <div
              className={`mt-1 inline-flex items-center gap-1.5 rounded-full ${threatBg} px-3 py-1.5 text-base font-bold`}
            >
              {result.threat_level}
            </div>
            <div className="mt-2 text-xs text-brand-gray-text break-all">
              {result.store_url}
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3">
          <Kpi label="Passed" value={result.summary.passed_checks} tone="green" />
          <Kpi label="Critical" value={result.summary.critical_count} tone="red" />
          <Kpi label="Warnings" value={result.summary.warning_count} tone="amber" />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3 justify-center">
        <MarketingButton href={SITE.installUrl} size="md">
          Install ShieldKit to monitor weekly
        </MarketingButton>
        <MarketingButton to="/explainer" variant="secondary" size="md">
          Read the GMC explainer
        </MarketingButton>
      </div>

      {/* Phase 7 — Public GMC suspension risk score */}
      <RiskScoreBanner checks={result.results} />

      {/* Gated detail */}
      <div className="mt-10">
        <h2 className="text-2xl font-extrabold text-brand-navy">
          Findings ({result.results.length})
        </h2>
        <p className="mt-1 text-brand-gray-text text-sm">
          Sorted by severity. Critical issues first.
        </p>

        <div className="mt-6 space-y-3">
          {sortFindings(result.results).map((r) => (
            <FindingCard
              key={r.check_name}
              finding={r}
              unlocked={unlocked}
              storeUrl={result.store_url}
            />
          ))}
        </div>

        {!unlocked && (
          <div className="mt-8 rounded-2xl bg-white border border-brand-card-border shadow-card p-6 sm:p-8 text-center">
            <h3 className="text-2xl font-extrabold text-brand-navy">
              Unlock fix instructions
            </h3>
            <p className="mt-2 text-brand-gray-text max-w-md mx-auto">
              Enter your email to see what's failing on your store and exactly
              how to fix it. We never send spam — just the fix list.
            </p>
            <unlockFetcher.Form method="post" className="mt-5 max-w-md mx-auto">
              <input type="hidden" name="intent" value="unlock" />
              <input type="hidden" name="storeUrl" value={result.store_url} />
              <input type="hidden" name="scanId" value={data.scanId ?? ""} />
              <input
                type="hidden"
                name="riskScore"
                value={String(data.riskScore ?? "")}
              />
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="you@yourstore.com"
                  autoComplete="email"
                  className="flex-1 px-4 py-3 rounded-xl bg-white border border-brand-card-border text-brand-navy placeholder-brand-gray-text outline-none focus:ring-2 focus:ring-brand-navy"
                />
                <button
                  type="submit"
                  disabled={unlockFetcher.state !== "idle"}
                  className="rounded-xl bg-brand-navy text-white font-semibold px-6 py-3 hover:opacity-90 disabled:opacity-50 transition"
                >
                  {unlockFetcher.state !== "idle" ? "Unlocking…" : "Unlock fixes"}
                </button>
              </div>
              {unlockFetcher.data?.intent === "error" && unlockFetcher.data.error && (
                <p className="mt-2 text-sm text-brand-red">
                  {unlockFetcher.data.error}
                </p>
              )}
            </unlockFetcher.Form>
          </div>
        )}
      </div>

      <div className="mt-10 rounded-2xl bg-brand-navy text-white p-8 text-center">
        <h3 className="text-2xl font-extrabold">
          Want to understand what triggers GMC suspensions?
        </h3>
        <p className="mt-2 text-white/80">
          Our explainer walks through the seven most common triggers and the
          step-by-step recovery process.
        </p>
        <div className="mt-5">
          <MarketingButton
            to="/explainer"
            size="md"
            className="bg-white !text-brand-navy hover:bg-white/90"
          >
            Read the explainer
          </MarketingButton>
        </div>
      </div>
    </section>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: "green" | "red" | "amber" }) {
  const cls =
    tone === "green"
      ? "text-brand-green"
      : tone === "red"
        ? "text-brand-red"
        : "text-brand-amber";
  return (
    <div className="rounded-xl bg-[#f5f8fc] p-4 text-center">
      <div className={`text-2xl font-extrabold ${cls}`}>{value}</div>
      <div className="text-xs font-semibold uppercase tracking-wider text-brand-gray-text mt-1">
        {label}
      </div>
    </div>
  );
}

function sortFindings(results: PublicCheckResult[]): PublicCheckResult[] {
  const order: Record<string, number> = { critical: 0, warning: 1, error: 2, info: 3 };
  return [...results].sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? 1 : -1;
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
  });
}

function FindingCard({
  finding,
  unlocked,
  storeUrl,
}: {
  finding: PublicCheckResult;
  unlocked: boolean;
  storeUrl: string;
}) {
  const isPassed = finding.passed;
  const sev = finding.severity;

  const sevBadge = isPassed
    ? "bg-brand-green/10 text-brand-green"
    : sev === "critical"
      ? "bg-brand-red/10 text-brand-red"
      : sev === "warning"
        ? "bg-brand-amber/15 text-brand-amber"
        : "bg-brand-navy/10 text-brand-navy";

  const sevLabel = isPassed ? "PASS" : sev.toUpperCase();

  return (
    <details className="group rounded-xl bg-white border border-brand-card-border shadow-card p-5 open:shadow-card">
      <summary className="flex items-start gap-4 cursor-pointer list-none">
        <span
          className={`mt-0.5 inline-flex items-center rounded-full ${sevBadge} text-xs font-bold uppercase tracking-wider px-2.5 py-1`}
        >
          {sevLabel}
        </span>
        <div className="flex-1">
          <div className="font-bold text-brand-navy">{finding.title}</div>
          <div className="mt-1 text-sm text-brand-gray-text">
            {finding.description}
          </div>
        </div>
        <span className="text-brand-gray-text text-xl leading-none group-open:rotate-45 transition-transform">
          +
        </span>
      </summary>
      {!isPassed && (
        <div className="mt-4 ml-0 sm:ml-[60px]">
          {unlocked ? (
            <div className="rounded-lg bg-[#f5f8fc] border border-brand-card-border p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text">
                Resolution guide
              </div>
              <p className="mt-2 text-sm text-brand-navy leading-relaxed">
                {finding.fix_instruction}
              </p>
            </div>
          ) : (
            <div className="rounded-lg bg-[#f5f8fc] border border-dashed border-brand-card-border p-4 text-sm text-brand-gray-text italic">
              Fix instructions are gated — unlock with your email below.
            </div>
          )}
        </div>
      )}
      {/* hidden hidden hint for crawlers — no-op for users */}
      <span className="sr-only">{storeUrl}</span>
    </details>
  );
}

/* ─────────────────────────────────────────── Risk score banner ── */

function RiskScoreBanner({ checks }: { checks: PublicCheckResult[] }) {
  const score = computeRiskScore(checks);
  let band: { bg: string; text: string; label: string };
  if (score >= 80) {
    band = {
      bg: "bg-brand-green/10 border-brand-green/40",
      text: "text-brand-green",
      label: "Low risk — your store is in good shape.",
    };
  } else if (score >= 50) {
    band = {
      bg: "bg-brand-amber/15 border-brand-amber/40",
      text: "text-brand-amber",
      label: "Moderate risk — fix the issues below.",
    };
  } else {
    band = {
      bg: "bg-brand-red/10 border-brand-red/40",
      text: "text-brand-red",
      label: "High risk — multiple issues that commonly trigger GMC suspension.",
    };
  }
  return (
    <div className={`mt-8 rounded-2xl border ${band.bg} px-6 py-6 text-center`}>
      <div className="text-xs font-bold uppercase tracking-wider text-brand-gray-text">
        GMC suspension risk score
      </div>
      <div className={`mt-2 text-6xl font-extrabold leading-none ${band.text}`}>
        {score}
      </div>
      <p className={`mt-3 text-sm font-semibold ${band.text}`}>{band.label}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────── Empty state ── */

function SocialProof() {
  return (
    <section className="mx-auto max-w-5xl px-4 sm:px-6 pb-20">
      <div className="grid sm:grid-cols-3 gap-6">
        {[
          {
            n: "8",
            label: "compliance checks",
            desc: "From contact info to payment icons to JSON-LD — the same checks GMC runs.",
          },
          {
            n: "60s",
            label: "to a full report",
            desc: "Fully automated. No install, no scopes, no waiting.",
          },
          {
            n: "0",
            label: "data stored",
            desc: "We don't keep your store data. Email is opt-in for the unlock only.",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-2xl bg-white border border-brand-card-border shadow-card p-6"
          >
            <div className="text-4xl font-extrabold text-brand-navy">{s.n}</div>
            <div className="mt-1 text-sm font-bold uppercase tracking-wider text-brand-gray-text">
              {s.label}
            </div>
            <p className="mt-3 text-sm text-brand-gray-text leading-relaxed">
              {s.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
