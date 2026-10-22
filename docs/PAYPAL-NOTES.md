# PayPal notes

What Nightshift relies on, where it comes from, and what is still unverified against a live sandbox. Researched October 2026. The `developer.paypal.com/api/<api>/<version>.md` pages now point to the OpenAPI schemas (`/api/<api>/<version>/schema.json`) as the authoritative source, so most field-level facts below come from those.

Status legend: **docs** = read in PayPal's documentation or schema; **sandbox** = confirmed with a live sandbox call; **unverified** = not documented clearly, needs a live check (tracked in [PROGRESS.md](../PROGRESS.md)).

## Environment

- Base URL `https://api-m.sandbox.paypal.com`. Nightshift refuses to start with `PAYPAL_ENV` set to anything but `sandbox`, and the client has the sandbox host hard-coded. (code)
- OAuth2 client credentials: `POST /v1/oauth2/token`, Basic auth with `client_id:client_secret`, body `grant_type=client_credentials`. Response has `access_token` and `expires_in` (seconds). Nightshift caches the token until a minute before expiry and refreshes once on a 401. (docs)

## Orders v2

Source: Orders v2 schema; [Orders advanced use cases](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced.md); [card testing](https://developer.paypal.com/api/rest/sandbox/card-testing/).

- Single-step card payments: `POST /v2/checkout/orders` with `payment_source.card` completes without a buyer approval step ("explicit buyer approval is not required for cards"). The documented CAPTURE example returns `status: COMPLETED` with `purchase_units[0].payments.captures[]`. (docs)
- With `intent: AUTHORIZE` the same call should return `COMPLETED` with `payments.authorizations[]`; there is no example response in the docs. (unverified)
- Send `PayPal-Request-Id` whenever `payment_source` is in the create call; the errors page lists `PAYPAL_REQUEST_ID_REQUIRED` for that case. The scenario lab always sends one. (docs)
- Card payments may require "Advanced Credit and Debit Card Payments" on the sandbox app. If an order comes back in another status, the lab logs it instead of pretending. (unverified)
- Sandbox decline triggers: put `CCREJECT-*` in the card holder name (for example `CCREJECT-IF`, insufficient funds) with Visa 4012888888881881. With CAPTURE intent the order completes but `captures[0].status` is `DECLINED`. Nightshift's "Card declined at capture" scenario uses this. (docs; AUTHORIZE behaviour unverified)
- `Prefer: return=representation` returns the full resource on create, authorize and capture. Nightshift always sends it. (docs)
- Order statuses: `CREATED`, `SAVED`, `APPROVED`, `VOIDED`, `COMPLETED`, `PAYER_ACTION_REQUIRED`. (docs)
- PayPal has no endpoint to list orders. Orders enter Nightshift's ledger from the shop (`POST /api/ingest/orders`), from webhooks, from Transaction Search, or from the scenario lab. (docs)

## Payments v2

Source: Payments v2 schema (operation descriptions, examples and the `x-errors` list).

| Call | Notes |
|---|---|
| `GET /v2/payments/authorizations/{id}` | `status`, `amount`, `expiration_time`, `supplementary_data.related_ids.order_id` |
| `POST /v2/payments/authorizations/{id}/capture` | body `amount`, `final_capture`, `note_to_payer`, `invoice_id`; 201 new, 200 on idempotent replay |
| `POST /v2/payments/authorizations/{id}/reauthorize` | body `amount` only; returns a **new** authorization id |
| `POST /v2/payments/authorizations/{id}/void` | 204 by default, 200 + body with `Prefer: return=representation` |
| `GET /v2/payments/captures/{id}` | `supplementary_data.related_ids` has the order and authorization ids |
| `POST /v2/payments/captures/{id}/refund` | body `amount`, `note_to_payer`; empty body = full refund |
| `GET /v2/payments/refunds/{id}` | `links[rel=up]` points at the capture |

- Authorization statuses: `CREATED`, `CAPTURED`, `DENIED`, `PARTIALLY_CAPTURED`, `VOIDED`, `PENDING`. Capture statuses: `COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`, `REFUNDED`, `FAILED`. Refund statuses: `CANCELLED`, `FAILED`, `PENDING`, `COMPLETED`. (docs)
- Honor period and validity, quoted from the reauthorize description: reauthorize "after its initial three-day honor period expires"; "If 30 days have transpired since the date of the original authorization, you must create an authorized payment instead"; "A reauthorized payment itself has a new honor period of three days"; in the US "up to 115% of the original authorized amount, not to exceed an increase of $75 USD". Nightshift's detectors use 3 days and 29 days; the policy gate forbids anything above min(115%, +$75). (docs)
- The docs contradict themselves on how often you can reauthorize: the description says "multiple", while the `REAUTHORIZATION_TOO_SOON` error text says "only allowed once from Day 4 to Day 29". (docs, contradictory)
- The reauthorize operation is titled for "PayPal account" payments and the error list includes `REAUTHORIZATION_NOT_SUPPORTED_FOR_PAYMENT_SOURCE`. Card authorizations seeded by the lab will probably be refused. Nightshift records PayPal's answer as it is and escalates to the owner; it never retries a refused money movement on its own. (unverified)
- Error bodies: `name`, `message`, `debug_id`, `details[].issue`, `details[].description`. Nightshift stores the whole body and shows `debug_id` in the audit trail. (docs)

## Idempotency

Source: [idempotency](https://developer.paypal.com/api/rest/reference/idempotency.md).

- Repeating a POST with the same `PayPal-Request-Id` returns the latest state of the original request (HTTP 200) instead of repeating it; without the header PayPal duplicates the request. Two concurrent requests with the same id can get 409 `PREVIOUS_REQUEST_IN_PROGRESS`. (docs)
- Retention varies: 6 hours for single-step order create (extendable to 72 hours), 45 days for refunds; other endpoints are not stated. (docs)
- PayPal mentions a 38-character limit for the id. Nightshift's executor uses `ns-` + 32 hex characters of SHA-256(incident, action, target, amount) = 35 characters, the same for every retry of the same action. (docs; key format is ours)

## Negative testing

Source: [request headers for negative testing](https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/).

- Header: `PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}`. Accepted on Orders create/get/authorize/capture and Payments authorization get/capture/void, capture get/refund and refund get. Reauthorize is not in the list. (docs)
- Mocks only produce error responses; they do not create a capture object in a DECLINED or PENDING state. So the "Capture declined after shipping" scenario has the shop's capture call fail with `INSTRUMENT_DECLINED` and Nightshift records the failed call (the only trace, since PayPal creates nothing). (docs)
- Which codes each endpoint really honours is not documented beyond one example. (unverified)

## Invoicing v2

Source: Invoicing v2 schema; [invoicing test and go live](https://developer.paypal.com/invoicing/test-go-live.md).

- Create `POST /v2/invoicing/invoices` (needs `detail.currency_code` and `items`), send `POST .../{id}/send`, remind `POST .../{id}/remind` (204), record an external payment `POST .../{id}/payments` (marks `PARTIALLY_PAID` or `PAID`), list `GET /v2/invoicing/invoices?page&page_size&total_required`, get `GET .../{id}`. (docs)
- The list returns summaries; Nightshift reads open invoices in full to get `payments.paid_amount` and `due_amount`. (docs)
- Reminders: "only 2 reminders in a day" (429 `RATE_LIMIT_REACHED`); the `subject` and `note` you send are not honoured, PayPal uses its own text. Nightshift's policy adds a 72-hour cooldown before another reminder runs without the owner. (docs)
- Whether create returns the invoice or only a link without `Prefer` is unclear; the lab handles both. Whether a past `due_date` is accepted is unclear, so the lab sets the due date to today and the demo clock makes it overdue. Whether a recorded partial payment needs `allow_partial_payment: true` is unclear; the lab sets it. (unverified)

## Transaction Search and balances

Source: Transaction Search v1 schema.

- `GET /v1/reporting/transactions` needs `start_date` and `end_date` (RFC 3339 with seconds, no fractional seconds needed), at most 31 days apart; data can lag up to 3 hours. Nightshift's sweep looks back 3 days and only uses it to discover captures and refunds it hasn't seen. (docs)
- The sandbox app needs the "Transaction search" feature enabled; without it expect a 403. The sweep records the error as a warning on the Settings and Ledger pages. (unverified)

## Webhooks

Source: [webhooks](https://developer.paypal.com/api/rest/webhooks.md), [webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names.md), Webhooks v1 schema.

- Verify every delivery with `POST /v1/notifications/verify-webhook-signature`, sending `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from the `PAYPAL-*` headers), your `webhook_id`, and `webhook_event` "exactly as it was received". Nightshift splices the raw request body into the verification request byte for byte. (docs)
- Verification does not work for events sent from the webhook simulator. (docs)
- Deliveries go only to HTTPS on port 443 and are retried up to 25 times over 3 days. Nightshift dedupes on the event id. Locally you need an HTTPS tunnel; without a webhook the periodic sweep still catches everything, just later. (docs)
- Nightshift subscribes to `PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/DECLINED/DENIED/PENDING/REFUNDED/REVERSED`, `PAYMENT.REFUND.PENDING/FAILED`, `CHECKOUT.ORDER.APPROVED`, `INVOICING.INVOICE.PAID/CANCELLED/UPDATED` and `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`. `DECLINED` is the Payments v2 name; `DENIED` is listed under v1, so both are subscribed. (docs)
- Nightshift never trusts the state in a webhook payload: it re-reads the order, capture or invoice the event names and ingests that.

## Disputes

- `GET /v1/customer/disputes` returns `dispute_id`, `status`, `reason`, `dispute_amount`, `seller_response_due_date`. Missing the seller response date closes the dispute in the buyer's favour. Nightshift has a detector for it; the lab cannot create disputes through the API. (docs)

## PayPal Agent Toolkit

Source: the `@paypal/agent-toolkit` 1.11.0 package source (github.com/paypal/agent-toolkit).

- The `/openai` entry point exposes `getTools()` (chat-completions tool definitions) and `handleToolCall()` (runs a tool, returns `{ role: "tool", content }`). Nightshift uses it for `get_order`, `get_refund`, `get_invoice`, `list_transactions` and `list_disputes` in the agent's read tools. (package source)
- It has no tool for reading an authorization or a capture, so those two go through Nightshift's own REST client. (package source)
- `handleToolCall` does not enforce the configured `actions` and does not validate arguments (ids go straight into URL paths). Nightshift allowlists tool names and validates every argument with zod before calling it. (package source)
- It caches its OAuth token without refreshing it and fixes `list_transactions` date defaults at construction, so Nightshift creates a new toolkit per agent run. (package source)
- With `context.sandbox: true` it calls `https://api.sandbox.paypal.com`. (package source)
- npm lists the licence as ISC; the GitHub repository says Apache-2.0.
