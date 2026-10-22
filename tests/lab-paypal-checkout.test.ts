// "Run the night" on a sandbox app without card processing, the situation found in the live
// sandbox check: card orders get 422 PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING, so the lab switches to
// PayPal-checkout orders that a sandbox buyer approves. Here the buyer is the fake's approve().

import { beforeAll, describe, expect, it } from "vitest";
import { Store, setStore } from "@/lib/db";
import { PayPalClient, setPayPalClient } from "@/lib/paypal/client";
import { runTheNight, type ScenarioOutcome } from "@/lib/scenarios";
import type { BuyerApprover, SandboxBuyer } from "@/lib/sandbox-buyer";
import { FakePayPal } from "./fake-paypal";

const fake = new FakePayPal();
fake.cardProcessing = false;
const store = new Store(":memory:");
const client = new PayPalClient({ clientId: "test-id", clientSecret: "test-secret", fetch: fake.fetch, sleep: async () => {} });

const approvals: { orderId: string; url: string; buyer: SandboxBuyer }[] = [];
const approver: BuyerApprover = {
  kind: "test",
  returnUrl: "https://example.com/nightshift-lab/approved",
  cancelUrl: "https://example.com/nightshift-lab/cancelled",
  async approve(order, buyer) {
    approvals.push({ orderId: order.id, url: order.approveUrl, buyer });
    return fake.approve(order.id, buyer.email) ? { approved: true, detail: "approved" } : { approved: false, detail: "not approvable" };
  },
  async close() {},
};

let outcome: Record<string, ScenarioOutcome>;

beforeAll(async () => {
  delete process.env.LLM_API_KEY;
  setStore(store);
  setPayPalClient(client);
  outcome = await runTheNight(store, client, "night_paypal", { approver });
}, 30_000);

const byType = (type: string) => store.listIncidents().filter((i) => i.type === type);

describe("run the night without card processing (PayPal checkout)", () => {
  it("tries a card once, then switches to PayPal checkout for every order", () => {
    const cardCalls = fake.requests.filter((r) => (r.body as { payment_source?: { card?: unknown } } | undefined)?.payment_source?.card);
    expect(cardCalls).toHaveLength(1);
    expect(store.getKv("lab:cardsRefused")).toBe(true);
    const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/v2/checkout/orders" && (r.body as { payment_source?: { paypal?: unknown } }).payment_source?.paypal);
    // 8 orders: one per order-based scenario, two for the double charge; the CCREJECT one is skipped.
    expect(created).toHaveLength(8);
    expect(approvals).toHaveLength(8);
    for (const a of approvals) expect(a.url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    for (const r of created) {
      const ctx = (r.body as { payment_source: { paypal: { experience_context: Record<string, string> } } }).payment_source.paypal.experience_context;
      expect(ctx.return_url).toBe(approver.returnUrl);
      expect(ctx.shipping_preference).toBe("NO_SHIPPING");
    }
  });

  it("authorizes or captures each approved order with its own PayPal-Request-Id", () => {
    const steps = fake.requests.filter((r) => /\/v2\/checkout\/orders\/[^/]+\/(authorize|capture)$/.test(r.path));
    expect(steps).toHaveLength(8);
    for (const r of steps) expect(r.headers["paypal-request-id"]).toBeTruthy();
    expect(new Set(steps.map((r) => r.headers["paypal-request-id"])).size).toBe(8);
  });

  it("skips only the card-trigger scenario and runs everything else", () => {
    expect(outcome["card-declined-capture"]).toBe("skipped");
    for (const [id, result] of Object.entries(outcome)) if (id !== "card-declined-capture") expect(result, id).toBe("ok");
  });

  it("still produces every incident type except the DECLINED capture object", () => {
    const types = new Set(store.listIncidents().map((i) => i.type));
    for (const t of ["uncaptured_shipment", "capture_failed", "duplicate_charge", "duplicate_refund", "invoice_overdue", "auth_honor_expired", "auth_expiring"]) {
      expect(types, t).toContain(t);
    }
    expect(byType("capture_failed")).toHaveLength(1);
    expect(byType("capture_failed")[0].subject?.kind).toBe("authorization");
  });

  it("uses one buyer for both halves of the double charge, so the detector can match them", () => {
    const [dup] = byType("duplicate_charge");
    const facts = dup.evidence.facts as Record<string, string>;
    expect(store.getLedger("order", facts.first_order_id)?.payer).toBe(store.getLedger("order", facts.duplicate_order_id)?.payer);
    expect(dup.status).toBe("awaiting_approval");
  });

  it("detects the double refund although PayPal reports refund times with a UTC offset", () => {
    const [refund] = byType("duplicate_refund");
    expect(refund).toBeTruthy();
    for (const r of store.listLedger("refund")) expect(r.createdAt).toMatch(/Z$/);
  });

  it("records the shop's refused capture with the code the sandbox honours on that endpoint", () => {
    const attempt = store.listLedger("capture_attempt").find((a) => !a.ok)!;
    expect(attempt.httpStatus).toBe(422);
    expect(attempt.errorIssue).toBe("PAYER_CANNOT_PAY");
  });
});
