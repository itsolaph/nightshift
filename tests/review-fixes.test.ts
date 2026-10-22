// Regression tests for issues found in review: 2xx responses carrying a failed resource, stale
// approvals, owner answers that don't settle money, webhook retries after a failed verification,
// OAuth failures, and the optional owner passcode.

import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@/lib/db";
import { PayPalClient, type FetchLike } from "@/lib/paypal/client";
import { ingestOrder } from "@/lib/ledger";
import { detectAndOpen } from "@/lib/watcher";
import { ApprovalError, decideAction, processProposals } from "@/lib/engine";
import { executeAction } from "@/lib/executor";
import { isOwner, ownerToken, requireOwner } from "@/lib/owner";
import { FakePayPal } from "./fake-paypal";

async function shipped(wrap?: (inner: FetchLike) => FetchLike) {
  const fake = new FakePayPal();
  const store = new Store(":memory:");
  const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: wrap ? wrap(fake.fetch) : fake.fetch, sleep: async () => {} });
  const order = await client.createOrder({
    intent: "AUTHORIZE",
    purchase_units: [{ amount: { currency_code: "USD", value: "42.00" } }],
    payment_source: { card: { number: "4012888888881881", expiry: "2030-12", name: "Buyer" } },
  });
  ingestOrder(store, order.body, { fulfillment: "shipped", shippedAt: new Date(Date.now() - 20 * 3600_000).toISOString() });
  const [incident] = detectAndOpen(store);
  const authId = store.listLedger("authorization")[0].id;
  return { fake, store, client, incident, authId };
}

describe("2xx with a failed resource", () => {
  it("treats a 201 capture with status DECLINED as a failure and escalates", async () => {
    const { store, client, incident, authId } = await shipped((inner) => async (input, init) => {
      if (String(input).endsWith("/capture")) {
        return new Response(JSON.stringify({ id: "CAPDECLINED00001", status: "DECLINED", amount: { currency_code: "USD", value: "42.00" } }), { status: 201 });
      }
      return inner(input, init);
    });
    const [action] = await processProposals(store, client, incident.id, [{ type: "capture_authorization", targetId: authId, rationale: "t" }], "rules");
    const after = store.getAction(action.id)!;
    expect(after.status).toBe("failed");
    expect(store.getIncident(incident.id)?.savedCents).toBe(0);
    expect(store.getIncident(incident.id)?.status).toBe("awaiting_approval");
    expect(store.listLedger("capture_attempt").every((a) => !a.ok)).toBe(true);
    expect(store.getLedger("capture", "CAPDECLINED00001")?.status).toBe("DECLINED");
  });
});

describe("approvals are re-checked against the current ledger", () => {
  it("blocks an approval whose authorization was captured in the meantime", async () => {
    const { fake, store, client, incident, authId } = await shipped();
    store.saveSettings({ autopilot: false });
    const [action] = await processProposals(store, client, incident.id, [{ type: "capture_authorization", targetId: authId, rationale: "t" }], "rules");
    expect(action.status).toBe("awaiting_approval");
    // Someone captured it outside Nightshift; the sweep updated the ledger.
    store.putLedger("authorization", { ...store.getLedger("authorization", authId)!, status: "CAPTURED" });
    await expect(decideAction(store, client, action.id, { kind: "approve", by: "test" })).rejects.toThrow(ApprovalError);
    expect(store.getAction(action.id)?.status).toBe("blocked");
    expect(fake.requests.filter((r) => r.path.endsWith("/capture"))).toHaveLength(0);
  });

  it("closing an incident with mark_resolved takes its other approvals out of the inbox", async () => {
    const { store, client, incident, authId } = await shipped();
    store.saveSettings({ autopilot: false });
    const [capture, close] = await processProposals(
      store,
      client,
      incident.id,
      [
        { type: "capture_authorization", targetId: authId, amountCents: 2000, rationale: "partial" },
        { type: "mark_resolved", rationale: "close" },
      ],
      "agent",
    );
    await decideAction(store, client, close.id, { kind: "approve", by: "test" });
    expect(store.getIncident(incident.id)?.status).toBe("resolved");
    expect(store.getAction(capture.id)?.status).toBe("rejected");
  });

  it("refuses an edited amount that collides with another action's key", async () => {
    const { store, client, incident, authId } = await shipped();
    store.saveSettings({ autopilot: false });
    const [a, b] = await processProposals(
      store,
      client,
      incident.id,
      [
        { type: "capture_authorization", targetId: authId, amountCents: 4200, rationale: "full" },
        { type: "capture_authorization", targetId: authId, amountCents: 2000, rationale: "partial" },
      ],
      "agent",
    );
    expect(a.status).toBe("awaiting_approval");
    await expect(decideAction(store, client, b.id, { kind: "approve", amountCents: 4200, by: "test" })).rejects.toThrow(/already exists/);
  });
});

