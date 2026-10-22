# Progress

One line per milestone: what is done, test status, what is blocked.

- 2026-10-22 Core: config with live-PayPal guard, node:sqlite store, ledger ingest, 6 detector groups (10 incident types), policy gate, idempotent executor. 57 unit tests green. No sandbox.env yet, so everything PayPal-side is built against the typed client and docs.
- 2026-10-22 Agent + watcher + UI: LLM triage loop (OpenAI-compatible, OpenRouter default) with read-only tools via PayPal Agent Toolkit + REST, rule-based fallback, sweep/webhooks/worker, API routes, all product pages, AG Grid tables and AG Studio insights with custom agent/tools/widget/theme. lint, tsc, test and build green. Blocked: live sandbox checks (no sandbox.env).
- 2026-10-22 Tests: 92 green (detectors, table-driven policy gate, executor idempotency incl. lost-response replay, webhook verification with raw body, agent loop with scripted LLM, e2e Run the night on an in-memory PayPal fake). Still no sandbox.env.
- 2026-10-22 Render: Workflows TypeScript SDK (@renderinc/sdk 1.4.0) used for agent runs when RENDER_API_KEY is set; internal callback API; render.yaml (web + disk with inline worker, sweep cron, agent workflow). Docs: README, docs/PAYPAL-NOTES.md, docs/DEMO.md. Production build + `npm start` smoke-tested (all pages 200, SSE, worker via instrumentation, rate limits). 101 tests green. Blueprint and workflow not deployed yet.
- 2026-10-22 Review pass on the money path (independent reviewer): fixed 2xx-with-DECLINED handling, approval-time gate re-check, owner answers no longer mark money "resolved", stuck-action lease + fetch timeouts, OAuth errors returned, webhook verified-retry, idempotency-key collisions on edits; added optional OWNER_PASSCODE. Lab uses the two-step Orders authorize/capture flow for two scenarios. 112 tests, lint, build green.

## Final state (2026-10-22)

