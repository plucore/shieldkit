/**
 * app/lib/types.ts
 *
 * Shared type definitions used across the ShieldKit dashboard UI.
 */

export type Severity = "critical" | "warning" | "info" | "error";

export interface Merchant {
  id: string;
  shopify_domain: string;
  scans_remaining: number | null;
  tier: string;
}

export interface Scan {
  id: string;
  scan_type: string;
  compliance_score: number | null;
  total_checks: number | null;
  passed_checks: number | null;
  critical_count: number | null;
  warning_count: number | null;
  info_count: number | null;
  created_at: string;
}

export interface CheckResult {
  id: string;
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string | null;
  description: string | null;
  fix_instruction: string | null;
}

export interface ApiScanResponse {
  success?: boolean;
  error?: string;
  error_code?: string;
  message?: string;
  scanId?: string;
  policy?: {
    type: string;
    title: string;
    body: string;
    disclaimer: string;
  };
  policy_remaining?: number;
  policy_reset_date?: string | null;
}
