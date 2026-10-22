// The policy gate. Plain code, no LLM. Every action the agent proposes passes through `evaluate`,
// which returns one of:
//
//   auto            safe to execute now without a human
//   needs_approval  goes to the owner's approvals inbox with the exact PayPal call it would make
//   forbidden       never executed; recorded in the audit trail with the reason
//
// The agent cannot reach a money-moving PayPal endpoint any other way: its tools are read-only,
// and the executor only runs actions that this gate (or an owner approval) has cleared.

import {
  ACTION_TYPES,
  type ActionType,
  type Incident,
  type Ledger,
  type PayPalCall,
  type PolicyDecision,
  type ProposedAction,
  type Settings,
} from "../domain";
import {
  expiresAt,
  honorEndsAt,
  OPEN_AUTH_STATUSES,
  refundedCents,
  uncapturedCents,
} from "../detectors/helpers";
import { REMINDABLE_INVOICE_STATUSES } from "../detectors/invoices";
import { formatMoney, paypalAmount } from "../money";
import { HOUR_MS } from "../clock";

/** PayPal (US): a reauthorization or over-capture may be up to 115% of the original, at most +$75. */
export const MAX_OVER_PERCENT = 0.15;
export const MAX_OVER_CENTS = 7_500;
const REFUNDABLE_CAPTURE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED"]);

export type GateInput = {
  proposal: ProposedAction;
  incident: Incident;
  ledger: Ledger;
  settings: Settings;
  /** Nightshift's detector clock (includes the demo offset). */
  now: Date;
};

export type GateResult = {
  decision: PolicyDecision;
  reasons: string[];
  /** The normalised action, with defaults filled from the ledger. */
  action: {
    type: string;
    targetId: string | null;
    amountCents: number | null;
    currency: string | null;
    note: string | null;
  };
  /** The exact PayPal call the executor would make; null for actions that don't call PayPal. */
  call: PayPalCall | null;
};

export const isActionType = (t: string): t is ActionType => (ACTION_TYPES as readonly string[]).includes(t);

const maxOver = (base: number) => Math.min(Math.round(base * (1 + MAX_OVER_PERCENT)), base + MAX_OVER_CENTS);

function forbidden(input: GateInput, reasons: string[]): GateResult {
  const p = input.proposal;
  return {
    decision: "forbidden",
    reasons,
    action: {
      type: p.type,
      targetId: p.targetId ?? null,
      amountCents: p.amountCents ?? null,
      currency: p.currency ?? null,
      note: p.note ?? null,
    },
    call: null,
  };
}

function validAmount(amount: number | null | undefined): amount is number {
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0;
}

export function evaluate(input: GateInput): GateResult {
  const { proposal, incident, ledger, settings, now } = input;
  const type = proposal.type;

  if (!isActionType(type)) return forbidden(input, [`"${type}" is not on the action allowlist.`]);
  if (incident.status === "resolved" || incident.status === "dismissed") {
    return forbidden(input, ["The incident is already closed."]);
  }
  if (proposal.amountCents !== undefined && proposal.amountCents !== null && !validAmount(proposal.amountCents)) {
    return forbidden(input, ["The amount must be a positive whole number of cents."]);
  }

  const result = evaluateByType(type, input);
  if (result.decision === "forbidden") return result;

  // Money-moving actions may not touch more than the incident's evidence puts at risk.
  const moves = ["capture_authorization", "reauthorize_authorization", "refund_capture"].includes(type);
  if (moves && result.decision === "auto" && (result.action.amountCents ?? 0) > incident.atRiskCents) {
    result.decision = "needs_approval";
    result.reasons.push(
      `The amount (${formatMoney(result.action.amountCents ?? 0, result.action.currency ?? incident.currency)}) is more than the incident puts at risk (${formatMoney(incident.atRiskCents, incident.currency)}).`,
    );
  }
  if (result.decision === "auto" && !settings.autopilot && type !== "mark_resolved") {
    result.decision = "needs_approval";
    result.reasons.push("Autopilot is off, so every action waits for the owner.");
  }
  if (result.decision === "auto") result.reasons.unshift("Within the autopilot rules.");
  void now;
  return result;
}

