// Table-driven tests for the policy gate: action type x amount x evidence -> decision.

import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/policy/gate";
import type { Incident, Ledger, PolicyDecision, ProposedAction, Settings } from "@/lib/domain";
import { at, auth, capture, emptyLedger, incidentFrom, invoice, isoAt, order, refund, settings } from "./fixtures";

const AUTH = "0VF52814937998046";
const CAP = "2GG279541U471931P";
const INV = "INV2-Z56S-5LLA-Q52L-CPZ5";

type Evidence = { name: string; ledger: Ledger; incident: Incident; settings?: Settings; now?: Date };

const shippedAuth = (): Evidence => ({
  name: "shipped order, open authorization",
  ledger: {
    ...emptyLedger(),
    orders: [order({ fulfillment: "shipped", shippedAt: isoAt(0, 1) })],
    authorizations: [auth()],
  },
  incident: incidentFrom({
    type: "uncaptured_shipment",
    dedupeKey: "k",
    title: "t",
    orderId: "5O190127TN364715T",
    subject: { kind: "authorization", id: AUTH },
    atRiskCents: 4200,
    currency: "USD",
    deadline: null,
    evidence: { summary: "", facts: {}, refs: [] },
  }),
});

const unshippedAuth = (): Evidence => ({
  ...shippedAuth(),
  name: "unshipped order, open authorization",
  ledger: { ...emptyLedger(), orders: [order()], authorizations: [auth()] },
});

const declinedBefore = (): Evidence => {
  const e = shippedAuth();
  e.name = "shipped order, a capture attempt was declined";
  e.ledger.captureAttempts = [
    {
      id: "att",
      orderId: "5O190127TN364715T",
      authorizationId: AUTH,
      at: isoAt(0, 2),
      ok: false,
      httpStatus: 422,
      errorName: "UNPROCESSABLE_ENTITY",
      errorIssue: "INSTRUMENT_DECLINED",
      debugId: null,
      source: "shop",
    },
  ];
  return e;
};

const bigOrder = (): Evidence => {
  const e = shippedAuth();
  e.name = "shipped order above the auto-capture limit";
  e.ledger.orders[0].amountCents = 90_000;
  e.ledger.authorizations[0].amountCents = 90_000;
  e.incident.atRiskCents = 90_000;
  return e;
};

const capturedOrder = (): Evidence => ({
  name: "captured order with a partial refund",
  ledger: {
    ...emptyLedger(),
    orders: [order({ intent: "CAPTURE", fulfillment: "shipped" })],
    captures: [capture({ amountCents: 4200, status: "PARTIALLY_REFUNDED" })],
    refunds: [refund({ amountCents: 1000 })],
  },
  incident: incidentFrom({
    type: "duplicate_charge",
    dedupeKey: "k",
    title: "t",
    orderId: "5O190127TN364715T",
    subject: { kind: "capture", id: CAP },
    atRiskCents: 3200,
    currency: "USD",
    deadline: null,
    evidence: { summary: "", facts: {}, refs: [] },
  }),
});

const overdueInvoice = (lastReminderAt: string | null = null): Evidence => ({
  name: lastReminderAt ? "overdue invoice, reminded recently" : "overdue invoice",
  ledger: { ...emptyLedger(), invoices: [invoice({ lastReminderAt })] },
  incident: incidentFrom({
    type: "invoice_overdue",
    dedupeKey: "k",
    title: "t",
    orderId: null,
    subject: { kind: "invoice", id: INV },
    atRiskCents: 18000,
    currency: "USD",
    deadline: null,
    evidence: { summary: "", facts: {}, refs: [] },
  }),
});

const paidInvoice = (): Evidence => {
  const e = overdueInvoice();
  e.name = "paid invoice";
  e.ledger.invoices[0].status = "PAID";
  return e;
};

type Row = [ProposedAction["type"], number | null, string | null, () => Evidence, PolicyDecision, RegExp?, Partial<Settings>?];

const p = (type: string, amountCents: number | null, targetId: string | null): ProposedAction => ({
  type,
  amountCents,
  targetId,
  rationale: "test",
});

