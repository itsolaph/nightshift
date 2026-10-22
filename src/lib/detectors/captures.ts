// Captures that went wrong.
//
//   capture_failed    PayPal returned a DECLINED/FAILED capture, or rejected a capture call outright
//                     (no capture object, only an error), and the authorization is still uncaptured
//   duplicate_charge  the same payer paid the same amount for the same cart twice within a short window

import { daysBetween } from "../clock";
import type { IncidentDraft, Ledger, LedgerCapture, Settings } from "../domain";
import { formatMoney } from "../money";
import { isSuperseded, OPEN_AUTH_STATUSES, orderOf, refundedCents, uncapturedCents } from "./helpers";

const FAILED_CAPTURE_STATUSES = new Set(["DECLINED", "FAILED"]);
const PENDING_TOO_LONG_DAYS = 3;

export function detectCaptureFailures(ledger: Ledger, now: Date): IncidentDraft[] {
  const drafts: IncidentDraft[] = [];
  const seenAuth = new Set<string>();

  // 1. Capture objects in a failed state, or stuck in PENDING.
  for (const capture of ledger.captures) {
    const pendingTooLong =
      capture.status === "PENDING" && daysBetween(capture.createdAt, now) >= PENDING_TOO_LONG_DAYS;
    if (!FAILED_CAPTURE_STATUSES.has(capture.status) && !pendingTooLong) continue;
    if (capture.authorizationId) seenAuth.add(capture.authorizationId);
    const order = orderOf(ledger, capture.orderId);
    const money = formatMoney(capture.amountCents, capture.currency);
    drafts.push({
      type: "capture_failed",
      dedupeKey: `capture_failed:capture:${capture.id}`,
      title: pendingTooLong
        ? `${money} capture stuck in PENDING for ${Math.floor(daysBetween(capture.createdAt, now))} days`
        : `${money} capture ${capture.status.toLowerCase()}${order?.fulfillment === "shipped" ? " after the goods shipped" : ""}`,
      orderId: capture.orderId,
      subject: { kind: "capture", id: capture.id },
      atRiskCents: capture.amountCents,
      currency: capture.currency,
      deadline: null,
      evidence: {
        summary: `Capture ${capture.id} on order ${capture.orderId} has status ${capture.status}${
          capture.statusReason ? ` (${capture.statusReason})` : ""
        }. The money has not reached the merchant.`,
        facts: {
          capture_id: capture.id,
          capture_status: capture.status,
          status_reason: capture.statusReason,
          authorization_id: capture.authorizationId,
          order_id: capture.orderId,
          fulfillment: order?.fulfillment ?? "unknown",
          amount: money,
        },
        refs: [
          { kind: "order", id: capture.orderId },
          ...(capture.authorizationId ? [{ kind: "authorization" as const, id: capture.authorizationId }] : []),
          { kind: "capture", id: capture.id },
        ],
      },
    });
  }

  // 2. Capture calls PayPal rejected. The authorization is still open and nothing was collected.
  const failedByAuth = new Map<string, Ledger["captureAttempts"]>();
  for (const attempt of ledger.captureAttempts) {
    if (attempt.ok) continue;
    failedByAuth.set(attempt.authorizationId, [...(failedByAuth.get(attempt.authorizationId) ?? []), attempt]);
  }
  for (const [authId, attempts] of failedByAuth) {
    if (seenAuth.has(authId)) continue;
    const auth = ledger.authorizations.find((a) => a.id === authId);
    if (!auth || !OPEN_AUTH_STATUSES.has(auth.status) || isSuperseded(ledger, auth)) continue;
    const remaining = uncapturedCents(ledger, auth);
    if (remaining <= 0) continue;
    const last = attempts.toSorted((a, b) => a.at.localeCompare(b.at)).at(-1)!;
    const order = orderOf(ledger, auth.orderId);
    const money = formatMoney(remaining, auth.currency);
    drafts.push({
      type: "capture_failed",
      dedupeKey: `capture_failed:attempt:${authId}`,
      title: `Capture of ${money} rejected by PayPal (${last.errorIssue ?? last.errorName ?? `HTTP ${last.httpStatus}`})${
        order?.fulfillment === "shipped" ? ", goods already shipped" : ""
      }`,
      orderId: auth.orderId,
      subject: { kind: "authorization", id: auth.id },
      atRiskCents: remaining,
      currency: auth.currency,
      deadline: auth.expiresAt || null,
      evidence: {
        summary: `${attempts.length} capture attempt(s) on authorization ${auth.id} failed. The last one returned HTTP ${last.httpStatus} ${
          last.errorName ?? ""
        } ${last.errorIssue ?? ""} (debug id ${last.debugId ?? "n/a"}). The authorization is still ${auth.status} with ${money} uncaptured.`,
        facts: {
          authorization_id: auth.id,
          authorization_status: auth.status,
          order_id: auth.orderId,
          fulfillment: order?.fulfillment ?? "unknown",
          failed_attempts: attempts.length,
          last_http_status: last.httpStatus,
          last_error_name: last.errorName,
          last_error_issue: last.errorIssue,
          last_debug_id: last.debugId,
          last_attempt_at: last.at,
          attempted_by: last.source,
          uncaptured: money,
        },
        refs: [
          { kind: "order", id: auth.orderId },
          { kind: "authorization", id: auth.id },
        ],
      },
    });
  }
  return drafts;
}

