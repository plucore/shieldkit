/**
 * app/lib/checks/types.ts
 *
 * Scanner-specific types used by the compliance check functions.
 */

export type Severity = "critical" | "warning" | "info" | "error";

/** The shape returned by every internal check helper. */
export interface CheckResult {
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string;
  description: string;
  fix_instruction: string;
  raw_data: Record<string, unknown>;
}

/** A fully persisted violation row as returned from Supabase. */
export interface ScanViolation {
  id: string;
  scan_id: string;
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string;
  description: string | null;
  fix_instruction: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

/** A fully persisted scan row as returned from Supabase. */
export interface ScanRecord {
  id: string;
  merchant_id: string;
  scan_type: "manual" | "automated";
  compliance_score: number;
  total_checks: number;
  passed_checks: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  created_at: string;
}

/** The value returned to callers of runComplianceScan(). */
export interface ComplianceScanResult {
  scan: ScanRecord;
  violations: ScanViolation[];
}

export type ProductIssue =
  | "empty_description"
  | "short_description"
  | "no_images"
  | "zero_price"
  | "missing_sku";

export interface FlaggedProduct {
  title: string;
  handle: string;
  issues: ProductIssue[];
}

/** Holds the result of a single public HTTP page fetch. */
export interface PageFetchResult {
  url: string;
  status: number | null;
  html: string | null;
}

export interface PageReport {
  url: string;
  product_schema_found: boolean;
  missing_required: string[];
  missing_recommended: string[];
}
