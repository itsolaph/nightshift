# PayPal notes

What Nightshift relies on, where it comes from, and what the sandbox actually did. Docs researched October 2026; live checks run against a real sandbox REST app on 2026-10-22. The `developer.paypal.com/api/<api>/<version>.md` pages point to the OpenAPI schemas (`/api/<api>/<version>/schema.json`) as the authoritative source, so most field-level facts come from those.

Status legend: **docs** = read in PayPal's documentation or schema; **sandbox** = confirmed with a live sandbox call; **unverified** = not documented clearly and not checked live yet (tracked in [PROGRESS.md](../PROGRESS.md)).

The sandbox app used for the live checks had Invoicing, Transaction Search, webhooks and disputes scopes, but **no card processing**. Several answers below depend on that; another app can behave differently.

## Environment

- Base URL `https://api-m.sandbox.paypal.com`. Nightshift refuses to start with `PAYPAL_ENV` set to anything but `sandbox`, and the client has the sandbox host hard-coded. (code)
- OAuth2 client credentials: `POST /v1/oauth2/token`, Basic auth, `grant_type=client_credentials`. The token came back with `expires_in` of about 9 hours. Nightshift caches it until a minute before expiry and refreshes once on a 401. (sandbox)
- HATEOAS links in responses point at `api.sandbox.paypal.com` (without `-m`); both hosts serve the API. (sandbox)

## Orders v2

