// All detectors: plain functions of (ledger, detector clock, settings) -> incident drafts.
// No I/O, no LLM. Each draft has a dedupe key so a sweep can run every minute without
// reopening the same incident.

import type { IncidentDraft, Ledger, Settings } from "../domain";
import { detectAuthorizationAging } from "./authorizations";
import { detectCaptureFailures, detectDuplicateCharges } from "./captures";
import { detectDisputeDeadlines, detectOverdueInvoices } from "./invoices";
import { detectRefundAnomalies } from "./refunds";

export const DETECTORS = [
  { id: "authorization-aging", run: detectAuthorizationAging },
  { id: "capture-failures", run: detectCaptureFailures },
  { id: "duplicate-charges", run: detectDuplicateCharges },
  { id: "refund-anomalies", run: detectRefundAnomalies },
  { id: "overdue-invoices", run: detectOverdueInvoices },
  { id: "dispute-deadlines", run: detectDisputeDeadlines },
] as const;

export function runDetectors(ledger: Ledger, now: Date, settings: Settings): IncidentDraft[] {
  return DETECTORS.flatMap((d) => d.run(ledger, now, settings));
}

export {
  detectAuthorizationAging,
  detectCaptureFailures,
  detectDuplicateCharges,
  detectRefundAnomalies,
  detectOverdueInvoices,
  detectDisputeDeadlines,
};
