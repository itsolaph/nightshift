// The watcher keeps the ledger in step with PayPal and opens incidents.
//
//   sweep()               periodic pull: re-reads every tracked order, lists invoices and disputes,
//                         and uses Transaction Search to find captures/refunds Nightshift hasn't seen
//   handleWebhookEvent()  push: a verified PayPal webhook names a resource; re-read it and ingest
//   detectAndOpen()       runs the detectors against the ledger and opens new incidents
//
// PayPal has no "list orders" endpoint, so orders enter the ledger from the shop (ingest API or
// the scenario lab), from webhooks, or from Transaction Search.

import type { Store } from "./db";
import { runDetectors } from "./detectors";
import { DAY_MS } from "./clock";
import type { Incident } from "./domain";
import { detectorClock } from "./engine";
import { ingestCapture, ingestDispute, ingestInvoice, ingestOrder, ingestRefund, idFromLink } from "./ledger";
import type { PayPalClient } from "./paypal/client";
import type * as T from "./paypal/types";
import { formatMoney } from "./money";

const CLOSED: Incident["status"][] = ["resolved", "dismissed"];

/** Runs every detector and opens incidents that don't exist yet. One open incident per PayPal object. */
export function detectAndOpen(store: Store): Incident[] {
  const clock = detectorClock(store);
  const now = clock.now();
  const drafts = runDetectors(store.ledger(), now, store.settings());
  const openSubjects = new Set(
    store
      .listIncidents()
      .filter((i) => !CLOSED.includes(i.status) && i.subject)
      .map((i) => `${i.subject!.kind}:${i.subject!.id}`),
  );
  const opened: Incident[] = [];
  for (const draft of drafts) {
    const subjectKey = draft.subject ? `${draft.subject.kind}:${draft.subject.id}` : null;
    if (subjectKey && openSubjects.has(subjectKey)) continue;
    const incident = store.openIncident(draft, now.toISOString());
    if (!incident) continue;
    if (subjectKey) openSubjects.add(subjectKey);
    opened.push(incident);
    store.addEvent({
      incidentId: incident.id,
      kind: "detected",
      actor: "detector",
      title: `Detected: ${incident.title}`,
      detail: {
        type: incident.type,
        atRisk: formatMoney(incident.atRiskCents, incident.currency),
        evidence: incident.evidence,
        detectorClock: now.toISOString(),
        demoOffsetDays: clock.offsetDays,
      },
    });
  }
  return opened;
}

export type SweepReport = {
  at: string;
  orders: number;
  invoices: number;
  disputes: number;
  discovered: number;
  errors: string[];
};

const CAPTURE_EVENT_CODES = new Set(["T0003", "T0004", "T0005", "T0006", "T0007", "T0011"]);
const REFUND_EVENT_CODES = new Set(["T1107", "T1106", "T1201"]);

