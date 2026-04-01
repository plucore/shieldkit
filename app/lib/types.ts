/**
 * app/lib/types.ts
 *
 * Shared type definitions used across the ShieldKit dashboard UI.
 */

export type Severity = "critical" | "warning" | "info" | "error";

export interface GeneratedPolicies {
  refund?: string;
  shipping?: string;
  privacy?: string;
  terms?: string;
}

export interface PolicyRegenUsed {
  refund?: boolean;
  shipping?: boolean;
  privacy?: boolean;
  terms?: boolean;
}

export interface Merchant {
  id: string;
  shopify_domain: string;
  scans_remaining: number | null;
  tier: string;
  json_ld_enabled: boolean;
  generated_policies: GeneratedPolicies;
  policy_regen_used: PolicyRegenUsed;
  review_prompted: boolean;
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
  generated_policies?: GeneratedPolicies;
  policy_regen_used?: PolicyRegenUsed;
}
