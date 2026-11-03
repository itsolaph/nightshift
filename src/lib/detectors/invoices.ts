// Invoices and disputes with a date attached.
//
//   invoice_overdue   sent or partially paid, past its due date, money still owed
//   dispute_deadline  a dispute waits for the seller and the response deadline is close

import { DAY_MS } from "../clock";
import type { IncidentDraft, Ledger } from "../domain";
import { formatMoney } from "../money";

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export const REMINDABLE_INVOICE_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
const DISPUTE_WARNING_DAYS = 3;
const OPEN_DISPUTE_STATUSES = new Set(["OPEN", "WAITING_FOR_SELLER_RESPONSE"]);

export function detectOverdueInvoices(ledger: Ledger, now: Date): IncidentDraft[] {
  const today = now.toISOString().slice(0, 10);
  const drafts: IncidentDraft[] = [];
  for (const invoice of ledger.invoices) {
    if (!REMINDABLE_INVOICE_STATUSES.has(invoice.status) || !invoice.dueDate) continue;
    if (invoice.dueDate >= today) continue;
    const owed = invoice.totalCents - invoice.paidCents;
    if (owed <= 0) continue;
    const daysLate = Math.floor((new Date(today).getTime() - new Date(invoice.dueDate).getTime()) / DAY_MS);
    const money = formatMoney(owed, invoice.currency);
    const partial = invoice.paidCents > 0;
    drafts.push({
      type: "invoice_overdue",
      dedupeKey: `invoice_overdue:${invoice.id}:${invoice.dueDate}`,
      title: `Invoice ${invoice.number} is ${days(daysLate)} overdue, ${money} ${partial ? "still owed after a partial payment" : "unpaid"}`,
      orderId: null,
      subject: { kind: "invoice", id: invoice.id },
      atRiskCents: owed,
      currency: invoice.currency,
      deadline: null,
      evidence: {
        summary: `Invoice ${invoice.number} (${invoice.id}) to ${invoice.recipient} was due ${invoice.dueDate}. Status ${invoice.status}, ${formatMoney(
          invoice.paidCents,
          invoice.currency,
        )} of ${formatMoney(invoice.totalCents, invoice.currency)} paid.${
          invoice.lastReminderAt ? ` Last reminder: ${invoice.lastReminderAt}.` : " No reminder sent yet."
        }`,
        facts: {
          invoice_id: invoice.id,
          invoice_number: invoice.number,
          status: invoice.status,
          recipient: invoice.recipient,
          due_date: invoice.dueDate,
          days_overdue: daysLate,
          total: formatMoney(invoice.totalCents, invoice.currency),
          paid: formatMoney(invoice.paidCents, invoice.currency),
          owed: money,
          last_reminder_at: invoice.lastReminderAt,
        },
        refs: [{ kind: "invoice", id: invoice.id }],
      },
    });
  }
  return drafts;
}

export function detectDisputeDeadlines(ledger: Ledger, now: Date): IncidentDraft[] {
  const drafts: IncidentDraft[] = [];
  for (const dispute of ledger.disputes) {
    if (!OPEN_DISPUTE_STATUSES.has(dispute.status) || !dispute.responseDueAt) continue;
    const msLeft = new Date(dispute.responseDueAt).getTime() - now.getTime();
    if (msLeft > DISPUTE_WARNING_DAYS * DAY_MS) continue;
    const money = formatMoney(dispute.amountCents, dispute.currency);
    drafts.push({
      type: "dispute_deadline",
      dedupeKey: `dispute_deadline:${dispute.id}`,
      title:
        msLeft > 0
          ? `Dispute over ${money} needs a response within ${days(Math.max(1, Math.ceil(msLeft / DAY_MS)))}`
          : `Dispute over ${money}: response deadline has passed`,
      orderId: null,
      subject: { kind: "dispute", id: dispute.id },
      atRiskCents: dispute.amountCents,
      currency: dispute.currency,
      deadline: dispute.responseDueAt,
      evidence: {
        summary: `Dispute ${dispute.id} (${dispute.reason}) is ${dispute.status}. Seller response due ${dispute.responseDueAt}. Missing it usually means losing the dispute.`,
        facts: {
          dispute_id: dispute.id,
          status: dispute.status,
          reason: dispute.reason,
          amount: money,
          response_due: dispute.responseDueAt,
          transactions: dispute.transactionIds.join(", "),
        },
        refs: [{ kind: "dispute", id: dispute.id }],
      },
    });
  }
  return drafts;
}
