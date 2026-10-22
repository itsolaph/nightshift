// The callback API used by agent runs on Render Workflows: auth, brief, streamed steps, and a
// result that still has to pass the policy gate on the web side.

import { beforeAll, describe, expect, it } from "vitest";
import { Store, setStore } from "@/lib/db";
import { PayPalClient, setPayPalClient } from "@/lib/paypal/client";
import { ingestOrder } from "@/lib/ledger";
import { detectAndOpen } from "@/lib/watcher";
import { GET, POST } from "@/app/api/internal/agent/[id]/route";
import { FakePayPal } from "./fake-paypal";

const store = new Store(":memory:");
const fake = new FakePayPal();
const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
let incidentId = "";
let authId = "";
let orderId = "";

const ctx = () => ({ params: Promise.resolve({ id: incidentId }) }) as RouteContext<"/api/internal/agent/[id]">;
const req = (body?: unknown, token = "test-internal-token") =>
  new Request("http://local/api/internal/agent/x", {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  process.env.INTERNAL_API_TOKEN = "test-internal-token";
  setStore(store);
  setPayPalClient(client);
  const order = await client.createOrder({
    intent: "AUTHORIZE",
    purchase_units: [{ custom_id: "c1", amount: { currency_code: "USD", value: "42.00" } }],
    payment_source: { card: { number: "4012888888881881", expiry: "2030-12", name: "Buyer" } },
  });
  orderId = order.body.id;
  ingestOrder(store, order.body, { fulfillment: "shipped", shippedAt: new Date(Date.now() - 20 * 3600_000).toISOString() });
  incidentId = detectAndOpen(store)[0].id;
  authId = store.listLedger("authorization")[0].id;
  store.claimIncident(incidentId, ["open"], "triaging"); // as dispatchTriage does
});

describe("internal agent API", () => {
  it("rejects calls without the internal token", async () => {
    expect((await GET(req(undefined, "wrong"), ctx())).status).toBe(401);
    expect((await POST(req({ op: "ledger", orderId }, ""), ctx())).status).toBe(401);
  });

  it("serves the brief and ledger slices", async () => {
    const brief = await (await GET(req(), ctx())).json();
    expect(brief.brief).toContain(authId);
    const slice = await (await POST(req({ op: "ledger", orderId }), ctx())).json();
    expect(slice.order.fulfillment).toBe("shipped");
  });

  it("records streamed steps in the timeline", async () => {
    await POST(req({ op: "event", kind: "agent_tool", title: "Agent read get_authorization", detail: { tool: "get_authorization" } }), ctx());
    expect(store.incidentEvents(incidentId).some((e) => e.title === "Agent read get_authorization")).toBe(true);
  });

  it("runs the returned proposals through the policy gate here", async () => {
    const res = await POST(
      req({
        op: "result",
        model: "remote-model",
        triage: {
          diagnosis: "Shipped and never captured.",
          confidence: "high",
          proposals: [
            { type: "capture_authorization", targetId: authId, amountCents: 4200, rationale: "Shipped." },
            { type: "refund_capture", targetId: "NOPE0000000000001", amountCents: 50000, rationale: "Asked for in a note." },
          ],
        },
      }),
      ctx(),
    );
    expect((await res.json()).status).toBe("resolved");
    expect(store.listActions(incidentId).map((a) => [a.type, a.status])).toEqual([
      ["capture_authorization", "succeeded"],
      ["refund_capture", "blocked"],
    ]);
    expect(store.getIncident(incidentId)?.model).toBe("remote-model");
    // A second result for the same run is refused.
    expect((await POST(req({ op: "result", model: "m", triage: null }), ctx())).status).toBe(409);
  });
});