Source: Orders v2 schema; [Orders advanced use cases](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced.md); [card testing](https://developer.paypal.com/api/rest/sandbox/card-testing/).

- **Card payments need card processing on the app.** `POST /v2/checkout/orders` with `payment_source.card` (single step, `AUTHORIZE` or `CAPTURE`) and the two-step flow (create without a source, then `/authorize` or `/capture` with the card) both returned 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` ("Payee account is not setup to be able to process card payments"). Debug ids `ca4e769c24894`, `ca4e769d419d8`. Creating the order without a payment source still works (201 `CREATED`). (sandbox)
- A create with `payment_source` and no `PayPal-Request-Id` gets 400 `PAYPAL_REQUEST_ID_REQUIRED`, checked before the card-processing check. The lab always sends one. (sandbox)
- What Nightshift does about it: the lab tries one card order; on `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` it switches to PayPal-wallet orders for the rest of the run ([sandbox-buyer.ts](../src/lib/sandbox-buyer.ts)). Untested on an app with card processing: the single-step `AUTHORIZE` response shape, and `CCREJECT-*` card-name triggers. (unverified)
- **PayPal-wallet orders.** Create with `payment_source.paypal.experience_context` (`user_action: CONTINUE`, `shipping_preference: NO_SHIPPING`, `return_url`, `cancel_url`) returns **HTTP 200** (not 201) with `status: PAYER_ACTION_REQUIRED` and a link with `rel: "payer-action"` (not `approve`) to `https://www.sandbox.paypal.com/checkoutnow?token=<order id>`. An order created without a source has `rel: "approve"` instead. (sandbox)
- **Buyer approval without a personal account.** The sandbox checkout page offers "Pay with Credit or Debit Card" (guest checkout). Filled in headless Chromium with a US address and a freshly generated Luhn-valid `4032...` test number, it redirects to `return_url?token=<order id>&PayerID=...` and the order becomes `APPROVED`. About 15 to 30 seconds per order. The well-known test number 4012888888881881 was refused there ("We weren't able to add this card"). The same guest email and a new card can approve a second order (the lab's double charge uses this). The page layout is A/B tested (a "save info and create account" switch is on in one variant), and `networkidle` sometimes never arrives, so the lab waits for `load`. A token whose approvals failed several times ended on a generic error page. (sandbox)
- `POST /v2/checkout/orders/{id}/authorize` on an unapproved order: 422 `ORDER_NOT_APPROVED`. On an approved order: 201, order `COMPLETED`, `purchase_units[0].payments.authorizations[0]` with `status: CREATED`, `expiration_time` = create time + 29 days exactly. Replaying the same `PayPal-Request-Id`: 200 with the same order and authorization. A second authorize with a new id: 422 `ORDER_ALREADY_AUTHORIZED`. (sandbox)
- `POST .../capture` on an approved `CAPTURE` order: 201, order `COMPLETED`, `captures[0].status: COMPLETED` with `seller_receivable_breakdown` (fees on these orders: 3.9% + $0.30). (sandbox)
- Approved PayPal-wallet orders carry `payer.email_address` and `payment_source.paypal.account_status: UNVERIFIED` for guest buyers; Nightshift uses the email as the ledger's payer. The soft descriptor sent with the order was replaced by the account's default. (sandbox)
- `Prefer: return=representation` returns the full resource on create, authorize and capture. (sandbox)
- PayPal has no endpoint to list orders. Orders enter Nightshift's ledger from the shop (`POST /api/ingest/orders`), from webhooks, from Transaction Search, or from the scenario lab. (docs)

## Payments v2

Source: Payments v2 schema (operation descriptions, examples and the `x-errors` list), plus the live calls below.

| Call | What the sandbox did |
|---|---|
| `GET /v2/payments/authorizations/{id}` | 200; `supplementary_data.related_ids.order_id` present (sandbox) |
| `POST .../authorizations/{id}/capture` | 201 new capture; same request id again: 200 with the same capture; a new request id after capture: 422 `AUTHORIZATION_ALREADY_CAPTURED`; above 115% of the order: 422 `MAX_CAPTURE_AMOUNT_EXCEEDED`; on a voided authorization: 422 `AUTHORIZATION_VOIDED` (sandbox) |
| `POST .../authorizations/{id}/reauthorize` | fresh authorization (minutes old), with or without `amount`: 422 `REAUTHORIZATION_TOO_SOON`, "only allowed once from Day 4 to Day 29" (sandbox) |
| `POST .../authorizations/{id}/void` | 200 with the voided authorization under `Prefer: return=representation` (sandbox) |
| `GET /v2/payments/captures/{id}` | 200; `related_ids` has both the order and the authorization; status `PARTIALLY_REFUNDED` after a partial refund (sandbox) |
| `POST .../captures/{id}/refund` | 201; two refunds of $5 with different request ids both succeed (`total_refunded_amount` 10.00); the first request id replayed: 200 with the first refund, no third refund; more than the remaining amount: 422 `REFUND_AMOUNT_EXCEEDED` (sandbox) |
| `GET /v2/payments/refunds/{id}` | 200 (sandbox) |

- **Timestamp formats are mixed.** Authorizations and captures use `2026-10-22T09:30:44Z`; refunds and the void response use `2026-10-22T02:30:46-07:00`. Nightshift normalises every timestamp to UTC on ingest, because detectors sort and compare them as strings. (sandbox)
- Honor period and validity, quoted from the reauthorize description: reauthorize "after its initial three-day honor period expires"; "If 30 days have transpired since the date of the original authorization, you must create an authorized payment instead"; "A reauthorized payment itself has a new honor period of three days"; in the US "up to 115% of the original authorized amount, not to exceed an increase of $75 USD". Nightshift's detectors use 3 days and 29 days; the policy gate forbids anything above min(115%, +$75). (docs)
- The `REAUTHORIZATION_TOO_SOON` text the sandbox returns says reauthorization is allowed **once**, between day 4 and day 29; the operation description says "multiple". (sandbox, contradicts docs)
- Because the demo clock only moves Nightshift's clock, the "honor period lapsed" incident's automatic reauthorize really reaches PayPal and is refused with `REAUTHORIZATION_TOO_SOON`; the executor records it and asks the owner. Whether card authorizations get `REAUTHORIZATION_NOT_SUPPORTED_FOR_PAYMENT_SOURCE` instead could not be checked (no card processing). (sandbox / unverified for cards)
- Error bodies: `name`, `message`, `debug_id`, `details[].issue`, `details[].description`, plus an `information_link` link. Nightshift stores the whole body and shows the `paypal-debug-id` header in the audit trail. (sandbox)

## Idempotency

Source: [idempotency](https://developer.paypal.com/api/rest/reference/idempotency.md), plus live replays.

- Repeating a POST with the same `PayPal-Request-Id` returns the original result with HTTP 200 instead of 201 and moves no money. Confirmed for order authorize, authorization capture and capture refund. Without the header (or with a new id) PayPal does it again, as the duplicate-refund scenario shows. (sandbox)
- Two concurrent requests with the same id can get 409 `PREVIOUS_REQUEST_IN_PROGRESS`; retention is 6 hours for single-step order create (extendable to 72), 45 days for refunds. (docs)
- Nightshift's executor uses `ns-` + 32 hex characters of SHA-256(incident, action, target, amount) = 35 characters (PayPal mentions a 38-character limit). A live refund approved from the inbox went out with its key; approving it again is refused by Nightshift before any call. (sandbox; key format is ours)

## Negative testing

Source: [request headers for negative testing](https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/), plus live calls.

- Header: `PayPal-Mock-Response: {"mock_application_codes": "<CODE>"}`. A mocked answer short-circuits the real checks: `INSTRUMENT_DECLINED` on `/authorize` or `/capture` of an order nobody approved still returns 422 `INSTRUMENT_DECLINED`. The body's `debug_id` is canned (the same value across calls); the `paypal-debug-id` response header is real. (sandbox)
- **Which codes an endpoint honours varies.** On `POST /v2/payments/authorizations/{id}/capture`: `PAYER_CANNOT_PAY`, `TRANSACTION_REFUSED`, `PAYEE_ACCOUNT_RESTRICTED` and `AUTHORIZATION_EXPIRED` return a proper 422; `INSTRUMENT_DECLINED`, `DECLINED_DUE_TO_RELATED_TXN`, `PAYER_ACCOUNT_RESTRICTED`, `CARD_EXPIRED`, `PREVIOUSLY_CAPTURED` and `INTERNAL_SERVICE_ERROR` return **403 with an empty body**. A mock on `GET` of an authorization also returned 403 with no body. `REAUTHORIZATION_TOO_SOON` on reauthorize and `REFUND_FAILED_INSUFFICIENT_FUNDS` on refund return 422. (sandbox)
- So the "Capture declined after shipping" scenario mocks `PAYER_CANNOT_PAY` on the shop's capture, and the client describes an empty error body as such instead of "Unknown error". (code)
- Mocks only produce error responses; PayPal creates nothing, so a failed capture call leaves no capture object. Nightshift records the failed call itself. A mocked capture left the authorization `CREATED`. (sandbox)

## Invoicing v2

Source: Invoicing v2 schema; [invoicing test and go live](https://developer.paypal.com/invoicing/test-go-live.md); live calls.

- Create `POST /v2/invoicing/invoices` with `Prefer: return=representation`: 201 with the whole invoice (`status: DRAFT`, `id` like `INV2-Y7VY-8PBU-CLFH-KXHU`). With `return=minimal`: 201 with only links. The lab handles both. (sandbox)
- **Back-dated invoices are accepted**: `invoice_date` 20 days ago and `due_date` 6 days ago created and sent fine. The lab now creates invoices that are already 3 days overdue. (sandbox)
- Send: 200 with links; sending again: 422 `INVOICE_ALREADY_SENT`. (sandbox)
- Record an external payment (`POST .../payments`): 200 `{ payment_id: "EXTR-..." }`; a partial amount makes the invoice `PARTIALLY_PAID` with `payments.paid_amount` and `due_amount`, **even without** `allow_partial_payment`. Paying the rest makes it `MARKED_AS_PAID` (not `PAID`). (sandbox)
- **Remind returns 200 `{ "id": "<invoice id>" }`**, not the documented 204. Three reminders in a row on the same invoice all succeeded, so the documented "2 reminders a day" limit did not apply in the sandbox; Nightshift keeps its own 72-hour cooldown. (sandbox)
- Cancel (`POST .../cancel`) works on `SENT` invoices and returns 422 on `PARTIALLY_PAID` ones. (sandbox)
- `POST /v2/invoicing/generate-next-invoice-number` without a body: 415 `UNSUPPORTED_MEDIA_TYPE`; with `{}`: 200. (sandbox)
- The list returns summaries that already include `payments.paid_amount` and `due_amount`; Nightshift still reads open invoices in full. (sandbox)

## Transaction Search and balances

Source: Transaction Search v1 schema; live calls.

- `GET /v1/reporting/transactions` worked with the feature enabled. A range over 31 days: 400 `INVALID_REQUEST`, "Date range is greater than 31 days". Fractional seconds in the dates were accepted too. (sandbox)
- **The data lags in steps.** The response clamps `end_date` to `last_refreshed_datetime`, which was 06:59:59Z at 09:19Z and 08:29:59Z at 10:05Z, so new captures stay invisible for one and a half to three hours or more. The 403 without the feature could not be checked (it was enabled). (sandbox)
- `GET /v1/reporting/balances` answered **404 NOT_FOUND** with every parameter combination tried (`currency_code=ALL`, `USD`, none, `as_of_time`). The sweep now treats 404 as "no balance report for this account" instead of logging an error every 5 minutes. (sandbox)
- The response includes the merchant's `account_number`; Nightshift does not store or display it.

## Webhooks

Source: [webhooks](https://developer.paypal.com/api/rest/webhooks.md), [webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names.md), Webhooks v1 schema; live calls.

- `POST /v1/notifications/webhooks` with Nightshift's 17 event types: 201; every name was accepted, including both `PAYMENT.CAPTURE.DECLINED` and `PAYMENT.CAPTURE.DENIED`. A second webhook for the same URL: 400 `WEBHOOK_URL_ALREADY_EXISTS` (Nightshift looks for an existing one first). `DELETE` returns 204. (sandbox; the test webhook pointed at an example.com URL and was deleted right after)
- `POST /v1/notifications/verify-webhook-signature` with made-up headers: 200 `{ "verification_status": "FAILURE" }`, also for a `cert_url` on a foreign host. Nightshift only accepts `SUCCESS`. (sandbox)
- A real delivery verified with the raw body was **not** tested: there was no public https URL for this run. (unverified)
- Verify every delivery with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, your `webhook_id` and the event "exactly as it was received"; Nightshift splices the raw body into the verification request byte for byte. Verification does not work for simulator events. Deliveries go only to HTTPS on 443 and are retried up to 25 times over 3 days. (docs)
- Nightshift never trusts the state in a webhook payload: it re-reads the order, capture or invoice the event names and ingests that.

## Disputes

- `GET /v1/customer/disputes`: 200 with an empty `items` list on the sandbox app. Disputes cannot be created through the API, so the dispute detector is only tested against fixtures. (sandbox / docs)

## PayPal Agent Toolkit

Source: the `@paypal/agent-toolkit` 1.11.0 package source (github.com/paypal/agent-toolkit), plus live calls through Nightshift's tool wrapper.

- `get_order`, `get_refund`, `get_invoice`, `list_transactions` and `list_disputes` all returned real sandbox objects through `handleToolCall` with `context.sandbox: true` (which calls `api.sandbox.paypal.com`). (sandbox)
- `list_transactions` with a `transaction_id` that is too recent for Transaction Search answers `{ found: false, ... "not found in the last 1 months" }`; the agent's tool description warns that an empty result does not prove a payment is missing. The toolkit repeats query parameters in its request URL (`start_date=...&start_date=...`); PayPal accepts it. (sandbox)
- It has no tool for reading an authorization or a capture, so `get_authorization` and `get_capture` use Nightshift's REST client; both worked live. (sandbox)
- `handleToolCall` does not enforce the configured `actions` and does not validate arguments (ids go straight into URL paths). Nightshift allowlists tool names and validates every argument with zod before calling it. (package source)
- It caches its OAuth token without refreshing it and fixes `list_transactions` date defaults at construction, so Nightshift creates a new toolkit per agent run. (package source)
- npm lists the licence as ISC; the GitHub repository says Apache-2.0.
