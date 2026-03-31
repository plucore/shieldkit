/**
 * app/lib/scan-helpers.ts
 *
 * Pure helper functions for the ShieldKit dashboard UI.
 * Used by extracted components and the main dashboard route.
 */

import type { Severity, CheckResult } from "./types";

// ─── Date formatting ─────────────────────────────────────────────────────────

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ─── Check display helpers ───────────────────────────────────────────────────

type ComponentTone =
  | "critical" | "warning" | "info"
  | "success"  | "caution" | "neutral" | "auto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function checkStatusIcon(check: CheckResult): { type: any; tone: ComponentTone } {
  if (check.passed && check.severity === "info")
    return { type: "info-filled", tone: "info" };
  if (check.passed)
    return { type: "check-circle-filled", tone: "success" };
  switch (check.severity) {
    case "critical": return { type: "x-circle-filled",       tone: "critical" };
    case "warning":  return { type: "alert-triangle-filled", tone: "caution"  };
    case "error":    return { type: "question-circle",       tone: "caution"  };
    default:         return { type: "info-filled",           tone: "info"     };
  }
}

export function checkBadgeTone(check: CheckResult): ComponentTone {
  if (check.passed && check.severity === "info") return "info";
  if (check.passed) return "success";
  const map: Record<Severity, ComponentTone> = {
    critical: "critical",
    warning:  "warning",
    info:     "neutral",
    error:    "caution",
  };
  return map[check.severity] ?? "neutral";
}

export function checkBadgeText(check: CheckResult): string {
  if (check.passed && check.severity === "info") return "Skipped";
  if (check.passed) return "Passed";
  const map: Record<Severity, string> = {
    critical: "Critical",
    warning:  "Warning",
    info:     "Info",
    error:    "Error",
  };
  return map[check.severity] ?? check.severity;
}

export function checkBorderColor(check: CheckResult): string {
  if (check.passed && check.severity === "info")
    return "var(--p-color-border-info, #98c6cd)";
  if (check.passed) return "var(--p-color-border-success, #1a9e5c)";
  switch (check.severity) {
    case "critical": return "var(--p-color-border-critical, #e51c00)";
    case "warning":  return "var(--p-color-border-caution,  #e8820c)";
    case "error":    return "var(--p-color-border-caution,  #e8820c)";
    default:         return "var(--p-color-border-subdued,  #c9cccf)";
  }
}

export function checkRowBg(check: CheckResult): string {
  if (check.passed) return "transparent";
  switch (check.severity) {
    case "critical": return "var(--p-color-bg-critical-subdued, #fff4f4)";
    case "warning":  return "var(--p-color-bg-caution-subdued,  #fff5ea)";
    default:         return "transparent";
  }
}

// ─── Check sorting ───────────────────────────────────────────────────────────

const SEV_RANK: Record<string, number> = {
  critical: 0, error: 1, warning: 2, info: 3,
};

export function sortChecks(checks: CheckResult[]): CheckResult[] {
  return [...checks].sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? 1 : -1;
    return (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4);
  });
}

// ─── Threat level helpers ────────────────────────────────────────────────────

export function threatLabel(score: number): string {
  const t = 100 - score;
  if (t < 20) return "Minimal";
  if (t < 40) return "Low";
  if (t < 60) return "Elevated";
  if (t < 80) return "High";
  return "Critical";
}

export function threatColor(score: number): string {
  const t = 100 - score;
  if (t < 20) return "#1a9e5c";
  if (t < 40) return "#6aad81";
  if (t < 60) return "#e8820c";
  if (t < 80) return "#d82c0d";
  return "#c00000";
}

export function threatBarGradient(score: number): string {
  const t = 100 - score;
  if (t < 20) return "#1a9e5c, #2db57a";
  if (t < 40) return "#6aad81, #a5d6b0";
  if (t < 60) return "#e8820c, #f4a444";
  if (t < 80) return "#d82c0d, #e85a40";
  return "#c00000, #e51c00";
}

export function scoreColor(score: number): string {
  if (score >= 80) return "#1a9e5c";
  if (score >= 50) return "#e8820c";
  return "#e51c00";
}
