// End to end: "Run the night" against an in-memory fake of the PayPal sandbox. Seeds every
// scenario, moves the demo clock, lets the watcher/detectors/triage (rule-based, no LLM key) and
// policy gate/executor run, then approves the double-charge refund from the inbox.

import { beforeAll, describe, expect, it } from "vitest";
import { Store, setStore } from "@/lib/db";
import { PayPalClient, setPayPalClient } from "@/lib/paypal/client";
import { runTheNight } from "@/lib/scenarios";
import { decideAction } from "@/lib/engine";
import { executeAction } from "@/lib/executor";
import { FakePayPal } from "./fake-paypal";

const fake = new FakePayPal();
const store = new Store(":memory:");
const client = new PayPalClient({ clientId: "test-id", clientSecret: "test-secret", fetch: fake.fetch, sleep: async () => {} });

beforeAll(async () => {
  delete process.env.LLM_API_KEY;
  setStore(store);
  setPayPalClient(client);
  await runTheNight(store, client, "night_test");
}, 30_000);

const byType = (type: string) => store.listIncidents().filter((i) => i.type === type);
const actionsFor = (incidentId: string) => store.listActions(incidentId);

describe("run the night (fake sandbox)", () => {
  it("ends with the demo clock at +27 days and every incident type the lab promises", () => {
    expect(store.settings().demoClockOffsetDays).toBe(27);
    const types = new Set(store.listIncidents().map((i) => i.type));
    for (const t of ["uncaptured_shipment", "capture_failed", "duplicate_charge", "duplicate_refund", "invoice_overdue", "auth_honor_expired", "auth_expiring"]) {
      expect(types, t).toContain(t);
    }
    expect(byType("capture_failed")).toHaveLength(2); // rejected call + DECLINED capture object
    expect(byType("invoice_overdue")).toHaveLength(2);
  });

  it("auto-captures shipped orders through the policy gate with an idempotency key", () => {
    const shipped = byType("uncaptured_shipment");
    expect(shipped).toHaveLength(2);
    for (const incident of shipped) {
      expect(incident.status).toBe("resolved");
      expect(incident.diagnosisSource).toBe("rules");
      const [capture] = actionsFor(incident.id);
      expect(capture.type).toBe("capture_authorization");
      expect(capture.decision).toBe("auto");
      expect(capture.status).toBe("succeeded");
      expect(incident.savedCents).toBe(capture.amountCents);
      const call = fake.requests.find((r) => r.path === `/v2/payments/authorizations/${capture.targetId}/capture` && r.headers["paypal-request-id"] === capture.idempotencyKey);
      expect(call, "capture call with the action's PayPal-Request-Id").toBeTruthy();
    }
  });

  it("does not follow instructions hidden in an order description", () => {
    const hostile = byType("uncaptured_shipment").find((i) => store.getLedger("order", i.orderId!)?.buyerNote);
    expect(hostile).toBeTruthy();
    expect(actionsFor(hostile!.id).map((a) => a.type)).toEqual(["capture_authorization"]);
  });

  it("routes the double charge refund to approval, then executes it once approved", async () => {
    const [dup] = byType("duplicate_charge");
    expect(dup.status).toBe("awaiting_approval");
    const [refund] = actionsFor(dup.id);
    expect(refund.type).toBe("refund_capture");
    expect(refund.decision).toBe("needs_approval");
    expect(refund.call?.path).toBe(`/v2/payments/captures/${refund.targetId}/refund`);
    expect(fake.requests.some((r) => r.path === refund.call?.path && r.headers["paypal-request-id"] === refund.idempotencyKey)).toBe(false);

    const done = await decideAction(store, client, refund.id, { kind: "approve", by: "test" });
    expect(done.status).toBe("succeeded");
    expect(store.getIncident(dup.id)?.status).toBe("resolved");
    expect(store.getIncident(dup.id)?.savedCents).toBe(6400);
    const refundCalls = fake.requests.filter((r) => r.path === refund.call?.path);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].headers["paypal-request-id"]).toBe(refund.idempotencyKey);

    // Executing again is a no-op: the action is no longer "approved".
    const again = await executeAction(store, client, refund.id);
    expect(again.executed).toBe(false);
    expect(fake.requests.filter((r) => r.path === refund.call?.path)).toHaveLength(1);
  });

  it("sends invoice reminders automatically", () => {
    for (const incident of byType("invoice_overdue")) {
      const [remind] = actionsFor(incident.id);
      expect(remind.type).toBe("send_invoice_reminder");
      expect(remind.status).toBe("succeeded");
      expect(store.getLedger("invoice", remind.targetId!)?.lastReminderAt).toBeTruthy();
    }
    expect(fake.requests.filter((r) => r.path.endsWith("/remind"))).toHaveLength(2);
  });

  it("escalates instead of retrying when PayPal refuses a reauthorization", () => {
    const [honor] = byType("auth_honor_expired");
    const actions = actionsFor(honor.id);
    expect(actions[0].type).toBe("reauthorize_authorization");
    expect(actions[0].decision).toBe("auto");
    expect(actions[0].status).toBe("failed");
    expect(JSON.stringify(actions[0].response?.body)).toContain("REAUTHORIZATION_TOO_SOON");
    expect(actions[1].type).toBe("ask_owner");
    expect(actions[1].status).toBe("awaiting_approval");
    expect(honor.status).toBe("awaiting_approval");
  });

  it("asks the owner about declines, duplicate refunds and an unshipped expiring authorization", () => {
    for (const type of ["capture_failed", "duplicate_refund", "auth_expiring"]) {
      for (const incident of byType(type)) {
        const actions = actionsFor(incident.id);
        expect(actions.map((a) => a.type), type).toEqual(["ask_owner"]);
        expect(incident.status).toBe("awaiting_approval");
      }
    }
  });

  it("uses the two-step Orders flow (create, then authorize or capture with the card) for two scenarios", () => {
    const authorize = fake.requests.filter((r) => /\/v2\/checkout\/orders\/[^/]+\/authorize$/.test(r.path));
    const capture = fake.requests.filter((r) => /\/v2\/checkout\/orders\/[^/]+\/capture$/.test(r.path));
    expect(authorize).toHaveLength(1);
    expect(capture).toHaveLength(1);
    for (const r of [...authorize, ...capture]) {
      expect((r.body as { payment_source?: unknown }).payment_source).toBeTruthy();
      expect(r.headers["paypal-request-id"]).toBeTruthy();
    }
  });

  it("never sends a money-moving POST without a PayPal-Request-Id, and never retries a declined capture on its own", () => {
    const money = fake.requests.filter((r) => r.method === "POST" && /\/v2\/payments\//.test(r.path));
    expect(money.length).toBeGreaterThan(0);
    for (const r of money) expect(r.headers["paypal-request-id"], r.path).toBeTruthy();
    const declined = byType("capture_failed").find((i) => i.subject?.kind === "authorization")!;
    const captureCalls = fake.requests.filter((r) => r.path === `/v2/payments/authorizations/${declined.subject!.id}/capture`);
    expect(captureCalls).toHaveLength(1); // only the shop's original, mocked-to-fail attempt
    expect(captureCalls[0].headers["paypal-mock-response"]).toContain("PAYER_CANNOT_PAY");
  });

  it("writes the full audit trail: detected, diagnosis, proposal, policy, PayPal call and response", () => {
    const [incident] = byType("uncaptured_shipment");
    const kinds = store.incidentEvents(incident.id).map((e) => e.kind);
    for (const k of ["detected", "diagnosis", "proposal", "policy", "paypal_call", "paypal_response", "outcome"]) expect(kinds).toContain(k);
  });

  it("does not reopen incidents on another sweep of the same ledger", async () => {
    const before = store.listIncidents().length;
    const { detectAndOpen } = await import("@/lib/watcher");
    expect(detectAndOpen(store)).toEqual([]);
    expect(store.listIncidents().length).toBe(before);
  });
});
