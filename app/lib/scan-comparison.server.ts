/**
 * app/lib/scan-comparison.server.ts
 *
 * Compares a new scan against a previous scan to determine whether an
 * alert should be sent. Identifies score drops and newly-failed checks.
 */

import { supabase } from "../supabase.server";

export interface ScanSummary {
  id: string;
  compliance_score: number;
  critical_count: number;
  warning_count: number;
}

export interface NewIssue {
  check_name: string;
  severity: string;
  title: string;
}

export interface ComparisonResult {
  shouldAlert: boolean;
  scoreDropped: boolean;
  oldScore: number;
  newScore: number;
  newIssues: NewIssue[];
}

/**
 * Fetch the most recent scan for a merchant that is NOT the current scan,
 * then compare scores and violations to decide whether an alert is warranted.
 *
 * Returns `null` if there is no previous scan to compare against.
 */
export async function compareScanWithPrevious(
  merchantId: string,
  currentScan: ScanSummary,
  currentViolations: Array<{ check_name: string; passed: boolean; severity: string; title?: string }>,
): Promise<ComparisonResult | null> {
  // Fetch the most recent scan BEFORE this one (the second-newest)
  const { data: previousScans } = await supabase
    .from("scans")
    .select("id, compliance_score, critical_count, warning_count")
    .eq("merchant_id", merchantId)
    .neq("id", currentScan.id)
    .order("created_at", { ascending: false })
    .limit(1);

  const previousScan = previousScans?.[0] ?? null;

  if (!previousScan) {
    return null;
  }

  const oldScore = previousScan.compliance_score ?? 100;
  const newScore = currentScan.compliance_score;
  const scoreDropped = newScore < oldScore;

  // Find new failed checks that weren't failing before
  let newIssues: NewIssue[] = [];

  if (previousScan.id) {
    const { data: oldViolations } = await supabase
      .from("violations")
      .select("check_name, passed")
      .eq("scan_id", previousScan.id);

    const oldFailedChecks = new Set(
      (oldViolations ?? [])
        .filter((v: { passed: boolean }) => !v.passed)
        .map((v: { check_name: string }) => v.check_name)
    );

    newIssues = currentViolations
      .filter((v) => !v.passed && !oldFailedChecks.has(v.check_name))
      .filter((v) => v.severity === "critical" || v.severity === "warning")
      .map((v) => ({
        check_name: v.check_name,
        severity: v.severity,
        title: v.title ?? v.check_name.replace(/_/g, " "),
      }));
  }

  const shouldAlert = scoreDropped || newIssues.length > 0;

  return { shouldAlert, scoreDropped, oldScore, newScore, newIssues };
}
