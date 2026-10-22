// An in-memory stand-in for the PayPal sandbox REST API, for tests only. It implements just enough
// of Orders v2, Payments v2 and Invoicing v2 for the scenario flow, honours PayPal-Request-Id
// replays and the PayPal-Mock-Response negative-testing header, and records every request.

import type { FetchLike } from "@/lib/paypal/client";

type Rec = Record<string, unknown>;
export type Recorded = { method: string; path: string; query: string; headers: Record<string, string>; body: unknown };

let counter = 0;
const pid = (prefix: string) => `${prefix}${String(++counter).padStart(17 - prefix.length, "0")}`;

export class FakePayPal {
  requests: Recorded[] = [];
  orders = new Map<string, Rec>();
  authorizations = new Map<string, Rec>();
  captures = new Map<string, Rec>();
  refunds = new Map<string, Rec>();
  invoices = new Map<string, Rec>();
  private replays = new Map<string, { status: number; body: unknown }>();
  /** Force a reauthorize answer, like the real sandbox does for card authorizations. */
  reauthorizeError: string | null = "REAUTHORIZATION_NOT_SUPPORTED_FOR_PAYMENT_SOURCE";

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = undefined;
    if (typeof init?.body === "string" && init.body && headers["content-type"]?.includes("json")) body = JSON.parse(init.body);
    this.requests.push({ method, path: url.pathname, query: url.search, headers, body });

    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21-test", token_type: "Bearer", expires_in: 32400 });

