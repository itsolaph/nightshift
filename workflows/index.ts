// Render Workflows entry point (TypeScript SDK, @renderinc/sdk). Registers one task,
// triageIncident, that runs Nightshift's agent loop on its own compute:
//
//   1. GET the incident brief from the web service (internal API, Bearer INTERNAL_API_TOKEN)
//   2. run the LLM with the same read-only tools as inline runs (PayPal Agent Toolkit + REST
//      reads, ledger lookups over the internal API), streaming each step back to the timeline
//   3. POST the diagnosis and proposals back; the web service's policy gate decides and its
//      executor calls PayPal
//
// The task never holds a write path to PayPal: it has no executor and no access to the ledger DB.
// Start command on Render: npx tsx workflows/index.ts

import { task } from "@renderinc/sdk/workflows";
import { config } from "../src/lib/config";
import { chatCompletion } from "../src/lib/agent/llm";
import { runAgentLoop } from "../src/lib/agent/loop";
import { createReadOnlyToolkit } from "../src/lib/agent/toolkit";
import { paypal } from "../src/lib/paypal/client";

// Same-region private network address of the web service (render.yaml sets the host:port), or a URL.
const base = () => {
  const hostport = process.env.NIGHTSHIFT_INTERNAL_HOSTPORT?.trim();
  if (hostport) return `http://${hostport}`;
  return (process.env.NIGHTSHIFT_INTERNAL_URL ?? process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
};

async function call<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN ?? ""}`, "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

task(
  { name: "triageIncident", retry: { maxRetries: 1, waitDurationMs: 5000, backoffScaling: 2 }, timeoutSeconds: 300 },
  async function triageIncident(_ctx, incidentId: string) {
    const path = `/api/internal/agent/${encodeURIComponent(incidentId)}`;
    const { brief, model } = await call<{ brief: string; model: string }>(path);
    const post = (body: unknown) => call(path, { method: "POST", body });
    try {
      config(); // refuses PAYPAL_ENV=live here too
      const triage = await runAgentLoop({
        brief,
        llm: chatCompletion,
        model,
        paypal: paypal(),
        toolkit: await createReadOnlyToolkit(),
        ledgerLookup: (orderId) => post({ op: "ledger", orderId }),
        emit: async (kind, title, detail) => {
          await post({ op: "event", kind, title, detail });
        },
      });
      await post({ op: "result", model, triage });
      return { incidentId, submitted: Boolean(triage) };
    } catch (error) {
      await post({ op: "result", model, triage: null, error: String(error).slice(0, 400) });
      return { incidentId, submitted: false, error: String(error) };
    }
  },
);