export function detectDuplicateCharges(ledger: Ledger, _now: Date, settings: Settings): IncidentDraft[] {
  const windowMs = settings.duplicateWindowMinutes * 60_000;
  const groups = new Map<string, { capture: LedgerCapture; payer: string; cartRef: string }[]>();

  for (const capture of ledger.captures) {
    if (!["COMPLETED", "PENDING", "PARTIALLY_REFUNDED"].includes(capture.status)) continue;
    const order = orderOf(ledger, capture.orderId);
    if (!order?.payer) continue;
    const key = [order.payer.toLowerCase(), order.cartRef || "-", capture.amountCents, capture.currency].join("|");
    groups.set(key, [...(groups.get(key) ?? []), { capture, payer: order.payer, cartRef: order.cartRef }]);
  }

  const drafts: IncidentDraft[] = [];
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const sorted = entries.toSorted((a, b) => a.capture.createdAt.localeCompare(b.capture.createdAt));
    for (let i = 1; i < sorted.length; i++) {
      const first = sorted[0].capture;
      const dup = sorted[i].capture;
      const gapMs = new Date(dup.createdAt).getTime() - new Date(first.createdAt).getTime();
      if (gapMs > windowMs || first.orderId === dup.orderId) continue;
      // Already refunded in full: nothing left to fix.
      if (refundedCents(ledger, dup.id) >= dup.amountCents) continue;
      const money = formatMoney(dup.amountCents, dup.currency);
      const cartKnown = Boolean(sorted[i].cartRef);
      drafts.push({
        type: "duplicate_charge",
        dedupeKey: `duplicate_charge:${dup.id}`,
        title: `${sorted[i].payer} charged ${money} twice${cartKnown ? ` for cart ${sorted[i].cartRef}` : ""}`,
        orderId: dup.orderId,
        subject: { kind: "capture", id: dup.id },
        atRiskCents: dup.amountCents - refundedCents(ledger, dup.id),
        currency: dup.currency,
        deadline: null,
        evidence: {
          summary: `Captures ${first.id} (order ${first.orderId}) and ${dup.id} (order ${dup.orderId}) charged the same payer ${money} ${
            cartKnown ? `for the same cart reference ${sorted[i].cartRef} ` : ""
          }${Math.round(gapMs / 1000)} seconds apart. A buyer who sees two charges files a dispute.`,
          facts: {
            payer: sorted[i].payer,
            cart_ref: sorted[i].cartRef || null,
            amount: money,
            first_capture_id: first.id,
            first_order_id: first.orderId,
            first_captured_at: first.createdAt,
            duplicate_capture_id: dup.id,
            duplicate_order_id: dup.orderId,
            duplicate_captured_at: dup.createdAt,
            seconds_apart: Math.round(gapMs / 1000),
            same_cart_reference: cartKnown,
          },
          refs: [
            { kind: "order", id: first.orderId },
            { kind: "capture", id: first.id },
            { kind: "order", id: dup.orderId },
            { kind: "capture", id: dup.id },
          ],
        },
      });
    }
  }
  return drafts;
}

