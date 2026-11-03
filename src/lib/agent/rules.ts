// Rule-based triage, used when no LLM key is configured or the LLM call fails. Same output shape
// as the agent (diagnosis + proposals) and the same policy gate afterwards, so the app behaves the
// same minus the reasoning. The UI labels these diagnoses "Rule-based".

import type { Incident, ProposedAction } from "../domain";
import { formatMoney } from "../money";

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export type Triage = { diagnosis: string; confidence: "high" | "medium" | "low"; proposals: ProposedAction[] };

export function ruleBasedTriage(incident: Incident): Triage {
  const money = formatMoney(incident.atRiskCents, incident.currency);
  const f = incident.evidence.facts;
  const subjectId = incident.subject?.id ?? null;

  switch (incident.type) {
    case "uncaptured_shipment":
      return {
        diagnosis: `The order shipped but the ${money} authorization was never captured, so the money is still sitting with the buyer's bank. Capturing now collects it; waiting risks the authorization lapsing.`,
        confidence: "high",
        proposals: [
          {
            type: "capture_authorization",
            targetId: subjectId,
            amountCents: incident.atRiskCents,
            rationale: "The order shipped and the amount matches the authorization.",
          },
        ],
      };

    case "auth_honor_expired":
      return {
        diagnosis: `The order has not shipped and the 3-day honor period on the ${money} authorization is over, so PayPal no longer guarantees the funds. A reauthorization starts a new 3-day honor period.`,
        confidence: "medium",
        proposals: [
          {
            type: "reauthorize_authorization",
            targetId: subjectId,
            amountCents: null,
            rationale: "Reauthorizing keeps the funds guaranteed until the order ships.",
          },
        ],
      };

    case "auth_expiring": {
      const shipped = f.fulfillment === "shipped";
      if (shipped) {
        return {
          diagnosis: `The ${money} authorization reaches PayPal's 29-day limit soon and cannot be reauthorized after that. The order already shipped, so capturing now is the only way to collect.`,
          confidence: "high",
          proposals: [
            { type: "capture_authorization", targetId: subjectId, amountCents: null, rationale: "Shipped order, authorization about to expire." },
          ],
        };
      }
      return {
        diagnosis: `The ${money} authorization reaches PayPal's 29-day limit soon and the order still has not shipped. Reauthorizing does not extend the 29 days. The owner has to choose: ship and capture before ${String(f.expires_at ?? "the deadline").slice(0, 10)}, or void it and ask the buyer to pay again.`,
        confidence: "medium",
        proposals: [
          {
            type: "ask_owner",
            note: `Order ${incident.orderId} has not shipped and its ${money} authorization expires ${String(f.expires_at ?? "").slice(0, 10)}. Ship and capture before then, or void and re-request payment?`,
            rationale: "Only a person knows whether the goods can ship in time.",
          },
        ],
      };
    }

    case "capture_failed":
      return {
        diagnosis: `PayPal did not collect ${money} for order ${incident.orderId}: ${f.last_error_issue ?? f.capture_status ?? "the capture failed"}. ${
          f.fulfillment === "shipped" ? "The goods already shipped, so this money is owed but not collected." : ""
        } Retrying a decline without talking to the buyer usually fails again.`.replace(/\s+/g, " "),
        confidence: "medium",
        proposals: [
          {
            type: "ask_owner",
            note: `PayPal declined the ${money} capture on order ${incident.orderId}. Contact the buyer for another payment method, or retry the capture once?`,
            rationale: "A declined capture needs the buyer, not another automatic retry.",
          },
        ],
      };

    case "duplicate_charge":
      return {
        diagnosis: `The same buyer paid ${money} twice for the same cart within seconds, which looks like a double click or a retry bug. Refunding the second charge now is cheaper than a dispute later.`,
        confidence: "high",
        proposals: [
          {
            type: "refund_capture",
            targetId: subjectId,
            amountCents: incident.atRiskCents,
            note: "Refund of a duplicate charge. Sorry for the trouble.",
            rationale: "Second identical charge for the same cart.",
          },
        ],
      };

    case "duplicate_refund":
      return {
        diagnosis: `The same ${money} refund was issued twice on one capture, seconds apart. A refund cannot be reversed through the API, so the owner should contact the buyer and fix whatever retried the refund.`,
        confidence: "high",
        proposals: [
          {
            type: "ask_owner",
            note: `Refund ${subjectId} duplicated an earlier ${money} refund. Ask the buyer to return it, or write it off?`,
            rationale: "Recovering a refund needs a conversation with the buyer.",
          },
        ],
      };

    case "refund_exceeds_capture":
      return {
        diagnosis: `Refunds on order ${incident.orderId} add up to ${money} more than was captured. Something outside Nightshift is refunding without checking totals.`,
        confidence: "medium",
        proposals: [{ type: "ask_owner", note: `Refunds exceed captures by ${money} on order ${incident.orderId}. Investigate?`, rationale: "Needs a human." }],
      };

    case "refund_spike":
      return {
        diagnosis: `${f.refunds} refunds (${money}) in 24 hours, ${Math.round(Number(f.refund_rate) * 100)}% of captures. That usually means a bad batch or a listing problem rather than individual buyers.`,
        confidence: "medium",
        proposals: [
          { type: "ask_owner", note: `Refunds spiked to ${Math.round(Number(f.refund_rate) * 100)}% of captures. Check the latest batch?`, rationale: "A spike points at a product or fulfilment problem." },
        ],
      };

    case "invoice_overdue":
      return {
        diagnosis: `Invoice ${f.invoice_number} is ${days(Number(f.days_overdue))} past due with ${money} still owed${
          f.last_reminder_at ? "" : " and no reminder sent yet"
        }. A polite reminder through PayPal is the usual first step.`,
        confidence: "high",
        proposals: [{ type: "send_invoice_reminder", targetId: subjectId, rationale: "Overdue and not reminded recently." }],
      };

    case "dispute_deadline":
      return {
        diagnosis: `A buyer disputed ${money} (${f.reason}) and the seller response is due ${String(f.response_due ?? "").slice(0, 10)}. If nobody responds, PayPal closes it in the buyer's favour.`,
        confidence: "high",
        proposals: [{ type: "ask_owner", note: `Respond to dispute ${subjectId} before ${String(f.response_due ?? "").slice(0, 10)}: accept, or send tracking/proof?`, rationale: "Dispute evidence comes from the owner." }],
      };
  }
  return { diagnosis: "No rule for this incident type.", confidence: "low", proposals: [{ type: "ask_owner", rationale: "Unknown type." }] };
}
