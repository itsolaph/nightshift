import { describe, expect, it } from "vitest";
import {
  detectAuthorizationAging,
  detectCaptureFailures,
  detectDisputeDeadlines,
  detectDuplicateCharges,
  detectOverdueInvoices,
  detectRefundAnomalies,
  runDetectors,
} from "@/lib/detectors";
import { at, auth, capture, emptyLedger, invoice, isoAt, order, refund, settings } from "./fixtures";

describe("authorization aging", () => {
  it("is quiet for a fresh authorization on an unshipped order", () => {
    const ledger = { ...emptyLedger(), orders: [order()], authorizations: [auth()] };
    expect(detectAuthorizationAging(ledger, at(1), settings())).toEqual([]);
  });

  it("flags the honor period within the warning window, then after it lapses", () => {
    const ledger = { ...emptyLedger(), orders: [order()], authorizations: [auth()] };
    const soon = detectAuthorizationAging(ledger, at(2, 13), settings({ honorWarningHours: 12 }));
    expect(soon).toHaveLength(1);
    expect(soon[0].type).toBe("auth_honor_expired");
    expect(soon[0].evidence.facts.honor_period_lapsed).toBe(false);

    const lapsed = detectAuthorizationAging(ledger, at(5), settings());
    expect(lapsed[0].type).toBe("auth_honor_expired");
    expect(lapsed[0].evidence.facts.honor_period_lapsed).toBe(true);
    expect(lapsed[0].atRiskCents).toBe(4200);
    expect(lapsed[0].dedupeKey).toBe("auth_honor_expired:0VF52814937998046");
  });

  it("flags the 29-day expiry ahead of everything else", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order({ fulfillment: "shipped", shippedAt: isoAt(1) })],
      authorizations: [auth()],
    };
    const drafts = detectAuthorizationAging(ledger, at(27), settings({ expiryWarningDays: 3 }));
    expect(drafts.map((d) => d.type)).toEqual(["auth_expiring"]);
    expect(drafts[0].deadline).toBe(isoAt(29));
  });

  it("reports expiry as passed when the detector clock is beyond 29 days", () => {
    const ledger = { ...emptyLedger(), orders: [order()], authorizations: [auth()] };
    const [draft] = detectAuthorizationAging(ledger, at(30), settings());
    expect(draft.type).toBe("auth_expiring");
    expect(draft.evidence.facts.expired_by_detector_clock).toBe(true);
  });

  it("flags a shipped order whose authorization was never captured", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order({ fulfillment: "shipped", shippedAt: isoAt(0, 1) })],
      authorizations: [auth()],
    };
    expect(detectAuthorizationAging(ledger, at(0, 5), settings({ uncapturedAfterHours: 12 }))).toEqual([]);
    const [draft] = detectAuthorizationAging(ledger, at(0, 14), settings({ uncapturedAfterHours: 12 }));
    expect(draft.type).toBe("uncaptured_shipment");
    expect(draft.subject).toEqual({ kind: "authorization", id: "0VF52814937998046" });
  });

  it("ignores captured, voided, superseded and cancelled authorizations", () => {
    const base = { ...emptyLedger(), orders: [order({ fulfillment: "shipped", shippedAt: isoAt(0) })] };
    const captured = { ...base, authorizations: [auth()], captures: [capture({ authorizationId: "0VF52814937998046" })] };
    const voided = { ...base, authorizations: [auth({ status: "VOIDED" })] };
    const superseded = {
      ...base,
      authorizations: [auth(), auth({ id: "8AA831015G517922L", createdAt: isoAt(4), expiresAt: isoAt(29) })],
    };
    const cancelled = { ...emptyLedger(), orders: [order({ fulfillment: "cancelled" })], authorizations: [auth()] };
    for (const ledger of [captured, voided, cancelled]) {
      expect(detectAuthorizationAging(ledger, at(5), settings())).toEqual([]);
    }
    // Only the newer authorization is considered.
    const drafts = detectAuthorizationAging(superseded, at(5), settings());
    expect(drafts.every((d) => d.subject?.id === "8AA831015G517922L")).toBe(true);
  });

  it("leaves authorizations with a failed capture attempt to the capture detector", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order({ fulfillment: "shipped", shippedAt: isoAt(0) })],
      authorizations: [auth()],
      captureAttempts: [
        {
          id: "att_1",
          orderId: "5O190127TN364715T",
          authorizationId: "0VF52814937998046",
          at: isoAt(0, 2),
          ok: false,
          httpStatus: 422,
          errorName: "UNPROCESSABLE_ENTITY",
          errorIssue: "INSTRUMENT_DECLINED",
          debugId: "f00",
          source: "shop" as const,
        },
      ],
    };
    expect(detectAuthorizationAging(ledger, at(1), settings())).toEqual([]);
    const [draft] = detectCaptureFailures(ledger, at(1));
    expect(draft.type).toBe("capture_failed");
    expect(draft.evidence.facts.last_error_issue).toBe("INSTRUMENT_DECLINED");
  });
});