describe("owner answers", () => {
  it("closes the incident as 'closed by owner', not resolved, while money is still at risk", async () => {
    const { store, client, incident } = await shipped();
    const [question] = await processProposals(store, client, incident.id, [{ type: "ask_owner", note: "Ship?", rationale: "t" }], "agent");
    await decideAction(store, client, question.id, { kind: "answer", reply: "Not yet, wait", by: "test" });
    expect(store.getIncident(incident.id)?.status).toBe("dismissed");
    // A different problem on the same authorization can still open later.
    store.saveSettings({ demoClockOffsetDays: 27 });
    expect(detectAndOpen(store).map((i) => i.type)).toEqual(["auth_expiring"]);
  });
});

describe("webhooks and OAuth", () => {
  it("processes a verified retry of a delivery that failed verification first", () => {
    const store = new Store(":memory:");
    expect(store.recordWebhook("WH-9", "PAYMENT.CAPTURE.COMPLETED", false, {})).toBe(true);
    expect(store.recordWebhook("WH-9", "PAYMENT.CAPTURE.COMPLETED", true, {})).toBe(true);
    expect(store.recordWebhook("WH-9", "PAYMENT.CAPTURE.COMPLETED", true, {})).toBe(false);
  });

  it("returns an OAuth failure instead of throwing", async () => {
    const client = new PayPalClient({
      clientId: "id",
      clientSecret: "secret",
      sleep: async () => {},
      fetch: async () => new Response(JSON.stringify({ error: "invalid_client", error_description: "Client Authentication failed" }), { status: 401 }),
    });
    const result = await client.getOrder("ABC12345");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(JSON.stringify(result.body)).toContain("Client Authentication failed");
  });

  it("an OAuth failure during execution fails the action instead of leaving it executing", async () => {
    const { store, incident, authId } = await shipped();
    const broken = new PayPalClient({ clientId: "id", clientSecret: "secret", sleep: async () => {}, fetch: async () => new Response("{}", { status: 500 }) });
    store.saveSettings({ autopilot: false });
    const [action] = await processProposals(store, broken, incident.id, [{ type: "capture_authorization", targetId: authId, rationale: "t" }], "rules");
    store.updateAction(action.id, { status: "approved" });
    const { action: done } = await executeAction(store, broken, action.id);
    expect(done.status).toBe("failed");
  });
});

describe("owner passcode", () => {
  afterEach(() => {
    delete process.env.OWNER_PASSCODE;
  });
  const req = (headers: Record<string, string> = {}) => new Request("http://x/api/settings", { method: "POST", headers });

  it("is open when no passcode is configured", () => {
    expect(isOwner(req())).toBe(true);
    expect(requireOwner(req())).toBeNull();
  });

  it("requires the cookie or header when OWNER_PASSCODE is set", () => {
    process.env.OWNER_PASSCODE = "roast-2026";
    expect(requireOwner(req())?.status).toBe(401);
    expect(isOwner(req({ cookie: `ns_owner=${ownerToken()}` }))).toBe(true);
    expect(isOwner(req({ cookie: "ns_owner=forged" }))).toBe(false);
    expect(isOwner(req({ "x-owner-passcode": "roast-2026" }))).toBe(true);
    expect(isOwner(req({ "x-owner-passcode": "wrong" }))).toBe(false);
  });
});
