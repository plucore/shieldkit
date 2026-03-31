/**
 * app/lib/compliance-scanner.server.ts
 *
 * Barrel re-export. The implementation has been split into app/lib/checks/.
 */

export { runComplianceScan } from "./checks/index.server";
export type { Severity, ScanViolation, ScanRecord, ComplianceScanResult } from "./checks/types";