describe("capture failures", () => {
  it("flags DECLINED captures and PENDING ones that are stuck", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order({ intent: "CAPTURE" })],
      captures: [
        capture({ id: "DECLINED00000001", status: "DECLINED" }),
        capture({ id: "PENDING000000001", status: "PENDING", createdAt: isoAt(0) }),
        capture({ id: "COMPLETED0000001", status: "COMPLETED" }),
      ],
    };
    expect(detectCaptureFailures(ledger, at(1)).map((d) => d.subject?.id)).toEqual(["DECLINED00000001"]);
    expect(detectCaptureFailures(ledger, at(4)).map((d) => d.subject?.id)).toEqual([
      "DECLINED00000001",
      "PENDING000000001",
    ]);
  });

  it("forgets a failed attempt once the authorization is captured", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order()],
      authorizations: [auth({ status: "CAPTURED" })],
      captures: [capture({ authorizationId: "0VF52814937998046" })],
      captureAttempts: [
        {
          id: "att_1",
          orderId: "5O190127TN364715T",
          authorizationId: "0VF52814937998046",
          at: isoAt(0),
          ok: false,
          httpStatus: 422,
          errorName: "UNPROCESSABLE_ENTITY",
          errorIssue: "INSTRUMENT_DECLINED",
          debugId: null,
          source: "shop" as const,
        },
      ],
    };
    expect(detectCaptureFailures(ledger, at(1))).toEqual([]);
  });
});

describe("duplicate charges", () => {
  const twoOrders = (gapMinutes: number, cartB = "cart-1001", payerB = "buyer@example.com") => ({
    ...emptyLedger(),
    orders: [
      order({ id: "ORDERA0000000001", intent: "CAPTURE" }),
      order({ id: "ORDERB0000000001", intent: "CAPTURE", cartRef: cartB, payer: payerB }),
    ],
    captures: [
      capture({ id: "CAPA000000000001", orderId: "ORDERA0000000001", createdAt: isoAt(0) }),
      capture({ id: "CAPB000000000001", orderId: "ORDERB0000000001", createdAt: isoAt(0, gapMinutes / 60) }),
    ],
  });

  it("flags the second charge for the same payer, cart and amount inside the window", () => {
    const [draft] = detectDuplicateCharges(twoOrders(2), at(1), settings());
    expect(draft.type).toBe("duplicate_charge");
    expect(draft.subject?.id).toBe("CAPB000000000001");
    expect(draft.evidence.facts.first_capture_id).toBe("CAPA000000000001");
    expect(draft.atRiskCents).toBe(4200);
  });

  it("ignores charges outside the window, different carts or different payers", () => {
    expect(detectDuplicateCharges(twoOrders(90), at(1), settings({ duplicateWindowMinutes: 30 }))).toEqual([]);
    expect(detectDuplicateCharges(twoOrders(2, "cart-2002"), at(1), settings())).toEqual([]);
    expect(detectDuplicateCharges(twoOrders(2, "cart-1001", "other@example.com"), at(1), settings())).toEqual([]);
  });

  it("stops flagging once the duplicate is fully refunded", () => {
    const ledger = twoOrders(2);
    ledger.refunds = [refund({ captureId: "CAPB000000000001", orderId: "ORDERB0000000001", amountCents: 4200 })];
    expect(detectDuplicateCharges(ledger, at(1), settings())).toEqual([]);
  });
});

