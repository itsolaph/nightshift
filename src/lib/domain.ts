// Nightshift's domain model: the local ledger mirrored from PayPal, incidents opened by the
// detectors, actions proposed by the agent and judged by the policy gate, and the timeline.

export type Fulfillment = "unfulfilled" | "shipped" | "cancelled";

export type LedgerOrder = {
  id: string;
  intent: "AUTHORIZE" | "CAPTURE";
  status: string;
  amountCents: number;
  currency: string;
  /** Sandbox payer email or card holder, used to spot double charges. */
  payer: string;
  /** The shop's cart / reference id (purchase_units[0].custom_id). */
  cartRef: string;
  description: string;
  fulfillment: Fulfillment;
  shippedAt: string | null;
  createdAt: string;
  updatedAt: string;
  source: "scenario" | "webhook" | "ingest" | "sweep";
  scenario?: string;
  /** Free text the buyer or shop attached to the order. Untrusted: shown to the agent as data. */
  buyerNote?: string;
};

export type LedgerAuthorization = {
  id: string;
  orderId: string;
  status: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
};

export type LedgerCapture = {
  id: string;
  orderId: string;
  authorizationId: string | null;
  status: string;
  statusReason: string | null;
  amountCents: number;
  currency: string;
  finalCapture: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LedgerRefund = {
  id: string;
  captureId: string;
  orderId: string;
  status: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  /** Set when Nightshift's executor issued the refund to fix an incident. */
  issuedBy?: "nightshift";
};

export type LedgerInvoice = {
  id: string;
  number: string;
  status: string;
  recipient: string;
  totalCents: number;
  paidCents: number;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  lastReminderAt: string | null;
  updatedAt: string;
};

/** A capture call that PayPal rejected (no capture object exists, only an error response). */
export type CaptureAttempt = {
  id: string;
  orderId: string;
  authorizationId: string;
  at: string;
  ok: boolean;
  httpStatus: number;
  errorName: string | null;
  errorIssue: string | null;
  debugId: string | null;
  source: "shop" | "nightshift";
};

export type LedgerDispute = {
  id: string;
  status: string;
  reason: string;
  amountCents: number;
  currency: string;
  responseDueAt: string | null;
  transactionIds: string[];
  updatedAt: string;
};

export type Ledger = {
  orders: LedgerOrder[];
  authorizations: LedgerAuthorization[];
  captures: LedgerCapture[];
  refunds: LedgerRefund[];
  invoices: LedgerInvoice[];
  captureAttempts: CaptureAttempt[];
  disputes: LedgerDispute[];
};

export const INCIDENT_TYPES = [
  "uncaptured_shipment",
  "auth_honor_expired",
  "auth_expiring",
  "capture_failed",
  "duplicate_charge",
  "duplicate_refund",
  "refund_exceeds_capture",
  "refund_spike",
  "invoice_overdue",
  "dispute_deadline",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_LABELS: Record<IncidentType, string> = {
  uncaptured_shipment: "Shipped, not captured",
  auth_honor_expired: "Honor period lapsed",
  auth_expiring: "Authorization expiring",
  capture_failed: "Capture failed",
  duplicate_charge: "Double charge",
  duplicate_refund: "Duplicate refund",
  refund_exceeds_capture: "Refund above capture",
  refund_spike: "Refund spike",
  invoice_overdue: "Invoice overdue",
  dispute_deadline: "Dispute deadline",
};

export type IncidentStatus = "open" | "triaging" | "awaiting_approval" | "resolved" | "failed" | "dismissed";

export type PayPalRef = { kind: "order" | "authorization" | "capture" | "refund" | "invoice" | "dispute"; id: string };

export type Evidence = {
  summary: string;
  facts: Record<string, string | number | boolean | null>;
  refs: PayPalRef[];
};

export type IncidentDraft = {
  type: IncidentType;
  dedupeKey: string;
  title: string;
  orderId: string | null;
  subject: PayPalRef | null;
  atRiskCents: number;
  currency: string;
  deadline: string | null;
  evidence: Evidence;
};

export type Incident = IncidentDraft & {
  id: string;
  status: IncidentStatus;
  savedCents: number;
  detectedAt: string;
  createdAt: string;
  updatedAt: string;
  diagnosis: string | null;
  diagnosisSource: "llm" | "rules" | null;
  model: string | null;
};

export const ACTION_TYPES = [
  "capture_authorization",
  "reauthorize_authorization",
  "void_authorization",
  "refund_capture",
  "send_invoice_reminder",
  "mark_resolved",
  "ask_owner",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_LABELS: Record<ActionType, string> = {
  capture_authorization: "Capture authorization",
  reauthorize_authorization: "Reauthorize",
  void_authorization: "Void authorization",
  refund_capture: "Refund capture",
  send_invoice_reminder: "Send invoice reminder",
  mark_resolved: "Mark resolved",
  ask_owner: "Ask the owner",
};

/** What the agent (or the rule-based fallback) proposes. `type` is untrusted until the gate checks it. */
export type ProposedAction = {
  type: string;
  targetId?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  note?: string | null;
  rationale: string;
};

export type PolicyDecision = "auto" | "needs_approval" | "forbidden";

export type ActionStatus =
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "succeeded"
  | "failed"
  | "blocked"
  | "done";

export type PayPalCall = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  requestId?: string;
};

export type ActionRecord = {
  id: string;
  incidentId: string;
  type: string;
  targetId: string | null;
  amountCents: number | null;
  currency: string | null;
  note: string | null;
  rationale: string;
  proposedBy: "agent" | "rules" | "owner";
  decision: PolicyDecision;
  reasons: string[];
  status: ActionStatus;
  idempotencyKey: string;
  call: PayPalCall | null;
  response: { status: number; body: unknown; debugId: string | null } | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
};

export type TimelineKind =
  | "detected"
  | "agent_step"
  | "agent_tool"
  | "diagnosis"
  | "proposal"
  | "policy"
  | "approval"
  | "paypal_call"
  | "paypal_response"
  | "outcome"
  | "note";

export type TimelineEvent = {
  seq: number;
  incidentId: string | null;
  at: string;
  kind: TimelineKind;
  actor: "watcher" | "detector" | "agent" | "policy" | "executor" | "paypal" | "owner" | "system" | "lab";
  title: string;
  detail: unknown;
};

export type Settings = {
  demoClockOffsetDays: number;
  autopilot: boolean;
  autoCaptureMaxCents: number;
  honorWarningHours: number;
  expiryWarningDays: number;
  uncapturedAfterHours: number;
  duplicateWindowMinutes: number;
  refundSpikeRate: number;
  refundSpikeMinCount: number;
  invoiceReminderCooldownHours: number;
};

export const DEFAULT_SETTINGS: Settings = {
  demoClockOffsetDays: 0,
  autopilot: true,
  autoCaptureMaxCents: 50_000,
  honorWarningHours: 24,
  expiryWarningDays: 3,
  uncapturedAfterHours: 12,
  duplicateWindowMinutes: 30,
  refundSpikeRate: 0.3,
  refundSpikeMinCount: 3,
  invoiceReminderCooldownHours: 72,
};
