// Turns PayPal API objects into Nightshift ledger rows. Every row keeps PayPal's own id, so any id
// shown in the UI can be looked up in the sandbox.

import { randomUUID } from "node:crypto";
import type { Store } from "./db";
import type {
  CaptureAttempt,
  Fulfillment,
  LedgerAuthorization,
  LedgerCapture,
  LedgerInvoice,
  LedgerOrder,
  LedgerRefund,
} from "./domain";
import { toCents } from "./money";
import type * as T from "./paypal/types";
import { describeError, type PayPalResult } from "./paypal/client";

const now = () => new Date().toISOString();

/**
 * PayPal timestamps in UTC ISO form. The sandbox mixes formats: captures and authorizations come back
 * as "2026-10-22T09:30:44Z", refunds and voided authorizations as "2026-10-22T02:30:46-07:00".
 * Detectors sort and compare these as strings, so everything is normalised on the way in.
 */
export function utcTime(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** The id after the last slash of the HATEOAS link with the given rel, e.g. rel "up" on a capture. */
export function idFromLink(links: T.Link[] | undefined, rel: string, segment: string): string | null {
  const link = links?.find((l) => l.rel === rel && l.href.includes(`/${segment}/`));
  if (!link) return null;
  const match = link.href.match(new RegExp(`/${segment}/([^/?]+)`));
  return match?.[1] ?? null;
}

export type OrderMeta = {
  fulfillment?: Fulfillment;
  shippedAt?: string | null;
  source?: LedgerOrder["source"];
  scenario?: string;
  payer?: string;
  buyerNote?: string;
};

export function ingestOrder(store: Store, order: T.Order, meta: OrderMeta = {}): LedgerOrder {
  const existing = store.getLedger("order", order.id);
  const unit = order.purchase_units?.[0];
  const payer =
    meta.payer ??
    order.payer?.email_address ??
    order.payment_source?.paypal?.email_address ??
    (order.payment_source?.card?.last_digits
      ? `${order.payment_source.card.name ?? "card"} ****${order.payment_source.card.last_digits}`
      : "");
  const row: LedgerOrder = {
    id: order.id,
    intent: order.intent,
    status: order.status,
    amountCents: toCents(unit?.amount?.value ?? existing?.amountCents?.toString() ?? "0"),
    currency: unit?.amount?.currency_code ?? existing?.currency ?? "USD",
    payer: payer || existing?.payer || "",
    cartRef: unit?.custom_id ?? existing?.cartRef ?? "",
    description: unit?.description ?? existing?.description ?? "",
    fulfillment: meta.fulfillment ?? existing?.fulfillment ?? "unfulfilled",
    shippedAt: meta.shippedAt !== undefined ? meta.shippedAt : (existing?.shippedAt ?? null),
    createdAt: utcTime(order.create_time) ?? existing?.createdAt ?? now(),
    updatedAt: now(),
    source: existing?.source ?? meta.source ?? "sweep",
    scenario: meta.scenario ?? existing?.scenario,
    buyerNote: meta.buyerNote ?? existing?.buyerNote,
  };
  if (unit?.amount?.value) row.amountCents = toCents(unit.amount.value);
  store.putLedger("order", row);

  for (const auth of unit?.payments?.authorizations ?? []) ingestAuthorization(store, auth, order.id);
  for (const capture of unit?.payments?.captures ?? []) ingestCapture(store, capture, order.id);
  for (const refund of unit?.payments?.refunds ?? []) ingestRefund(store, refund, order.id);
  return row;
}

export function ingestAuthorization(store: Store, auth: T.Authorization, orderId?: string): LedgerAuthorization {
  const existing = store.getLedger("authorization", auth.id);
  const row: LedgerAuthorization = {
    id: auth.id,
    orderId: orderId ?? auth.supplementary_data?.related_ids?.order_id ?? existing?.orderId ?? "",
    status: auth.status,
    amountCents: toCents(auth.amount?.value),
    currency: auth.amount?.currency_code ?? "USD",
    createdAt: utcTime(auth.create_time) ?? existing?.createdAt ?? now(),
    expiresAt: utcTime(auth.expiration_time) ?? existing?.expiresAt ?? "",
    updatedAt: now(),
  };
  store.putLedger("authorization", row);
  return row;
}

export function ingestCapture(store: Store, capture: T.Capture, orderId?: string): LedgerCapture {
  const existing = store.getLedger("capture", capture.id);
  const row: LedgerCapture = {
    id: capture.id,
    orderId: orderId ?? capture.supplementary_data?.related_ids?.order_id ?? existing?.orderId ?? "",
    authorizationId:
      capture.supplementary_data?.related_ids?.authorization_id ??
      idFromLink(capture.links, "up", "authorizations") ??
      existing?.authorizationId ??
      null,
    status: capture.status,
    statusReason: capture.status_details?.reason ?? null,
    amountCents: toCents(capture.amount?.value),
    currency: capture.amount?.currency_code ?? "USD",
    finalCapture: capture.final_capture ?? true,
    createdAt: utcTime(capture.create_time) ?? existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  store.putLedger("capture", row);
  return row;
}

export function ingestRefund(store: Store, refund: T.Refund, orderId?: string, captureId?: string): LedgerRefund {
  const existing = store.getLedger("refund", refund.id);
  const capId = captureId ?? idFromLink(refund.links, "up", "captures") ?? existing?.captureId ?? "";
  const row: LedgerRefund = {
    id: refund.id,
    captureId: capId,
    orderId: orderId ?? existing?.orderId ?? store.getLedger("capture", capId)?.orderId ?? "",
    status: refund.status,
    amountCents: toCents(refund.amount?.value),
    currency: refund.amount?.currency_code ?? "USD",
    createdAt: utcTime(refund.create_time) ?? existing?.createdAt ?? now(),
    updatedAt: now(),
    ...(existing?.issuedBy ? { issuedBy: existing.issuedBy } : {}),
  };
  store.putLedger("refund", row);
  return row;
}

export function ingestInvoice(store: Store, invoice: T.Invoice): LedgerInvoice {
  const existing = store.getLedger("invoice", invoice.id);
  const total = toCents(invoice.amount?.value);
  const paid =
    invoice.payments?.paid_amount !== undefined
      ? toCents(invoice.payments.paid_amount.value)
      : invoice.due_amount !== undefined
        ? Math.max(0, total - toCents(invoice.due_amount.value))
        : (existing?.paidCents ?? 0);
  const recipient = invoice.primary_recipients?.[0]?.billing_info;
  const row: LedgerInvoice = {
    id: invoice.id,
    number: invoice.detail?.invoice_number ?? existing?.number ?? invoice.id,
    status: invoice.status,
    recipient: recipient?.email_address ?? existing?.recipient ?? "",
    totalCents: total,
    paidCents: paid,
    currency: invoice.amount?.currency_code ?? invoice.detail?.currency_code ?? "USD",
    invoiceDate: invoice.detail?.invoice_date ?? existing?.invoiceDate ?? now().slice(0, 10),
    dueDate: invoice.detail?.payment_term?.due_date ?? existing?.dueDate ?? null,
    lastReminderAt: existing?.lastReminderAt ?? null,
    updatedAt: now(),
  };
  store.putLedger("invoice", row);
  return row;
}

export function ingestDispute(store: Store, d: T.DisputeSummary) {
  store.putLedger("dispute", {
    id: d.dispute_id,
    status: d.status,
    reason: d.reason ?? "",
    amountCents: toCents(d.dispute_amount?.value),
    currency: d.dispute_amount?.currency_code ?? "USD",
    responseDueAt: utcTime(d.seller_response_due_date) ?? null,
    transactionIds: (d.disputed_transactions ?? [])
      .map((t) => t.seller_transaction_id ?? t.buyer_transaction_id ?? "")
      .filter(Boolean),
    updatedAt: now(),
  });
}

/** Records a capture call and its outcome. Failed calls leave no capture object at PayPal, so this is the only trace. */
export function recordCaptureAttempt(
  store: Store,
  args: { orderId: string; authorizationId: string; result: PayPalResult; source: CaptureAttempt["source"] },
): CaptureAttempt {
  const error = args.result.ok ? null : describeError(args.result.body);
  const attempt: CaptureAttempt = {
    id: `att_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    orderId: args.orderId,
    authorizationId: args.authorizationId,
    at: now(),
    ok: args.result.ok,
    httpStatus: args.result.status,
    errorName: error?.name ?? null,
    errorIssue: error?.issue ?? null,
    debugId: args.result.debugId,
    source: args.source,
  };
  store.putLedger("capture_attempt", attempt);
  return attempt;
}

/** Applies a successful money-moving response to the ledger. */
export function applyPayPalResult(store: Store, actionType: string, targetId: string, body: unknown) {
  switch (actionType) {
    case "capture_authorization": {
      const capture = body as T.Capture;
      const auth = store.getLedger("authorization", targetId);
      if (capture?.id) {
        const row = ingestCapture(store, capture, auth?.orderId);
        if (!row.authorizationId) store.putLedger("capture", { ...row, authorizationId: targetId });
      }
      break;
    }
    case "reauthorize_authorization": {
      const auth = body as T.Authorization;
      const old = store.getLedger("authorization", targetId);
      if (auth?.id) ingestAuthorization(store, auth, old?.orderId);
      break;
    }
    case "void_authorization": {
      const old = store.getLedger("authorization", targetId);
      if (old) store.putLedger("authorization", { ...old, status: "VOIDED", updatedAt: now() });
      break;
    }
    case "refund_capture": {
      const refund = body as T.Refund;
      const capture = store.getLedger("capture", targetId);
      if (refund?.id) store.putLedger("refund", { ...ingestRefund(store, refund, capture?.orderId, targetId), issuedBy: "nightshift" });
      break;
    }
    case "send_invoice_reminder": {
      const invoice = store.getLedger("invoice", targetId);
      if (invoice) store.putLedger("invoice", { ...invoice, lastReminderAt: now(), updatedAt: now() });
      break;
    }
  }
}