**Done and green:** `npm test` (112 tests: detectors, table-driven policy gate, executor idempotency incl. lost-response replay and concurrency, webhook verification with raw body, sweep, agent loop with scripted LLM, AG Studio adapter, Render Workflow callback API, review regressions, end-to-end "Run the night" on an in-memory PayPal fake), `npm run lint` (typegen + ESLint + tsc), `npm run build`. `npm run dev` and `npm start` serve every page (checked in headless Chromium at 1440 px and 390 px; AG Studio dashboard, custom widget and theme render; no console errors besides AG Studio's trial-licence banner).

**Verified live vs mocked:**
- Live: OpenRouter model ids and prices (`/api/v1/models`), npm package APIs (AG Studio 3.0.0 types, PayPal Agent Toolkit 1.11.0 source, Render SDK 1.4.0 types).
- Mocked only (no `sandbox.env` was ever present, so no PayPal sandbox call has been made): every PayPal request/response, the LLM agent (scripted), the AG Studio assistant (mocked stream), Telegram, Render Workflows and the Blueprint.

**Live checks still to run once sandbox credentials exist** (copy `sandbox.env` into `.env.local`, then `npm run seed -- --reset`):
1. Single-step `POST /v2/checkout/orders` with `payment_source.card` and `intent: AUTHORIZE` returns `COMPLETED` with `authorizations[]` (and CAPTURE with `captures[]`); whether the app needs advanced card payments enabled.
2. Two-step flow: create without `payment_source`, then `/authorize` and `/capture` with the card in the body.
3. `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` on authorization capture returns 422 with `details[0].issue`.
4. `CCREJECT-IF` card name on a CAPTURE order returns a DECLINED capture.
5. Reauthorize on a fresh card authorization: which error (`REAUTHORIZATION_TOO_SOON` vs `REAUTHORIZATION_NOT_SUPPORTED_FOR_PAYMENT_SOURCE`).
6. Two refunds on one capture with different request ids both succeed; replay with the same id returns 200 and no second refund.
7. Invoicing: create response shape (object vs link), send, recorded partial payment -> `PARTIALLY_PAID`, remind -> 204, due date today accepted.
8. Transaction Search and balances with the feature enabled (and the 403 without it); 3-hour lag behaviour in the sweep.
9. Webhook creation with an https `PUBLIC_BASE_URL`, a real delivery verified via `verify-webhook-signature` with the raw body.
10. Agent Toolkit read tools against the sandbox (`get_order`, `get_invoice`, `list_transactions`, `get_refund`, `list_disputes`) and a real LLM run through OpenRouter (agent loop and the AG Studio assistant via `/api/ai`).

**Open items:** deploy the Render Blueprint (web + disk, sweep cron, agent workflow) and add the hosted URL to the README; disputes cannot be seeded via the API; no Postgres option; Telegram flow untested against the real Bot API.

## Live sandbox pass (2026-10-22)

Sandbox credentials arrived; every "live checks still to run" item above was run against a real sandbox REST app (Invoicing, Transaction Search, webhooks and disputes scopes, **no card processing**). Findings with debug ids are in [docs/PAYPAL-NOTES.md](docs/PAYPAL-NOTES.md). `npm test` (130 tests), `npm run lint`, `npm run build` green.

| # | Check | Result |
|---|---|---|
| 1 | Single-step card order, AUTHORIZE and CAPTURE | **fixed**: 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` on this app. The lab now tries one card order, then pays through PayPal checkout: `payment_source.paypal` order (200 `PAYER_ACTION_REQUIRED`, `rel: payer-action`), approved by a headless sandbox guest buyer (playwright-core, optional) or by hand via a link in the lab, then authorized or captured. Card success path **still mocked** |
| 2 | Two-step card flow | **fixed**: same refusal, same fallback. Two-step with PayPal-wallet orders (create, approve, `/authorize` or `/capture`) **live-pass**, incl. same-id replay (200) and `ORDER_ALREADY_AUTHORIZED` |
| 3 | `INSTRUMENT_DECLINED` mock on authorization capture | **fixed**: the sandbox ignores it there (403, empty body); `PAYER_CANNOT_PAY` gives a proper 422, now used. Mocks on Orders endpoints honour `INSTRUMENT_DECLINED`. Empty error bodies are described as such |
| 4 | `CCREJECT-IF` card name on a CAPTURE order | **still mocked**: needs card processing; the scenario is skipped (and says why) on apps without it |
| 5 | Reauthorize a fresh authorization | **live-pass**: 422 `REAUTHORIZATION_TOO_SOON` (PayPal-wallet authorization); executor escalates to the owner. Test fake updated. Card variant unverified |
| 6 | Two refunds with different ids, replay with the same id | **live-pass**: both refunds succeed; replay returns 200 with the first refund, nothing new |
| 7 | Invoicing | **fixed / live-pass**: create returns the full invoice (201); back-dated invoices accepted (lab invoices are now overdue for real); partial payment works even without `allow_partial_payment`; full external payment is `MARKED_AS_PAID`; remind returns 200 `{id}`, not 204, and was not rate limited; `generate-next-invoice-number` needs a JSON body (415) |
| 8 | Transaction Search, balances | **live-pass** for the call and the 31-day limit; data lags in steps (`last_refreshed_datetime` 1.5 to 3+ h behind). **Fixed**: balances answers 404 on this account, now "no report" instead of a sweep error every 5 minutes. The 403-without-feature case not checked (feature on) |
| 9 | Webhooks | **live-pass** for create (all 17 event names valid), list, duplicate-URL error, delete, and verify-webhook-signature returning `FAILURE` for forged headers. Real delivery **skipped**: no public https URL |
| 10 | Agent Toolkit read tools and LLM | **live-pass**: `get_order`, `get_refund`, `get_invoice`, `list_transactions`, `list_disputes` via the toolkit, `get_authorization`/`get_capture` via REST. LLM **still mocked**: no `LLM_API_KEY` in the environment, so triage ran rule-based (labelled) and `/api/ai` answers 503 "assistant is off" |
| - | Timestamps | **fixed**: refunds and voids come back as `-07:00` offsets, captures as `Z`; detectors compared strings. Normalised to UTC on ingest |
| - | `npm run seed -- --reset` | **live-pass**: 9 scenarios, 8 ok, 1 skipped (card trigger), about 3 minutes; 9 incidents, $71 captured automatically, refund approval, reauthorize refused and escalated, duplicate charge matched by the same buyer |
| - | "Run the night" in the web app (`npm start`) | **live-pass**: same result with the headless buyer running inside the Next.js server; double-charge refund approved through `/api/actions/{id}` (201 `COMPLETED`, derived idempotency key), second approval refused; manual sweep clean (no errors) |

**Still open:** card-processing path and `CCREJECT` triggers on an app with advanced card payments; webhook delivery with a public URL (deploy or tunnel); a real LLM run (agent loop and AG Studio assistant) with `LLM_API_KEY`; sweep discovery through Transaction Search once the sandbox's reporting data catches up; the headless buyer depends on PayPal's checkout page layout (falls back to the manual link); Render deploy; disputes cannot be seeded; Telegram untested against the real Bot API.