export async function sweep(store: Store, client: PayPalClient): Promise<SweepReport> {
  const report: SweepReport = { at: new Date().toISOString(), orders: 0, invoices: 0, disputes: 0, discovered: 0, errors: [] };
  const note = (what: string, result: { status: number; body: unknown }) =>
    report.errors.push(`${what}: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 160)}`);

  // 1. Re-read tracked orders (recent ones; PayPal authorizations live at most 29 days).
  const cutoff = Date.now() - 35 * DAY_MS;
  const orders = store.listLedger("order").filter((o) => new Date(o.createdAt).getTime() > cutoff);
  for (const order of orders.slice(-100)) {
    const result = await client.getOrder(order.id);
    if (result.ok) {
      ingestOrder(store, result.body);
      report.orders++;
    } else note(`GET order ${order.id}`, result);
  }

  // 2. Invoices: list, then read open ones in full (the list omits payments).
  for (let page = 1; page <= 3; page++) {
    const result = await client.listInvoices(page, 50);
    if (!result.ok) {
      note("GET invoices", result);
      break;
    }
    for (const summary of result.body.items ?? []) {
      let invoice = summary;
      if (["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(summary.status)) {
        const full = await client.getInvoice(summary.id);
        if (full.ok) invoice = full.body;
      }
      ingestInvoice(store, invoice);
      report.invoices++;
    }
    if (page >= (result.body.total_pages ?? 1)) break;
  }

  // 3. Disputes.
  const disputes = await client.listDisputes();
  if (disputes.ok) {
    for (const d of disputes.body.items ?? []) {
      ingestDispute(store, d);
      report.disputes++;
    }
  } else if (disputes.status !== 404) note("GET disputes", disputes);

  // 4. Transaction Search for captures and refunds not in the ledger (last 3 days; it lags up to 3h).
  const end = new Date();
  const start = new Date(end.getTime() - 3 * DAY_MS);
  const search = await client.searchTransactions(start, end);
  if (search.ok) {
    for (const tx of search.body.transaction_details ?? []) {
      const info = tx.transaction_info;
      const code = info.transaction_event_code ?? "";
      if (report.discovered >= 20) break;
      if (CAPTURE_EVENT_CODES.has(code) && !store.getLedger("capture", info.transaction_id)) {
        const cap = await client.getCapture(info.transaction_id);
        const orderId = cap.ok ? cap.body.supplementary_data?.related_ids?.order_id : undefined;
        if (cap.ok && orderId) {
          const order = await client.getOrder(orderId);
          if (order.ok) ingestOrder(store, order.body, { source: "sweep" });
          else ingestCapture(store, cap.body, orderId);
          report.discovered++;
        }
      } else if (REFUND_EVENT_CODES.has(code) && !store.getLedger("refund", info.transaction_id)) {
        const ref = await client.getRefund(info.transaction_id);
        const captureId = ref.ok ? idFromLink(ref.body.links, "up", "captures") : null;
        if (ref.ok && captureId && store.getLedger("capture", captureId)) {
          ingestRefund(store, ref.body, undefined, captureId);
          report.discovered++;
        }
      }
    }
  } else {
    note("GET transactions (needs the Transaction search feature on the sandbox app)", search);
  }

  // 5. Account balance (Transaction Search balances endpoint, same feature flag).
  const balances = await client.getBalances();
  if (balances.ok) {
    store.setKv(
      "balances",
      (balances.body.balances ?? []).map((b) => ({ currency: b.currency, total: b.total_balance?.value ?? null, available: b.available_balance?.value ?? null })),
    );
  } else note("GET balances", balances);

  store.setKv("sweep:last", report);
  return report;
}

/** Webhook event types Nightshift subscribes to. */
export const WEBHOOK_EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.FAILED",
  "CHECKOUT.ORDER.APPROVED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.UPDATED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
];

/** Ingests a verified webhook event by re-reading the resource it names (never trusting the payload's state). */
export async function handleWebhookEvent(store: Store, client: PayPalClient | null, event: T.WebhookEvent): Promise<string> {
  const resource = event.resource ?? {};
  const id = typeof resource.id === "string" ? resource.id : "";
  const type = event.event_type;
  const orderIdFromResource = (resource as T.Capture).supplementary_data?.related_ids?.order_id;

  if (type.startsWith("CUSTOMER.DISPUTE.")) {
    ingestDispute(store, resource as unknown as T.DisputeSummary);
    return "dispute ingested";
  }
  if (!client) return "PayPal not connected; event stored only";

  if (type.startsWith("INVOICING.INVOICE.")) {
    const invoiceId = (resource as { invoice?: { id?: string } }).invoice?.id ?? id;
    const result = await client.getInvoice(invoiceId);
    if (result.ok) ingestInvoice(store, result.body);
    return result.ok ? `invoice ${invoiceId} refreshed` : `invoice ${invoiceId}: HTTP ${result.status}`;
  }

  let orderId = orderIdFromResource ?? null;
  if (!orderId && type.startsWith("CHECKOUT.ORDER.")) orderId = id;
  if (!orderId && type.startsWith("PAYMENT.AUTHORIZATION.")) {
    const auth = await client.getAuthorization(id);
    orderId = auth.ok ? (auth.body.supplementary_data?.related_ids?.order_id ?? null) : null;
  }
  if (!orderId && type.startsWith("PAYMENT.CAPTURE.")) {
    const cap = await client.getCapture(id);
    orderId = cap.ok ? (cap.body.supplementary_data?.related_ids?.order_id ?? null) : null;
  }
  if (!orderId && type.startsWith("PAYMENT.REFUND.")) {
    const captureId = idFromLink((resource as T.Refund).links, "up", "captures");
    orderId = captureId ? (store.getLedger("capture", captureId)?.orderId ?? null) : null;
  }
  if (!orderId) return "could not link the event to an order";
  const order = await client.getOrder(orderId);
  if (!order.ok) return `order ${orderId}: HTTP ${order.status}`;
  ingestOrder(store, order.body, { source: store.getLedger("order", orderId) ? undefined : "webhook" });
  return `order ${orderId} refreshed`;
}
