// Where agent runs happen.
//
//   inline           (default) the worker runs the agent loop in its own process
//   render-workflow  when RENDER_API_KEY, RENDER_WORKFLOW_SLUG and INTERNAL_API_TOKEN are set: each
//                    triage starts a Render Workflows task (workflows/index.ts) on separate compute.
//                    The task gets the brief from this service, runs the LLM with read-only PayPal
//                    tools, and posts the proposals back. The policy gate and executor always run
//                    here, next to the ledger: the workflow task has no way to move money.

import type { Store } from "./db";
import { paypal } from "./paypal/client";
import { createReadOnlyToolkit } from "./agent/toolkit";
import { applyTriage, defaultLlm, triageIncident, type TriageDeps } from "./agent/triage";

export async function triageDeps(store: Store): Promise<TriageDeps> {
  return { store, paypal: paypal(), toolkit: await createReadOnlyToolkit(), llm: defaultLlm() };
}

export function renderWorkflowConfig() {
  const apiKey = process.env.RENDER_API_KEY?.trim();
  const slug = process.env.RENDER_WORKFLOW_SLUG?.trim();
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  return apiKey && slug && token ? { apiKey, slug, token } : null;
}

/** Remote runs that never report back fall back to rules after this long. */
export const REMOTE_TIMEOUT_MS = 10 * 60_000;

export async function dispatchTriage(store: Store, incidentId: string) {
  const remote = renderWorkflowConfig();
  if (!remote || !defaultLlm()) return triageIncident(await triageDeps(store), incidentId);

  if (!store.claimIncident(incidentId, ["open"], "triaging")) return store.getIncident(incidentId);
  try {
    const { Render } = await import("@renderinc/sdk");
    const render = new Render({ token: remote.apiKey });
    const run = await render.workflows.startTask(`${remote.slug}/triageIncident`, [incidentId], { idempotencyKey: `triage-${incidentId}` });
    store.addEvent({
      incidentId,
      kind: "agent_step",
      actor: "agent",
      title: "Agent run started on Render Workflows",
      detail: { runner: "render-workflow", task: `${remote.slug}/triageIncident`, taskRunId: run.taskRunId ?? null },
    });
  } catch (error) {
    store.addEvent({
      incidentId,
      kind: "note",
      actor: "system",
      title: "Could not start the Render Workflow task; running the agent here instead",
      detail: { error: String(error).slice(0, 300) },
    });
    store.updateIncident(incidentId, { status: "open" });
    return triageIncident(await triageDeps(store), incidentId);
  }
  return store.getIncident(incidentId);
}

/** Incidents stuck in "triaging" (a remote run that died) get the rule-based triage. */
export async function recoverStuckTriage(store: Store) {
  for (const incident of store.listIncidents()) {
    if (incident.status !== "triaging" || incident.diagnosis) continue;
    if (Date.now() - new Date(incident.updatedAt).getTime() < REMOTE_TIMEOUT_MS) continue;
    store.addEvent({ incidentId: incident.id, kind: "note", actor: "system", title: "Agent run did not report back; using the rule-based fallback", detail: null });
    await applyTriage(store, paypal(), incident.id, null, "rules", null);
  }
}
