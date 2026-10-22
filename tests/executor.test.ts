import { describe, expect, it } from "vitest";
import { Store } from "@/lib/db";
import { executeAction, idempotencyKey } from "@/lib/executor";
import { processProposals } from "@/lib/engine";
import { PayPalClient, type FetchLike } from "@/lib/paypal/client";
import { detectAndOpen } from "@/lib/watcher";
import { FakePayPal } from "./fake-paypal";

async function setup(fetchWrap?: (inner: FetchLike) => FetchLike) {
  const fake = new FakePayPal();
  const store = new Store(":memory:");
  const client = new PayPalClient({
    clientId: "id",
    clientSecret: "secret",
    fetch: fetchWrap ? fetchWrap(fake.fetch) : fake.fetch,
    sleep: async () => {},
  });
  // A shipped, uncaptured authorization, created through the fake sandbox.
  const created = await client.createOrder({
    intent: "AUTHORIZE",
    purchase_units: [{ custom_id: "cart-1", amount: { currency_code: "USD", value: "42.00" } }],
    payment_source: { card: { number: "4012888888881881", expiry: "2030-12", name: "Buyer" } },
  });
  const { ingestOrder } = await import("@/lib/ledger");
  ingestOrder(store, created.body, { fulfillment: "shipped", shippedAt: new Date(Date.now() - 20 * 3600_000).toISOString() });
  store.saveSettings({ autopilot: false }); // keep the capture in the inbox until the test runs it
  const [incident] = detectAndOpen(store);
  const [action] = await processProposals(store, client, incident.id, [{ type: "capture_authorization", targetId: store.listLedger("authorization")[0].id, rationale: "test" }], "rules");
  store.updateAction(action.id, { status: "approved" });
  return { fake, store, client, incident, action };
}

describe("idempotency keys", () => {
  it("are derived from incident + action and stay under PayPal's 38-character limit", () => {
    const a = idempotencyKey("inc_1", "capture_authorization", "AUTH1", 4200);
    expect(a).toBe(idempotencyKey("inc_1", "capture_authorization", "AUTH1", 4200));
    expect(a).not.toBe(idempotencyKey("inc_1", "capture_authorization", "AUTH1", 4100));
    expect(a).not.toBe(idempotencyKey("inc_2", "capture_authorization", "AUTH1", 4200));
    expect(a.length).toBeLessThanOrEqual(38);
  });
});

describe("executor", () => {
  it("runs an action once even when executed concurrently", async () => {
    const { fake, store, client, action } = await setup();
    const results = await Promise.all([executeAction(store, client, action.id), executeAction(store, client, action.id), executeAction(store, client, action.id)]);
    expect(results.filter((r) => r.executed)).toHaveLength(1);
    const calls = fake.requests.filter((r) => r.path.endsWith("/capture"));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["paypal-request-id"]).toBe(action.idempotencyKey);
    expect(store.getAction(action.id)?.status).toBe("succeeded");
  });

  it("retries a 5xx with the same PayPal-Request-Id, and PayPal's replay does not capture twice", async () => {
    let failNext = true;
    const { fake, store, client, action } = await setup((inner) => async (input, init) => {
      const response = await inner(input, init);
      if (failNext && String(input).endsWith("/capture")) {
        failNext = false;
        // The capture happened at PayPal, but the response was lost.
        return new Response(JSON.stringify({ name: "INTERNAL_SERVER_ERROR" }), { status: 500 });
      }
      return response;
    });
    const { executed, action: done } = await executeAction(store, client, action.id);
    expect(executed).toBe(true);
    expect(done.status).toBe("succeeded");
    const calls = fake.requests.filter((r) => r.path.endsWith("/capture"));
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.headers["paypal-request-id"]))).toEqual(new Set([action.idempotencyKey]));
    expect(fake.captures.size).toBe(1);
    expect(done.response?.status).toBe(200); // replay answer
  });

  it("does nothing for actions that are not approved", async () => {
    const { fake, store, client, action } = await setup();
    store.updateAction(action.id, { status: "awaiting_approval" });
    expect((await executeAction(store, client, action.id)).executed).toBe(false);
    store.updateAction(action.id, { status: "blocked" });
    expect((await executeAction(store, client, action.id)).executed).toBe(false);
    expect(fake.requests.filter((r) => r.path.endsWith("/capture"))).toHaveLength(0);
  });

  it("records a PayPal refusal, logs the failed capture attempt and escalates to the owner", async () => {
    const { store, client, action, incident } = await setup((inner) => async (input, init) => {
      if (String(input).endsWith("/capture")) {
        return new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }], debug_id: "abc" }), { status: 422 });
      }
      return inner(input, init);
    });
    const { action: failed } = await executeAction(store, client, action.id);
    expect(failed.status).toBe("failed");
    expect(failed.response?.status).toBe(422);
    expect(store.listLedger("capture_attempt").filter((a) => !a.ok)).toHaveLength(1);
    const ask = store.listActions(incident.id).find((a) => a.type === "ask_owner");
    expect(ask?.status).toBe("awaiting_approval");
    expect(store.getIncident(incident.id)?.status).toBe("awaiting_approval");
  });

  it("dedupes the same proposal made twice", async () => {
    const { store, client, incident, action } = await setup();
    const again = await processProposals(store, client, incident.id, [{ type: "capture_authorization", targetId: action.targetId, rationale: "again" }], "agent");
    expect(again[0].id).toBe(action.id);
  });
});
