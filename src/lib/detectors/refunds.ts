// Refunds that cost more than they should.
//
//   duplicate_refund        the same amount refunded twice on one capture within a short window
//   refund_exceeds_capture  an order's refunds add up to more than its captured total
//   refund_spike            refunds in a 24-hour window are an unusual share of captures

import { HOUR_MS } from "../clock";
import type { IncidentDraft, Ledger, LedgerRefund, Settings } from "../domain";
import { formatMoney } from "../money";
import { LIVE_REFUND_STATUSES, SETTLED_CAPTURE_STATUSES } from "./helpers";

const DUPLICATE_REFUND_WINDOW_MS = 60 * 60_000;

export function detectRefundAnomalies(ledger: Ledger, _now: Date, settings: Settings): IncidentDraft[] {
  const drafts: IncidentDraft[] = [];
  const live = ledger.refunds.filter((r) => LIVE_REFUND_STATUSES.has(r.status));

  // Duplicate refunds per capture.
  const byCapture = new Map<string, LedgerRefund[]>();
  for (const refund of live) byCapture.set(refund.captureId, [...(byCapture.get(refund.captureId) ?? []), refund]);
  for (const [captureId, refunds] of byCapture) {
    const sorted = refunds.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted.slice(0, i).find(
        (r) =>
          r.amountCents === sorted[i].amountCents &&
          new Date(sorted[i].createdAt).getTime() - new Date(r.createdAt).getTime() <= DUPLICATE_REFUND_WINDOW_MS,
      );
      if (!prev) continue;
      const dup = sorted[i];
      const money = formatMoney(dup.amountCents, dup.currency);
      const seconds = Math.round((new Date(dup.createdAt).getTime() - new Date(prev.createdAt).getTime()) / 1000);
      drafts.push({
        type: "duplicate_refund",
        dedupeKey: `duplicate_refund:${dup.id}`,
        title: `${money} refunded twice on the same capture, ${seconds}s apart`,
        orderId: dup.orderId,
        subject: { kind: "refund", id: dup.id },
        atRiskCents: dup.amountCents,
        currency: dup.currency,
        deadline: null,
        evidence: {
          summary: `Refunds ${prev.id} and ${dup.id} both returned ${money} from capture ${captureId} ${seconds} seconds apart. That pattern usually means a retry without an idempotency key, not two decisions.`,
          facts: {
            capture_id: captureId,
            order_id: dup.orderId,
            first_refund_id: prev.id,
            first_refund_at: prev.createdAt,
            duplicate_refund_id: dup.id,
            duplicate_refund_at: dup.createdAt,
            amount: money,
            seconds_apart: seconds,
          },
          refs: [
            { kind: "order", id: dup.orderId },
            { kind: "capture", id: captureId },
            { kind: "refund", id: prev.id },
            { kind: "refund", id: dup.id },
          ],
        },
      });
    }
  }

  // Refunds above what was captured, per order.
  const orderIds = new Set(live.map((r) => r.orderId));
  for (const orderId of orderIds) {
    const captured = ledger.captures
      .filter((c) => c.orderId === orderId && SETTLED_CAPTURE_STATUSES.has(c.status))
      .reduce((sum, c) => sum + c.amountCents, 0);
    const refunds = live.filter((r) => r.orderId === orderId);
    const refunded = refunds.reduce((sum, r) => sum + r.amountCents, 0);
    if (refunded <= captured) continue;
    const currency = refunds[0].currency;
    drafts.push({
      type: "refund_exceeds_capture",
      dedupeKey: `refund_exceeds_capture:${orderId}`,
      title: `Refunds on order ${orderId} exceed what was captured by ${formatMoney(refunded - captured, currency)}`,
      orderId,
      subject: { kind: "order", id: orderId },
      atRiskCents: refunded - captured,
      currency,
      deadline: null,
      evidence: {
        summary: `Order ${orderId} captured ${formatMoney(captured, currency)} but ${refunds.length} refunds total ${formatMoney(refunded, currency)}.`,
        facts: { order_id: orderId, captured: formatMoney(captured, currency), refunded: formatMoney(refunded, currency), refunds: refunds.length },
        refs: [{ kind: "order", id: orderId }, ...refunds.map((r) => ({ kind: "refund" as const, id: r.id }))],
      },
    });
  }

  // Refund spike: anchored on the latest refund rather than "now", so the demo clock offset
  // doesn't push every refund out of the window.
  if (live.length >= settings.refundSpikeMinCount) {
    const latest = live.map((r) => new Date(r.createdAt).getTime()).reduce((a, b) => Math.max(a, b), 0);
    const from = latest - 24 * HOUR_MS;
    const inWindow = live.filter((r) => new Date(r.createdAt).getTime() >= from);
    const captures = ledger.captures.filter(
      (c) => SETTLED_CAPTURE_STATUSES.has(c.status) && new Date(c.createdAt).getTime() >= from,
    );
    const captureCount = Math.max(1, captures.length);
    const rate = inWindow.length / captureCount;
    if (inWindow.length >= settings.refundSpikeMinCount && rate >= settings.refundSpikeRate) {
      const currency = inWindow[0].currency;
      const total = inWindow.reduce((sum, r) => sum + r.amountCents, 0);
      const day = new Date(latest).toISOString().slice(0, 10);
      drafts.push({
        type: "refund_spike",
        dedupeKey: `refund_spike:${day}`,
        title: `${inWindow.length} refunds in 24h, ${Math.round(rate * 100)}% of captures`,
        orderId: null,
        subject: null,
        atRiskCents: total,
        currency,
        deadline: null,
        evidence: {
          summary: `${inWindow.length} refunds totalling ${formatMoney(total, currency)} against ${captures.length} captures in the 24 hours up to ${new Date(latest).toISOString()}. Threshold: ${Math.round(settings.refundSpikeRate * 100)}% with at least ${settings.refundSpikeMinCount} refunds.`,
          facts: {
            refunds: inWindow.length,
            captures: captures.length,
            refund_rate: Math.round(rate * 1000) / 1000,
            refunded_total: formatMoney(total, currency),
            window_end: new Date(latest).toISOString(),
          },
          refs: inWindow.slice(0, 20).map((r) => ({ kind: "refund" as const, id: r.id })),
        },
      });
    }
  }

  return drafts;
}