function evaluateByType(type: ActionType, input: GateInput): GateResult {
  const { proposal, incident, ledger, settings, now } = input;
  const reasons: string[] = [];
  const note = proposal.note?.slice(0, 255) ?? null;

  switch (type) {
    case "capture_authorization":
    case "reauthorize_authorization":
    case "void_authorization": {
      const auth = ledger.authorizations.find((a) => a.id === proposal.targetId);
      if (!auth) return forbidden(input, [`Authorization ${proposal.targetId ?? "(none)"} is not in Nightshift's ledger.`]);
      const order = ledger.orders.find((o) => o.id === auth.orderId);
      if (!order) return forbidden(input, [`Order ${auth.orderId} is not in Nightshift's ledger.`]);
      if (!OPEN_AUTH_STATUSES.has(auth.status)) {
        return forbidden(input, [`Authorization ${auth.id} is ${auth.status}; nothing left to ${type.split("_")[0]}.`]);
      }
      if (proposal.currency && proposal.currency !== auth.currency) {
        return forbidden(input, [`Currency ${proposal.currency} does not match the authorization (${auth.currency}).`]);
      }
      const remaining = uncapturedCents(ledger, auth);
      const expiry = expiresAt(auth);
      if (now >= expiry && type !== "void_authorization") {
        return forbidden(input, [`Authorization ${auth.id} expired on ${expiry.toISOString()} (detector clock); PayPal will not capture or reauthorize it.`]);
      }

      if (type === "void_authorization") {
        reasons.push("Voiding releases the buyer's funds and cannot be undone, so the owner decides.");
        return {
          decision: "needs_approval",
          reasons,
          action: { type, targetId: auth.id, amountCents: remaining, currency: auth.currency, note },
          call: { method: "POST", path: `/v2/payments/authorizations/${auth.id}/void` },
        };
      }

      if (type === "reauthorize_authorization") {
        const amount = proposal.amountCents ?? auth.amountCents;
        if (amount > maxOver(auth.amountCents)) {
          return forbidden(input, [
            `Reauthorizing ${formatMoney(amount, auth.currency)} is above PayPal's limit of 115% / +$75 on ${formatMoney(auth.amountCents, auth.currency)}.`,
          ]);
        }
        const call: PayPalCall = {
          method: "POST",
          path: `/v2/payments/authorizations/${auth.id}/reauthorize`,
          body: { amount: paypalAmount(amount, auth.currency) },
        };
        let decision: PolicyDecision = "auto";
        if (amount > auth.amountCents) {
          decision = "needs_approval";
          reasons.push(`Reauthorizing more than the original ${formatMoney(auth.amountCents, auth.currency)} asks the buyer for extra money.`);
        }
        if (now < honorEndsAt(auth)) {
          reasons.push("Note: the honor period has not ended yet by the detector clock; PayPal may answer REAUTHORIZE_TOO_SOON-style errors.");
        }
        return { decision, reasons, action: { type, targetId: auth.id, amountCents: amount, currency: auth.currency, note }, call };
      }

      // capture_authorization
      const amount = proposal.amountCents ?? remaining;
      if (amount > maxOver(remaining)) {
        return forbidden(input, [
          `Capturing ${formatMoney(amount, auth.currency)} is above what the authorization allows (${formatMoney(remaining, auth.currency)} uncaptured).`,
        ]);
      }
      const call: PayPalCall = {
        method: "POST",
        path: `/v2/payments/authorizations/${auth.id}/capture`,
        body: {
          amount: paypalAmount(amount, auth.currency),
          final_capture: amount >= remaining,
          ...(note ? { note_to_payer: note } : {}),
        },
      };
      let decision: PolicyDecision = "auto";
      if (amount > remaining) {
        decision = "needs_approval";
        reasons.push(`Capturing more than the ${formatMoney(remaining, auth.currency)} still authorized.`);
      }
      if (order.fulfillment !== "shipped") {
        decision = "needs_approval";
        reasons.push("The order is not marked shipped; charging before shipping is the owner's call.");
      }
      if (amount !== order.amountCents && amount !== remaining) {
        decision = "needs_approval";
        reasons.push(`The amount differs from both the order total (${formatMoney(order.amountCents, order.currency)}) and the uncaptured balance.`);
      }
      if (amount > settings.autoCaptureMaxCents) {
        decision = "needs_approval";
        reasons.push(`Above the auto-capture limit of ${formatMoney(settings.autoCaptureMaxCents, auth.currency)}.`);
      }
      const failed = ledger.captureAttempts.filter((a) => a.authorizationId === auth.id && !a.ok);
      if (failed.length > 0) {
        decision = "needs_approval";
        reasons.push(`PayPal already rejected ${failed.length} capture attempt(s) on this authorization; retrying a decline is the owner's call.`);
      }
      return { decision, reasons, action: { type, targetId: auth.id, amountCents: amount, currency: auth.currency, note }, call };
    }

    case "refund_capture": {
      const capture = ledger.captures.find((c) => c.id === proposal.targetId);
      if (!capture) return forbidden(input, [`Capture ${proposal.targetId ?? "(none)"} is not in Nightshift's ledger.`]);
      if (!ledger.orders.some((o) => o.id === capture.orderId)) {
        return forbidden(input, [`Order ${capture.orderId} is not in Nightshift's ledger.`]);
      }
      if (!REFUNDABLE_CAPTURE_STATUSES.has(capture.status)) {
        return forbidden(input, [`Capture ${capture.id} is ${capture.status}; it cannot be refunded.`]);
      }
      if (proposal.currency && proposal.currency !== capture.currency) {
        return forbidden(input, [`Currency ${proposal.currency} does not match the capture (${capture.currency}).`]);
      }
      const refundable = capture.amountCents - refundedCents(ledger, capture.id);
      const amount = proposal.amountCents ?? refundable;
      if (amount > refundable) {
        return forbidden(input, [
          `Refunding ${formatMoney(amount, capture.currency)} is more than the ${formatMoney(refundable, capture.currency)} left on capture ${capture.id}.`,
        ]);
      }
      reasons.push("Refunds send money back to the buyer and cannot be reversed, so the owner approves every one.");
      return {
        decision: "needs_approval",
        reasons,
        action: { type, targetId: capture.id, amountCents: amount, currency: capture.currency, note },
        call: {
          method: "POST",
          path: `/v2/payments/captures/${capture.id}/refund`,
          body: { amount: paypalAmount(amount, capture.currency), ...(note ? { note_to_payer: note } : {}) },
        },
      };
    }

    case "send_invoice_reminder": {
      const invoice = ledger.invoices.find((i) => i.id === proposal.targetId);
      if (!invoice) return forbidden(input, [`Invoice ${proposal.targetId ?? "(none)"} is not in Nightshift's ledger.`]);
      if (!REMINDABLE_INVOICE_STATUSES.has(invoice.status)) {
        return forbidden(input, [`Invoice ${invoice.number} is ${invoice.status}; there is nothing to remind about.`]);
      }
      let decision: PolicyDecision = "auto";
      if (invoice.lastReminderAt) {
        const hours = (Date.now() - new Date(invoice.lastReminderAt).getTime()) / HOUR_MS;
        if (hours < settings.invoiceReminderCooldownHours) {
          decision = "needs_approval";
          reasons.push(`A reminder already went out ${Math.round(hours)}h ago (cooldown ${settings.invoiceReminderCooldownHours}h).`);
        }
      }
      const subject = `Reminder: invoice ${invoice.number} is past due`;
      return {
        decision,
        reasons,
        action: { type, targetId: invoice.id, amountCents: null, currency: invoice.currency, note },
        call: {
          method: "POST",
          path: `/v2/invoicing/invoices/${invoice.id}/remind`,
          body: {
            subject,
            note:
              note ??
              `A friendly reminder that ${formatMoney(invoice.totalCents - invoice.paidCents, invoice.currency)} on invoice ${invoice.number} was due ${invoice.dueDate}.`,
            send_to_invoicer: false,
            send_to_recipient: true,
          },
        },
      };
    }

    case "mark_resolved": {
      const settled = subjectSettled(incident, ledger);
      if (incident.atRiskCents > 0 && !settled) {
        reasons.push(
          `${formatMoney(incident.atRiskCents, incident.currency)} is still at risk according to the ledger, so closing the incident needs the owner.`,
        );
        return { decision: "needs_approval", reasons, action: { type, targetId: null, amountCents: null, currency: null, note }, call: null };
      }
      reasons.push(settled ? "The ledger shows the money is settled." : "No money at risk.");
      return { decision: "auto", reasons, action: { type, targetId: null, amountCents: null, currency: null, note }, call: null };
    }

    case "ask_owner":
      reasons.push("The agent asked for a human decision.");
      return {
        decision: "needs_approval",
        reasons,
        action: { type, targetId: proposal.targetId ?? null, amountCents: null, currency: null, note },
        call: null,
      };
  }
}

/** True when the ledger shows the incident's subject no longer needs attention. */
export function subjectSettled(incident: Incident, ledger: Ledger): boolean {
  const subject = incident.subject;
  if (!subject) return false;
  switch (subject.kind) {
    case "authorization": {
      const auth = ledger.authorizations.find((a) => a.id === subject.id);
      if (!auth) return false;
      return !OPEN_AUTH_STATUSES.has(auth.status) || uncapturedCents(ledger, auth) === 0;
    }
    case "capture": {
      const capture = ledger.captures.find((c) => c.id === subject.id);
      if (!capture) return false;
      if (incident.type === "duplicate_charge") return refundedCents(ledger, capture.id) >= capture.amountCents;
      return capture.status === "COMPLETED";
    }
    case "invoice": {
      const invoice = ledger.invoices.find((i) => i.id === subject.id);
      return Boolean(invoice && ["PAID", "MARKED_AS_PAID", "CANCELLED"].includes(invoice.status));
    }
    default:
      return false;
  }
}
