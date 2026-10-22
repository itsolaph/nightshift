# Progress

One line per milestone: what is done, test status, what is blocked.

- 2026-10-22 Core: config with live-PayPal guard, node:sqlite store, ledger ingest, 6 detector groups (10 incident types), policy gate, idempotent executor. 57 unit tests green. No sandbox.env yet, so everything PayPal-side is built against the typed client and docs.
- 2026-10-22 Agent + watcher + UI: LLM triage loop (OpenAI-compatible, OpenRouter default) with read-only tools via PayPal Agent Toolkit + REST, rule-based fallback, sweep/webhooks/worker, API routes, all product pages, AG Grid tables and AG Studio insights with custom agent/tools/widget/theme. lint, tsc, test and build green. Blocked: live sandbox checks (no sandbox.env).
- 2026-10-22 Tests: 92 green (detectors, table-driven policy gate, executor idempotency incl. lost-response replay, webhook verification with raw body, agent loop with scripted LLM, e2e Run the night on an in-memory PayPal fake). Still no sandbox.env.
