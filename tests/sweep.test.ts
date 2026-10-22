import { describe, expect, it } from "vitest";
import { Store } from "@/lib/db";
import { PayPalClient } from "@/lib/paypal/client";
import { ingestOrder } from "@/lib/ledger";
import { sweep } from "@/lib/watcher";
import { FakePayPal } from "./fake-paypal";

describe("sweep", () => {
  it("refreshes tracked orders, discovers unknown captures via Transaction Search, reads invoices and balances", async () => {
    const fake = new FakePayPal();
    const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
    const store = new Store(":memory:");
    const card = { number: "4012888888881881", expiry: "2030-12", name: "Buyer" };
    const tracked = await client.createOrder({ intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }], payment_source: { card } });
    ingestOrder(store, tracked.body, { fulfillment: "shipped", shippedAt: new Date().toISOString() });
    // Captured at PayPal behind Nightshift's back.
    const authId = tracked.body.purchase_units![0].payments!.authorizations![0].id;
    await client.captureAuthorization(authId, {});
    // An order Nightshift never heard of.
    const unknown = await client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "25.00" } }], payment_source: { card } });

    const report = await sweep(store, client);
    expect(report.errors).toEqual([]);
    expect(store.getLedger("authorization", authId)?.status).toBe("CAPTURED");
    expect(store.getLedger("order", unknown.body.id)?.source).toBe("sweep");
    expect(report.discovered).toBeGreaterThanOrEqual(1);
    expect(store.getKv("balances")).toEqual([{ currency: "USD", total: "1234.56", available: null }]);
    // Sweep dates have no fractional seconds.
    const search = fake.requests.find((r) => r.path === "/v1/reporting/transactions")!;
    const start = new URLSearchParams(search.query).get("start_date")!;
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
