// Ledger builders for tests. Ids look like PayPal sandbox ids but are made up.

import { DAY_MS, HOUR_MS } from "@/lib/clock";
import {
  DEFAULT_SETTINGS,
  type Incident,
  type Ledger,
  type LedgerAuthorization,
  type LedgerCapture,
  type LedgerInvoice,
  type LedgerOrder,
  type LedgerRefund,
} from "@/lib/domain";

export const T0 = new Date("2026-10-01T12:00:00Z");
export const at = (days: number, hours = 0) => new Date(T0.getTime() + days * DAY_MS + hours * HOUR_MS);
export const isoAt = (days: number, hours = 0) => at(days, hours).toISOString();

export const settings = (patch: Partial<typeof DEFAULT_SETTINGS> = {}) => ({ ...DEFAULT_SETTINGS, ...patch });

export const emptyLedger = (): Ledger => ({
  orders: [],
  authorizations: [],
  captures: [],
  refunds: [],
  invoices: [],
  captureAttempts: [],
  disputes: [],
});

export function order(patch: Partial<LedgerOrder> = {}): LedgerOrder {
  return {
    id: "5O190127TN364715T",
    intent: "AUTHORIZE",
    status: "COMPLETED",
    amountCents: 4200,
    currency: "USD",
    payer: "buyer@example.com",
    cartRef: "cart-1001",
    description: "Ethiopia Guji, 1kg",
    fulfillment: "unfulfilled",
    shippedAt: null,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    source: "scenario",
    ...patch,
  };
}

export function auth(patch: Partial<LedgerAuthorization> = {}): LedgerAuthorization {
  return {
    id: "0VF52814937998046",
    orderId: "5O190127TN364715T",
    status: "CREATED",
    amountCents: 4200,
    currency: "USD",
    createdAt: isoAt(0),
    expiresAt: isoAt(29),
    updatedAt: isoAt(0),
    ...patch,
  };
}

export function capture(patch: Partial<LedgerCapture> = {}): LedgerCapture {
  return {
    id: "2GG279541U471931P",
    orderId: "5O190127TN364715T",
    authorizationId: null,
    status: "COMPLETED",
    statusReason: null,
    amountCents: 4200,
    currency: "USD",
    finalCapture: true,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    ...patch,
  };
}

export function refund(patch: Partial<LedgerRefund> = {}): LedgerRefund {
  return {
    id: "1JU08902781691411",
    captureId: "2GG279541U471931P",
    orderId: "5O190127TN364715T",
    status: "COMPLETED",
    amountCents: 1000,
    currency: "USD",
    createdAt: isoAt(0, 1),
    updatedAt: isoAt(0, 1),
    ...patch,
  };
}

export function invoice(patch: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    id: "INV2-Z56S-5LLA-Q52L-CPZ5",
    number: "NS-0001",
    status: "SENT",
    recipient: "cafe@example.com",
    totalCents: 18000,
    paidCents: 0,
    currency: "USD",
    invoiceDate: "2026-10-01",
    dueDate: "2026-10-15",
    lastReminderAt: null,
    updatedAt: isoAt(0),
    ...patch,
  };
}

export function incidentFrom(draft: Omit<Incident, "id" | "status" | "savedCents" | "detectedAt" | "createdAt" | "updatedAt" | "diagnosis" | "diagnosisSource" | "model">, patch: Partial<Incident> = {}): Incident {
  return {
    ...draft,
    id: "inc_test",
    status: "triaging",
    savedCents: 0,
    detectedAt: isoAt(0),
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    diagnosis: null,
    diagnosisSource: null,
    model: null,
    ...patch,
  };
}