describe("refund anomalies", () => {
  it("flags the same amount refunded twice on one capture", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order({ intent: "CAPTURE" })],
      captures: [capture()],
      refunds: [
        refund({ id: "REF0000000000001", createdAt: isoAt(0, 1) }),
        refund({ id: "REF0000000000002", createdAt: isoAt(0, 1.01) }),
      ],
    };
    const drafts = detectRefundAnomalies(ledger, at(1), settings());
    expect(drafts.map((d) => d.type)).toEqual(["duplicate_refund"]);
    expect(drafts[0].subject?.id).toBe("REF0000000000002");
  });

  it("flags refunds that add up to more than the order captured", () => {
    const ledger = {
      ...emptyLedger(),
      orders: [order({ intent: "CAPTURE" })],
      captures: [capture({ amountCents: 4200 })],
      refunds: [
        refund({ id: "REF0000000000001", amountCents: 3000, createdAt: isoAt(0, 1) }),
        refund({ id: "REF0000000000002", captureId: "OTHERCAPTURE0001", amountCents: 2000, createdAt: isoAt(0, 5) }),
      ],
    };
    const drafts = detectRefundAnomalies(ledger, at(1), settings());
    const over = drafts.find((d) => d.type === "refund_exceeds_capture");
    expect(over?.atRiskCents).toBe(800);
  });

  it("flags a refund spike relative to captures in the same 24 hours", () => {
    const captures = Array.from({ length: 5 }, (_, i) =>
      capture({ id: `CAP${i}000000000000`, orderId: `ORD${i}`, createdAt: isoAt(0, i) }),
    );
    const refunds = [0, 1, 2].map((i) =>
      refund({ id: `REF${i}000000000000`, captureId: `CAP${i}000000000000`, orderId: `ORD${i}`, createdAt: isoAt(0, 6 + i) }),
    );
    const ledger = { ...emptyLedger(), captures, refunds };
    const spike = detectRefundAnomalies(ledger, at(30), settings({ refundSpikeRate: 0.5, refundSpikeMinCount: 3 }));
    expect(spike.map((d) => d.type)).toEqual(["refund_spike"]);
    expect(spike[0].evidence.facts.refund_rate).toBe(0.6);
    expect(detectRefundAnomalies(ledger, at(30), settings({ refundSpikeRate: 0.7 }))).toEqual([]);
  });
});

describe("overdue invoices and disputes", () => {
  it("flags sent and partially paid invoices past their due date", () => {
    const ledger = {
      ...emptyLedger(),
      invoices: [
        invoice(),
        invoice({ id: "INV2-PART", number: "NS-0002", status: "PARTIALLY_PAID", paidCents: 8000 }),
        invoice({ id: "INV2-PAID", number: "NS-0003", status: "PAID", paidCents: 18000 }),
        invoice({ id: "INV2-DRAFT", number: "NS-0004", status: "DRAFT" }),
      ],
    };
    expect(detectOverdueInvoices(ledger, new Date("2026-10-15T20:00:00Z"), settings())).toEqual([]);
    const drafts = detectOverdueInvoices(ledger, new Date("2026-10-20T08:00:00Z"), settings());
    expect(drafts.map((d) => d.subject?.id)).toEqual(["INV2-Z56S-5LLA-Q52L-CPZ5", "INV2-PART"]);
    expect(drafts[1].atRiskCents).toBe(10000);
    expect(drafts[0].evidence.facts.days_overdue).toBe(5);
  });

  it("flags disputes whose seller response is due within 3 days", () => {
    const ledger = {
      ...emptyLedger(),
      disputes: [
        {
          id: "PP-D-12345",
          status: "WAITING_FOR_SELLER_RESPONSE",
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          amountCents: 4200,
          currency: "USD",
          responseDueAt: isoAt(10),
          transactionIds: ["2GG279541U471931P"],
          updatedAt: isoAt(0),
        },
      ],
    };
    expect(detectDisputeDeadlines(ledger, at(1))).toEqual([]);
    expect(detectDisputeDeadlines(ledger, at(8))[0].type).toBe("dispute_deadline");
  });
});

describe("runDetectors", () => {
  it("produces stable dedupe keys across runs", () => {
    const ledger = { ...emptyLedger(), orders: [order()], authorizations: [auth()], invoices: [invoice()] };
    const a = runDetectors(ledger, at(20), settings()).map((d) => d.dedupeKey);
    const b = runDetectors(ledger, at(20), settings()).map((d) => d.dedupeKey);
    expect(a).toEqual(b);
    expect(a.length).toBe(2);
  });
});