// [action, amount, target, evidence, expected decision, reason pattern, settings]
const TABLE: Row[] = [
  // capture_authorization
  ["capture_authorization", 4200, AUTH, shippedAuth, "auto", /autopilot rules/],
  ["capture_authorization", null, AUTH, shippedAuth, "auto"],
  ["capture_authorization", 4200, AUTH, shippedAuth, "needs_approval", /Autopilot is off/, { autopilot: false }],
  ["capture_authorization", 4200, AUTH, unshippedAuth, "needs_approval", /not marked shipped/],
  ["capture_authorization", 4200, AUTH, declinedBefore, "needs_approval", /already rejected/],
  ["capture_authorization", 90_000, AUTH, bigOrder, "needs_approval", /auto-capture limit/],
  ["capture_authorization", 2000, AUTH, shippedAuth, "needs_approval", /differs from both/],
  ["capture_authorization", 4500, AUTH, shippedAuth, "needs_approval", /more than the/],
  ["capture_authorization", 9000, AUTH, shippedAuth, "forbidden", /above what the authorization allows/],
  ["capture_authorization", 4200, "UNKNOWNAUTH00001", shippedAuth, "forbidden", /not in Nightshift's ledger/],
  ["capture_authorization", 0, AUTH, shippedAuth, "forbidden", /positive whole number/],
  ["capture_authorization", -100, AUTH, shippedAuth, "forbidden", /positive whole number/],
  // reauthorize_authorization
  ["reauthorize_authorization", 4200, AUTH, unshippedAuth, "auto"],
  ["reauthorize_authorization", null, AUTH, unshippedAuth, "auto"],
  ["reauthorize_authorization", 4800, AUTH, unshippedAuth, "needs_approval", /more than the original/],
  ["reauthorize_authorization", 4900, AUTH, unshippedAuth, "forbidden", /115%/],
  ["reauthorize_authorization", 4200, "UNKNOWNAUTH00001", unshippedAuth, "forbidden"],
  // void_authorization
  ["void_authorization", null, AUTH, unshippedAuth, "needs_approval", /cannot be undone/],
  ["void_authorization", null, "UNKNOWNAUTH00001", unshippedAuth, "forbidden"],
  // refund_capture
  ["refund_capture", 3200, CAP, capturedOrder, "needs_approval", /owner approves every one/],
  ["refund_capture", null, CAP, capturedOrder, "needs_approval"],
  ["refund_capture", 3300, CAP, capturedOrder, "forbidden", /more than the/],
  ["refund_capture", 50_000, CAP, capturedOrder, "forbidden"],
  ["refund_capture", 1000, "UNKNOWNCAPTURE01", capturedOrder, "forbidden", /not in Nightshift's ledger/],
  // send_invoice_reminder
  ["send_invoice_reminder", null, INV, () => overdueInvoice(), "auto"],
  ["send_invoice_reminder", null, INV, () => overdueInvoice(new Date().toISOString()), "needs_approval", /cooldown/],
  ["send_invoice_reminder", null, INV, paidInvoice, "forbidden", /nothing to remind/],
  ["send_invoice_reminder", null, "INV2-NOPE", () => overdueInvoice(), "forbidden"],
  // mark_resolved and ask_owner
  ["mark_resolved", null, null, shippedAuth, "needs_approval", /still at risk/],
  ["ask_owner", null, null, shippedAuth, "needs_approval", /human decision/],
  // not on the allowlist
  ["delete_invoice", null, INV, () => overdueInvoice(), "forbidden", /allowlist/],
  ["create_payout", 100_000, null, shippedAuth, "forbidden", /allowlist/],
  ["pay_order", null, "5O190127TN364715T", shippedAuth, "forbidden", /allowlist/],
];

describe("policy gate", () => {
  it.each(TABLE)("%s %s on %s (%s) -> %s", (type, amount, target, evidence, expected, reason, patch) => {
    const e = evidence();
    const result = evaluate({
      proposal: p(type, amount, target),
      incident: e.incident,
      ledger: e.ledger,
      settings: settings(patch),
      now: e.now ?? at(1),
    });
    expect(result.decision).toBe(expected);
    if (reason) expect(result.reasons.join(" ")).toMatch(reason);
  });

  it("builds the exact PayPal call for a capture", () => {
    const e = shippedAuth();
    const result = evaluate({ proposal: p("capture_authorization", null, AUTH), incident: e.incident, ledger: e.ledger, settings: settings(), now: at(1) });
    expect(result.call).toEqual({
      method: "POST",
      path: `/v2/payments/authorizations/${AUTH}/capture`,
      body: { amount: { currency_code: "USD", value: "42.00" }, final_capture: true },
    });
  });

  it("forbids anything on an expired authorization", () => {
    const e = shippedAuth();
    const result = evaluate({ proposal: p("capture_authorization", 4200, AUTH), incident: e.incident, ledger: e.ledger, settings: settings(), now: at(30) });
    expect(result.decision).toBe("forbidden");
    expect(result.reasons[0]).toMatch(/expired/);
  });

  it("forbids actions on closed incidents", () => {
    const e = shippedAuth();
    e.incident.status = "resolved";
    const result = evaluate({ proposal: p("capture_authorization", 4200, AUTH), incident: e.incident, ledger: e.ledger, settings: settings(), now: at(1) });
    expect(result.decision).toBe("forbidden");
  });

  it("forbids a currency that does not match the ledger", () => {
    const e = shippedAuth();
    const result = evaluate({
      proposal: { ...p("capture_authorization", 4200, AUTH), currency: "EUR" },
      incident: e.incident,
      ledger: e.ledger,
      settings: settings(),
      now: at(1),
    });
    expect(result.decision).toBe("forbidden");
  });

  it("sends an auto capture to approval when it is more than the incident puts at risk", () => {
    const e = shippedAuth();
    e.incident.atRiskCents = 1000;
    const result = evaluate({ proposal: p("capture_authorization", 4200, AUTH), incident: e.incident, ledger: e.ledger, settings: settings(), now: at(1) });
    expect(result.decision).toBe("needs_approval");
    expect(result.reasons.join(" ")).toMatch(/more than the incident puts at risk/);
  });

  it("lets mark_resolved through once the ledger shows the money settled", () => {
    const e = shippedAuth();
    e.ledger.authorizations[0].status = "CAPTURED";
    const result = evaluate({ proposal: p("mark_resolved", null, null), incident: e.incident, ledger: e.ledger, settings: settings(), now: at(1) });
    expect(result.decision).toBe("auto");
  });
});
