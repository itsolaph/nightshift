import { describe, expect, it } from "vitest";
import { PayPalClient } from "@/lib/paypal/client";
import { verifyWebhook } from "@/lib/paypal/webhooks";
import { Store } from "@/lib/db";
import { handleWebhookEvent } from "@/lib/watcher";
import { FakePayPal } from "./fake-paypal";

const headers = (patch: Record<string, string> = {}) =>
  new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
    "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    "paypal-transmission-sig": "good-signature",
    "paypal-transmission-time": "2026-10-22T10:00:00Z",
    ...patch,
  });

// Odd spacing on purpose: verification must send the event byte for byte.
const RAW = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED",  "resource":{"id":"CAP1","amount":{"currency_code":"USD","value":"10.00"}}}';

function client(fake: FakePayPal) {
  return new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
}

describe("webhook verification", () => {
  it("verifies with PayPal and posts the event exactly as received", async () => {
    const fake = new FakePayPal();
    const result = await verifyWebhook(client(fake), headers(), RAW, "WH-ID-1");
    expect(result).toEqual({ verified: true, reason: "SUCCESS" });
    const call = fake.requests.find((r) => r.path === "/v1/notifications/verify-webhook-signature")!;
    expect(call.body).toMatchObject({
      auth_algo: "SHA256withRSA",
      transmission_id: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      transmission_sig: "good-signature",
      webhook_id: "WH-ID-1",
      webhook_event: JSON.parse(RAW),
    });
  });

  it("sends the raw body bytes, not a re-serialised copy", async () => {
    const fake = new FakePayPal();
    let sent = "";
    const spy = new PayPalClient({
      clientId: "id",
      clientSecret: "secret",
      sleep: async () => {},
      fetch: async (input, init) => {
        if (String(input).endsWith("verify-webhook-signature")) sent = String(init?.body);
        return fake.fetch(input, init);
      },
    });
    await verifyWebhook(spy, headers(), RAW, "WH-ID-1");
    expect(sent.endsWith(`"webhook_event":${RAW}}`)).toBe(true);
  });

  it("rejects a bad signature", async () => {
    const result = await verifyWebhook(client(new FakePayPal()), headers({ "paypal-transmission-sig": "forged" }), RAW, "WH-ID-1");
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("FAILURE");
  });

  it("rejects missing headers, foreign cert hosts and a missing webhook id without calling PayPal", async () => {
    const fake = new FakePayPal();
    const h = headers();
    h.delete("paypal-transmission-sig");
    expect((await verifyWebhook(client(fake), h, RAW, "WH-ID-1")).reason).toMatch(/Missing headers/);
    expect((await verifyWebhook(client(fake), headers({ "paypal-cert-url": "https://evil.example.com/cert" }), RAW, "WH-ID-1")).reason).toMatch(/not paypal.com/);
    expect((await verifyWebhook(client(fake), headers(), RAW, "")).reason).toMatch(/No webhook id/);
    expect((await verifyWebhook(null, headers(), RAW, "WH-ID-1")).verified).toBe(false);
    expect(fake.requests.filter((r) => r.path.includes("verify-webhook-signature"))).toHaveLength(0);
  });
});

describe("webhook handling", () => {
  it("re-reads the order a capture event points at, instead of trusting the payload", async () => {
    const fake = new FakePayPal();
    const c = client(fake);
    const order = await c.createOrder({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "19.00" } }],
      payment_source: { card: { number: "4012888888881881", expiry: "2030-12", name: "Buyer" } },
    });
    const captureId = order.body.purchase_units![0].payments!.captures![0].id;
    const store = new Store(":memory:");
    const outcome = await handleWebhookEvent(store, c, {
      id: "WH-2",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "999.00" } },
    });
    expect(outcome).toContain(order.body.id);
    expect(store.getLedger("capture", captureId)?.amountCents).toBe(1900);
    expect(store.getLedger("order", order.body.id)?.source).toBe("webhook");
  });

  it("stores each delivery once", () => {
    const store = new Store(":memory:");
    expect(store.recordWebhook("WH-3", "PAYMENT.CAPTURE.COMPLETED", true, {})).toBe(true);
    expect(store.recordWebhook("WH-3", "PAYMENT.CAPTURE.COMPLETED", true, {})).toBe(false);
  });
});
