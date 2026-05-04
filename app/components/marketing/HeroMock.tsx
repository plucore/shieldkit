/**
 * Visual mock of a ShieldKit dashboard "scorecard" — pure HTML/CSS, no images.
 * Used in both v1 and v2 hero sections so the brand stays consistent.
 */
export function HeroMock() {
  const checks = [
    { name: "Refund & return policy", status: "fail" },
    { name: "Hidden fees disclosed", status: "fail" },
    { name: "Contact information", status: "warn" },
    { name: "Shipping policy", status: "pass" },
    { name: "Privacy & terms", status: "pass" },
  ] as const;

  return (
    <div className="relative w-full max-w-md mx-auto">
      {/* Decorative back card */}
      <div className="absolute -right-3 -bottom-3 inset-x-3 top-3 rounded-2xl bg-brand-navy/10 -z-10" />

      <div className="rounded-2xl bg-white shadow-card border border-brand-card-border p-6 sm:p-7">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-brand-gray-text">
              Compliance score
            </div>
            <div className="mt-1 text-5xl font-extrabold text-brand-red leading-none">
              30%
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold uppercase tracking-wider text-brand-gray-text">
              Threat level
            </div>
            <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-brand-red/10 text-brand-red px-3 py-1 text-sm font-bold">
              <span className="h-2 w-2 rounded-full bg-brand-red" />
              High
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <KpiTile label="Passed" value="2" tone="green" />
          <KpiTile label="Critical" value="2" tone="red" />
          <KpiTile label="Warnings" value="1" tone="amber" />
        </div>

        <div className="mt-5 space-y-2">
          {checks.map((c) => (
            <div
              key={c.name}
              className="flex items-center justify-between rounded-lg border border-brand-card-border bg-white px-3 py-2.5"
            >
              <span className="text-sm font-medium text-brand-navy">{c.name}</span>
              <StatusPill status={c.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "red" | "amber";
}) {
  const toneClass =
    tone === "green"
      ? "text-brand-green"
      : tone === "red"
        ? "text-brand-red"
        : "text-brand-amber";
  return (
    <div className="rounded-lg bg-[#f5f8fc] py-3">
      <div className={`text-2xl font-extrabold ${toneClass}`}>{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-gray-text mt-0.5">
        {label}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "pass" | "fail" | "warn" }) {
  if (status === "pass") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-green/10 text-brand-green text-xs font-bold px-2.5 py-1">
        <Check /> Pass
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-red/10 text-brand-red text-xs font-bold px-2.5 py-1">
        <Cross /> Fail
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-amber/15 text-brand-amber text-xs font-bold px-2.5 py-1">
      <Warn /> Warn
    </span>
  );
}

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Cross() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function Warn() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M6 2v5M6 9.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
