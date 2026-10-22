// Regressions for what the live sandbox check found (docs/PAYPAL-NOTES.md): mixed timestamp
// formats, empty error bodies, the remind response, the buyer helpers and the lab config.

import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { Store } from "@/lib/db";
import { detectRefundAnomalies } from "@/lib/detectors/refunds";
import { DEFAULT_SETTINGS } from "@/lib/domain";
import { ingestOrder, ingestRefund, recordCaptureAttempt, utcTime } from "@/lib/ledger";
import { describeError, PayPalClient } from "@/lib/paypal/client";
import { approveLink, luhnCheckDigit, newSandboxBuyer, testCardNumber, waitForApproval } from "@/lib/sandbox-buyer";
import { FakePayPal } from "./fake-paypal";

const luhnValid = (n: string) => luhnCheckDigit(n.slice(0, -1)) === Number(n.at(-1));

describe("timestamps", () => {
  it("normalises PayPal's offset timestamps to UTC", () => {
    expect(utcTime("2026-10-22T02:30:46-07:00")).toBe("2026-10-22T09:30:46.000Z");
    expect(utcTime("2026-10-22T09:30:44Z")).toBe("2026-10-22T09:30:44.000Z");
    expect(utcTime(undefined)).toBeUndefined();
    expect(utcTime("not a date")).toBe("not a date");
  });

  it("orders refunds by real time when PayPal mixes formats", () => {
    const store = new Store(":memory:");
    ingestOrder(store, {
      id: "ORDER1",
      intent: "CAPTURE",
      status: "COMPLETED",
      create_time: "2026-10-22T09:30:40Z",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "80.00" },
          payments: { captures: [{ id: "CAP1", status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "80.00" }, create_time: "2026-10-22T09:30:44Z" }] },
        },
      ],
    });
    // String order would put "02:30:50-07:00" before "09:30:46Z"; real order is the other way round.
    ingestRefund(store, { id: "REF1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" }, create_time: "2026-10-22T09:30:46Z" }, "ORDER1", "CAP1");
    ingestRefund(store, { id: "REF2", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" }, create_time: "2026-10-22T02:30:50-07:00" }, "ORDER1", "CAP1");
    const [draft] = detectRefundAnomalies(store.ledger(), new Date("2026-10-22T10:00:00Z"), DEFAULT_SETTINGS).filter((d) => d.type === "duplicate_refund");
    expect(draft.subject).toEqual({ kind: "refund", id: "REF2" });
    expect(draft.evidence.facts.seconds_apart).toBe(4);
  });
});

describe("PayPal client", () => {
  it("describes an empty error body instead of 'Unknown error'", () => {
    expect(describeError(null).message).toBe("PayPal sent no error body");
    expect(describeError({}).message).toBe("Unknown error");
  });

  it("records a bare 403 from an unsupported mock code as a failed capture attempt", async () => {
    const fake = new FakePayPal();
    const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
    const order = await client.createOrder({ intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }], payment_source: { card: { number: "4012888888881881", expiry: "2030-12" } } });
    const auth = order.body.purchase_units![0].payments!.authorizations![0];
    const result = await client.captureAuthorization(auth.id, {}, { mockCode: "INSTRUMENT_DECLINED" });
    expect(result.status).toBe(403);
    expect(result.body).toBeNull();
    const store = new Store(":memory:");
    const attempt = recordCaptureAttempt(store, { orderId: order.body.id, authorizationId: auth.id, result, source: "shop" });
    expect(attempt).toMatchObject({ ok: false, httpStatus: 403, errorName: null, errorIssue: null });
  });

  it("sends a JSON body when asking for the next invoice number (the sandbox answers 415 without one)", async () => {
    const fake = new FakePayPal();
    const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
    await client.generateInvoiceNumber();
    const call = fake.requests.find((r) => r.path === "/v2/invoicing/generate-next-invoice-number")!;
    expect(call.headers["content-type"]).toContain("application/json");
    expect(call.body).toEqual({});
  });
});

describe("sandbox buyer", () => {
  it("generates Luhn-valid test cards with PayPal's generator prefix", () => {
    for (let i = 0; i < 50; i++) {
      const card = testCardNumber();
      expect(card).toMatch(/^4032\d{12}$/);
      expect(luhnValid(card)).toBe(true);
    }
    expect(luhnValid("4012888888881881")).toBe(true);
    expect(luhnValid("4012888888881882")).toBe(false);
  });

  it("makes a fresh buyer with a reserved example.com address", () => {
    const a = newSandboxBuyer("Buyer C!");
    expect(a.email).toMatch(/@example\.com$/);
    expect(a.lastName).toBe("Buyer C");
    expect(newSandboxBuyer().email).not.toBe(a.email);
  });

  it("finds the approve link under either rel PayPal uses", () => {
    expect(approveLink({ links: [{ rel: "self", href: "a" }, { rel: "payer-action", href: "b" }] })).toBe("b");
    expect(approveLink({ links: [{ rel: "approve", href: "c" }] })).toBe("c");
    expect(approveLink({})).toBeNull();
  });

  it("waits for PayPal to report the order APPROVED, and gives up after the timeout", async () => {
    const fake = new FakePayPal();
    const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
    const order = await client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }], payment_source: { paypal: {} } });
    expect(order.body.status).toBe("PAYER_ACTION_REQUIRED");
    let polls = 0;
    const approved = await waitForApproval(client, order.body.id, {
      timeoutMs: 60_000,
      sleep: async () => {
        if (++polls === 2) fake.approve(order.body.id, "buyer@example.com");
      },
    });
    expect(approved.approved).toBe(true);
    const other = await client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }], payment_source: { paypal: {} } });
    const timedOut = await waitForApproval(client, other.body.id, { timeoutMs: 0, sleep: async () => {} });
    expect(timedOut).toEqual({ approved: false, detail: `order ${other.body.id} still PAYER_ACTION_REQUIRED after waiting` });
  });
});

describe("lab config", () => {
  it("defaults to auto and ignores unknown values", () => {
    const base = { PAYPAL_ENV: "sandbox" };
    expect(loadConfig(base).lab).toEqual({ paymentSource: "auto", buyerApproval: "auto", chromiumPath: "", approvalTimeoutMs: 600_000 });
    const lab = loadConfig({ ...base, LAB_PAYMENT_SOURCE: "PayPal", LAB_BUYER_APPROVAL: "manual", LAB_APPROVAL_TIMEOUT_SECONDS: "90" }).lab;
    expect(lab).toMatchObject({ paymentSource: "paypal", buyerApproval: "manual", approvalTimeoutMs: 90_000 });
    expect(loadConfig({ ...base, LAB_PAYMENT_SOURCE: "bitcoin" }).lab.paymentSource).toBe("auto");
  });
});
