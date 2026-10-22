import type { Ledger, LedgerAuthorization, LedgerCapture, LedgerOrder } from "../domain";
import { addDays } from "../clock";

/** PayPal: honor period 3 days, authorization valid 29 days. */
export const HONOR_PERIOD_DAYS = 3;
export const AUTH_VALIDITY_DAYS = 29;

export const OPEN_AUTH_STATUSES = new Set(["CREATED", "PARTIALLY_CAPTURED", "PENDING"]);
export const SETTLED_CAPTURE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "PENDING"]);
export const LIVE_REFUND_STATUSES = new Set(["COMPLETED", "PENDING"]);

export function capturesFor(ledger: Ledger, authorizationId: string): LedgerCapture[] {
  return ledger.captures.filter((c) => c.authorizationId === authorizationId);
}

/** Authorized amount still available to capture. */
export function uncapturedCents(ledger: Ledger, auth: LedgerAuthorization): number {
  const captured = capturesFor(ledger, auth.id)
    .filter((c) => SETTLED_CAPTURE_STATUSES.has(c.status))
    .reduce((sum, c) => sum + c.amountCents, 0);
  return Math.max(0, auth.amountCents - captured);
}

export function refundedCents(ledger: Ledger, captureId: string): number {
  return ledger.refunds
    .filter((r) => r.captureId === captureId && LIVE_REFUND_STATUSES.has(r.status))
    .reduce((sum, r) => sum + r.amountCents, 0);
}

export function honorEndsAt(auth: LedgerAuthorization): Date {
  return addDays(auth.createdAt, HONOR_PERIOD_DAYS);
}

export function expiresAt(auth: LedgerAuthorization): Date {
  return auth.expiresAt ? new Date(auth.expiresAt) : addDays(auth.createdAt, AUTH_VALIDITY_DAYS);
}

export function orderOf(ledger: Ledger, orderId: string | null | undefined): LedgerOrder | undefined {
  return orderId ? ledger.orders.find((o) => o.id === orderId) : undefined;
}

/** The latest authorization for an order. A reauthorization creates a new id; the newest one is live. */
export function isSuperseded(ledger: Ledger, auth: LedgerAuthorization): boolean {
  return ledger.authorizations.some(
    (other) => other.orderId === auth.orderId && other.id !== auth.id && other.createdAt > auth.createdAt,
  );
}

export const iso = (d: Date) => d.toISOString();