    const requestId = headers["paypal-request-id"];
    const replayKey = requestId ? `${method} ${url.pathname} ${requestId}` : null;
    if (replayKey && this.replays.has(replayKey)) {
      const replay = this.replays.get(replayKey)!;
      return json(replay.status === 201 ? 200 : replay.status, replay.body);
    }
    const mock = headers["paypal-mock-response"] ? (JSON.parse(headers["paypal-mock-response"]).mock_application_codes as string) : null;
    const result = mock ? error(422, "UNPROCESSABLE_ENTITY", mock) : this.route(method, url, body as Rec);
    if (replayKey && method === "POST") this.replays.set(replayKey, result);
    return json(result.status, result.body);
  };

  private route(method: string, url: URL, body: Rec): { status: number; body: unknown } {
    const p = url.pathname;
    const now = new Date().toISOString();
    let m: RegExpMatchArray | null;

    if (method === "POST" && p === "/v2/checkout/orders") {
      const unit = (body.purchase_units as Rec[])[0];
      const amount = unit.amount as Rec;
      const card = (body.payment_source as Rec)?.card as Rec;
      const id = pid("O");
      const order: Rec = {
        id,
        intent: body.intent,
        status: "COMPLETED",
        create_time: now,
        payment_source: { card: { name: card.name, last_digits: String(card.number).slice(-4), brand: "VISA" } },
        purchase_units: [{ reference_id: "default", custom_id: unit.custom_id, description: unit.description, amount, payments: {} }],
      };
      const payments = (order.purchase_units as Rec[])[0].payments as Rec;
      if (body.intent === "AUTHORIZE") {
        const auth = { id: pid("A"), status: "CREATED", amount, create_time: now, expiration_time: new Date(Date.now() + 29 * 864e5).toISOString(), supplementary_data: { related_ids: { order_id: id } } };
        this.authorizations.set(auth.id, auth);
        payments.authorizations = [auth];
      } else {
        const declined = String(card.name).startsWith("CCREJECT");
        const cap = { id: pid("C"), status: declined ? "DECLINED" : "COMPLETED", amount, final_capture: true, create_time: now, supplementary_data: { related_ids: { order_id: id } } };
        this.captures.set(cap.id, cap);
        payments.captures = [cap];
      }
      this.orders.set(id, order);
      return { status: 201, body: order };
    }
    if (method === "GET" && (m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) {
      const order = this.orders.get(m[1]);
      if (!order) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      const unit = (order.purchase_units as Rec[])[0];
      const auths = [...this.authorizations.values()].filter((a) => (a.supplementary_data as Rec).related_ids && ((a.supplementary_data as Rec).related_ids as Rec).order_id === order.id);
      const caps = [...this.captures.values()].filter((c) => ((c.supplementary_data as Rec).related_ids as Rec).order_id === order.id);
      const refs = [...this.refunds.values()].filter((r) => caps.some((c) => c.id === r.capture_id));
      unit.payments = { authorizations: auths, captures: caps, refunds: refs };
      return { status: 200, body: order };
    }
    if ((m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)(\/(capture|reauthorize|void))?$/))) {
      const auth = this.authorizations.get(m[1]);
      if (!auth) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (method === "GET") return { status: 200, body: auth };
      if (m[3] === "capture") {
        if (auth.status !== "CREATED") return error(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED");
        const amount = (body?.amount as Rec) ?? auth.amount;
        const orderId = ((auth.supplementary_data as Rec).related_ids as Rec).order_id;
        const cap = {
          id: pid("C"),
          status: "COMPLETED",
          amount,
          final_capture: true,
          create_time: now,
          supplementary_data: { related_ids: { order_id: orderId, authorization_id: auth.id } },
          links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/authorizations/${auth.id}`, method: "GET" }],
        };
        this.captures.set(cap.id, cap);
        auth.status = "CAPTURED";
        return { status: 201, body: cap };
      }
      if (m[3] === "reauthorize") {
        if (this.reauthorizeError) return error(422, "UNPROCESSABLE_ENTITY", this.reauthorizeError);
        const next = { ...auth, id: pid("A"), create_time: now };
        this.authorizations.set(next.id as string, next);
        return { status: 201, body: next };
      }
      if (m[3] === "void") {
        auth.status = "VOIDED";
        return { status: 200, body: auth };
      }
    }
    if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)(\/refund)?$/))) {
      const cap = this.captures.get(m[1]);
      if (!cap) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (method === "GET") return { status: 200, body: cap };
      const amount = (body?.amount as Rec) ?? cap.amount;
      const refunded = [...this.refunds.values()].filter((r) => r.capture_id === cap.id).reduce((s, r) => s + Number((r.amount as Rec).value), 0);
      if (refunded + Number(amount.value) > Number((cap.amount as Rec).value) + 1e-9) return error(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED");
      const refund = {
        id: pid("R"),
        status: "COMPLETED",
        amount,
        create_time: now,
        capture_id: cap.id,
        links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${cap.id}`, method: "GET" }],
      };
      this.refunds.set(refund.id, refund);
      cap.status = refunded + Number(amount.value) >= Number((cap.amount as Rec).value) ? "REFUNDED" : "PARTIALLY_REFUNDED";
      return { status: 201, body: refund };
    }
    if ((m = p.match(/^\/v2\/payments\/refunds\/([^/]+)$/))) {
      const refund = this.refunds.get(m[1]);
      return refund ? { status: 200, body: refund } : error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    if (method === "POST" && p === "/v2/invoicing/invoices") {
      const detail = body.detail as Rec;
      const items = body.items as Rec[];
      const total = items.reduce((s, i) => s + Number((i.unit_amount as Rec).value) * Number(i.quantity), 0);
      const id = `INV2-TEST-${String(++counter).padStart(4, "0")}-AAAA-BBBB`;
      this.invoices.set(id, { id, status: "DRAFT", detail, primary_recipients: body.primary_recipients, amount: { currency_code: "USD", value: total.toFixed(2) }, due_amount: { currency_code: "USD", value: total.toFixed(2) }, payments: { paid_amount: { currency_code: "USD", value: "0.00" } } });
      return { status: 201, body: { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: "GET" } };
    }
    if ((m = p.match(/^\/v2\/invoicing\/invoices\/([^/]+)(\/(send|remind|payments))?$/))) {
      const inv = this.invoices.get(m[1]);
      if (!inv) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (method === "GET") return { status: 200, body: inv };
      if (m[3] === "send") {
        inv.status = "SENT";
        return { status: 200, body: { rel: "payer-view", href: "https://www.sandbox.paypal.com/invoice/p#x", method: "GET" } };
      }
      if (m[3] === "remind") return { status: 204, body: null };
      if (m[3] === "payments") {
        const paid = Number(((inv.payments as Rec).paid_amount as Rec).value) + Number((body.amount as Rec).value);
        const total = Number((inv.amount as Rec).value);
        inv.payments = { paid_amount: { currency_code: "USD", value: paid.toFixed(2) } };
        inv.due_amount = { currency_code: "USD", value: (total - paid).toFixed(2) };
        inv.status = paid >= total ? "PAID" : "PARTIALLY_PAID";
        return { status: 200, body: { payment_id: `EXTR-${counter}` } };
      }
    }
    if (method === "GET" && p === "/v2/invoicing/invoices") {
      return { status: 200, body: { items: [...this.invoices.values()], total_pages: 1, total_items: this.invoices.size } };
    }
    if (method === "GET" && p === "/v1/customer/disputes") return { status: 200, body: { items: [] } };
    if (method === "GET" && p === "/v1/reporting/transactions") {
      // Transaction Search shows captures (event code T0006) after a delay; here, immediately.
      const details = [...this.captures.values()].map((c) => ({ transaction_info: { transaction_id: c.id, transaction_event_code: "T0006" } }));
      return { status: 200, body: { transaction_details: details } };
    }
    if (method === "GET" && p === "/v1/reporting/balances") {
      return { status: 200, body: { balances: [{ currency: "USD", primary: true, total_balance: { currency_code: "USD", value: "1234.56" } }] } };
    }
    if (method === "POST" && p === "/v1/notifications/verify-webhook-signature") {
      return { status: 200, body: { verification_status: (body as Rec).transmission_sig === "good-signature" ? "SUCCESS" : "FAILURE" } };
    }
    return error(404, "NOT_FOUND", `fake has no route for ${method} ${p}`);
  }
}

function error(status: number, name: string, issue: string) {
  return { status, body: { name, message: issue, debug_id: `dbg${++counter}`, details: [{ issue, description: issue }] } };
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 || body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "paypal-debug-id": `dbg${counter}` },
  });
}
