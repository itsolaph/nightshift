// A small typed REST client for the PayPal sandbox. Plain fetch, OAuth2 client credentials with a
// cached token, PayPal-Request-Id on every POST, optional negative-testing mock header, and retries
// that are safe because a retried POST carries the same request id.
//
// Errors are returned, not thrown: callers (the executor especially) need PayPal's full error body
// for the audit trail. `PayPalResult.ok` tells success from failure.

import { randomUUID } from "node:crypto";
import { assertSandboxOnly, config, SANDBOX_API_BASE } from "../config";
import type * as T from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PayPalResult<B = unknown> = {
  ok: boolean;
  status: number;
  body: B;
  debugId: string | null;
  method: string;
  path: string;
  requestId: string | null;
  durationMs: number;
};

export type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** PayPal-Request-Id. Generated for POSTs when not given. */
  requestId?: string;
  /** Sandbox negative testing: becomes PayPal-Mock-Response: {"mock_application_codes": "<code>"}. */
  mockCode?: string;
  prefer?: "return=minimal" | "return=representation";
  /** Extra attempts for 429/5xx/network errors. */
  retries?: number;
};

export type PayPalClientOptions = {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

export class PayPalNotConfigured extends Error {
  constructor() {
    super("PayPal sandbox credentials are not set (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).");
    this.name = "PayPalNotConfigured";
  }
}

export class PayPalClient {
  readonly apiBase = SANDBOX_API_BASE;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PayPalClientOptions) {
    assertSandboxOnly();
    if (!options.clientId || !options.clientSecret) throw new PayPalNotConfigured();
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // --- Plumbing -----------------------------------------------------------------------

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await response.json().catch(() => ({}))) as T.OAuthToken & { error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(`PayPal OAuth failed (${response.status}): ${body.error_description ?? "no access token"}`);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  async request<B = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: RequestOptions = {}) {
    const url = new URL(path, this.apiBase);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const requestId = method === "POST" ? (opts.requestId ?? randomUUID()) : null;
    const retries = opts.retries ?? 2;
    const started = Date.now();
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.accessToken(refreshed)}`,
        Accept: "application/json",
        Prefer: opts.prefer ?? "return=representation",
      };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (requestId) headers["PayPal-Request-Id"] = requestId;
      if (opts.mockCode) headers["PayPal-Mock-Response"] = JSON.stringify({ mock_application_codes: opts.mockCode });

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (error) {
        if (attempt < retries) {
          await this.sleep(400 * 2 ** attempt);
          continue;
        }
        return {
          ok: false,
          status: 0,
          body: { name: "NETWORK_ERROR", message: String(error) },
          debugId: null,
          method,
          path: url.pathname + url.search,
          requestId,
          durationMs: Date.now() - started,
        } as PayPalResult<B>;
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await this.sleep(400 * 2 ** attempt);
        continue;
      }

      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        body: body as B,
        debugId: response.headers.get("paypal-debug-id"),
        method,
        path: url.pathname + url.search,
        requestId,
        durationMs: Date.now() - started,
      } satisfies PayPalResult<B>;
    }
  }

  // --- Orders v2 ----------------------------------------------------------------------

  createOrder(body: T.CreateOrderRequest, opts: RequestOptions = {}) {
    return this.request<T.Order>("POST", "/v2/checkout/orders", { ...opts, body });
  }
  getOrder(id: string) {
    return this.request<T.Order>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }
  authorizeOrder(id: string, opts: RequestOptions = {}) {
    return this.request<T.Order>("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/authorize`, { ...opts, body: {} });
  }
  captureOrder(id: string, opts: RequestOptions = {}) {
    return this.request<T.Order>("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { ...opts, body: {} });
  }

  // --- Payments v2 --------------------------------------------------------------------

  getAuthorization(id: string) {
    return this.request<T.Authorization>("GET", `/v2/payments/authorizations/${encodeURIComponent(id)}`);
  }
  captureAuthorization(id: string, body: T.CaptureAuthorizationRequest, opts: RequestOptions = {}) {
    return this.request<T.Capture>("POST", `/v2/payments/authorizations/${encodeURIComponent(id)}/capture`, {
      ...opts,
      body,
    });
  }
  reauthorizeAuthorization(id: string, body: { amount?: T.Amount }, opts: RequestOptions = {}) {
    return this.request<T.Authorization>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(id)}/reauthorize`,
      { ...opts, body },
    );
  }
  voidAuthorization(id: string, opts: RequestOptions = {}) {
    return this.request<T.Authorization | null>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(id)}/void`,
      opts,
    );
  }
  getCapture(id: string) {
    return this.request<T.Capture>("GET", `/v2/payments/captures/${encodeURIComponent(id)}`);
  }
  refundCapture(id: string, body: T.RefundRequest, opts: RequestOptions = {}) {
    return this.request<T.Refund>("POST", `/v2/payments/captures/${encodeURIComponent(id)}/refund`, { ...opts, body });
  }
  getRefund(id: string) {
    return this.request<T.Refund>("GET", `/v2/payments/refunds/${encodeURIComponent(id)}`);
  }

  // --- Invoicing v2 -------------------------------------------------------------------

  generateInvoiceNumber() {
    return this.request<{ invoice_number: string }>("POST", "/v2/invoicing/generate-next-invoice-number");
  }
  createInvoice(body: T.CreateInvoiceRequest, opts: RequestOptions = {}) {
    return this.request<T.Invoice>("POST", "/v2/invoicing/invoices", { ...opts, body });
  }
  sendInvoice(id: string, body: T.InvoiceNotification = { send_to_invoicer: false }, opts: RequestOptions = {}) {
    return this.request<{ href?: string; links?: T.Link[] }>(
      "POST",
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
      { ...opts, body },
    );
  }
  remindInvoice(id: string, body: T.InvoiceNotification, opts: RequestOptions = {}) {
    return this.request<null>("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, { ...opts, body });
  }
  recordInvoicePayment(id: string, body: T.RecordPaymentRequest, opts: RequestOptions = {}) {
    return this.request<{ payment_id: string }>(
      "POST",
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`,
      { ...opts, body },
    );
  }
  listInvoices(page = 1, pageSize = 50) {
    return this.request<T.InvoiceList>("GET", "/v2/invoicing/invoices", {
      query: { page, page_size: pageSize, total_required: true },
    });
  }
  getInvoice(id: string) {
    return this.request<T.Invoice>("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }

  // --- Transaction Search and balances ------------------------------------------------

  /** Dates must be ISO 8601 without fractional seconds and at most 31 days apart. */
  searchTransactions(start: Date, end: Date, page = 1) {
    return this.request<T.TransactionSearch>("GET", "/v1/reporting/transactions", {
      query: {
        start_date: isoNoMillis(start),
        end_date: isoNoMillis(end),
        fields: "transaction_info,payer_info,cart_info",
        page_size: 100,
        page,
      },
    });
  }
  getBalances() {
    return this.request<T.Balances>("GET", "/v1/reporting/balances", { query: { currency_code: "ALL" } });
  }

  // --- Disputes ----------------------------------------------------------------------

  listDisputes() {
    return this.request<T.DisputeList>("GET", "/v1/customer/disputes", { query: { page_size: 50 } });
  }

  // --- Webhooks ----------------------------------------------------------------------

  listWebhooks() {
    return this.request<{ webhooks: T.Webhook[] }>("GET", "/v1/notifications/webhooks");
  }
  createWebhook(url: string, eventTypes: string[]) {
    return this.request<T.Webhook>("POST", "/v1/notifications/webhooks", {
      body: { url, event_types: eventTypes.map((name) => ({ name })) },
    });
  }
  verifyWebhookSignature(body: T.VerifyWebhookSignatureRequest) {
    return this.request<{ verification_status: "SUCCESS" | "FAILURE" }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      { body },
    );
  }
}

export function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const globalClient = globalThis as unknown as { __nightshiftPayPal?: PayPalClient | null };

/** The process-wide client, or null when sandbox credentials are missing. */
export function paypal(): PayPalClient | null {
  if (globalClient.__nightshiftPayPal === undefined) {
    const { paypal: cfg } = config();
    globalClient.__nightshiftPayPal = cfg.configured
      ? new PayPalClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret })
      : null;
  }
  return globalClient.__nightshiftPayPal;
}

export function setPayPalClient(client: PayPalClient | null) {
  globalClient.__nightshiftPayPal = client;
}

/** Human-readable summary of a PayPal error body: "UNPROCESSABLE_ENTITY / INSTRUMENT_DECLINED". */
export function describeError(body: unknown): { name: string | null; issue: string | null; message: string } {
  const b = (body ?? {}) as T.PayPalError;
  const issue = b.details?.[0]?.issue ?? null;
  return {
    name: b.name ?? null,
    issue,
    message: [b.name, issue, b.details?.[0]?.description ?? b.message].filter(Boolean).join(": ") || "Unknown error",
  };
}
