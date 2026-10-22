// Triage for one incident: diagnosis (LLM agent, or rules when no key is set), then proposals
// through the policy gate and executor (engine.processProposals). The agent never calls a
// money-moving endpoint itself.

import { config } from "../config";
import type { Store } from "../db";
import { INCIDENT_LABELS, type Incident } from "../domain";
import { processProposals, detectorClock } from "../engine";
import { formatMoney } from "../money";
import type { PayPalClient } from "../paypal/client";
import { chatCompletion, type LlmClient } from "./llm";
import { runAgentLoop } from "./loop";
import { ruleBasedTriage, type Triage } from "./rules";
import { ledgerSlice, type ToolkitLike } from "./tools";

export type TriageDeps = {
  store: Store;
  paypal: PayPalClient | null;
  toolkit: ToolkitLike | null;
  /** null = no LLM configured: rule-based triage. */
  llm: LlmClient | null;
  model?: string;
};

export function defaultLlm(): LlmClient | null {
  return config().llm.configured ? chatCompletion : null;
}

/** What the agent is told about the incident. Buyer/shop text is fenced as untrusted. */
export function incidentBrief(store: Store, incident: Incident): string {
  const clock = detectorClock(store);
  const settings = store.settings();
  const order = incident.orderId ? store.getLedger("order", incident.orderId) : null;
  const untrusted = [order?.buyerNote, order?.description].filter(Boolean).join("\n");
  return [
    `Incident ${incident.id}: ${INCIDENT_LABELS[incident.type]}`,
    `Title: ${incident.title}`,
    `Money at risk: ${formatMoney(incident.atRiskCents, incident.currency)}`,
    incident.deadline ? `Deadline: ${incident.deadline}` : "",
    `Subject: ${incident.subject ? `${incident.subject.kind} ${incident.subject.id}` : "none"}`,
    `Detector clock now: ${clock.now().toISOString()}${clock.offsetDays ? ` (demo clock offset +${clock.offsetDays} days; PayPal itself sees real time)` : ""}`,
    `Auto-capture limit: ${formatMoney(settings.autoCaptureMaxCents, incident.currency)}. Autopilot: ${settings.autopilot ? "on" : "off"}.`,
    "",
    `Evidence summary: ${incident.evidence.summary}`,
    `Facts: ${JSON.stringify(incident.evidence.facts)}`,
    `PayPal ids: ${incident.evidence.refs.map((r) => `${r.kind} ${r.id}`).join(", ")}`,
    untrusted ? `\nOrder text from the shop/buyer:\n<untrusted>\n${untrusted.slice(0, 800)}\n</untrusted>` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Records a diagnosis and runs its proposals through the gate. Shared by inline and Render Workflow runs. */
export async function applyTriage(
  store: Store,
  paypal: PayPalClient | null,
  incidentId: string,
  triage: Triage | null,
  source: "llm" | "rules",
  model: string | null,
): Promise<Incident | null> {
  const incident = store.getIncident(incidentId);
  if (!incident) return null;
  let final = triage;
  let finalSource = source;
  if (!final) {
    final = ruleBasedTriage(incident);
    finalSource = "rules";
  }
  if (final.proposals.length === 0) {
    final.proposals.push({ type: "ask_owner", note: "The agent found nothing to do. Close this incident?", rationale: "No action proposed." });
  }
  store.updateIncident(incidentId, { diagnosis: final.diagnosis, diagnosisSource: finalSource, model: finalSource === "llm" ? model : null });
  store.addEvent({
    incidentId,
    kind: "diagnosis",
    actor: finalSource === "llm" ? "agent" : "system",
    title: finalSource === "llm" ? "Agent diagnosis" : "Rule-based diagnosis",
    detail: { text: final.diagnosis, confidence: final.confidence, model: finalSource === "llm" ? model : null },
  });
  await processProposals(store, paypal, incidentId, final.proposals, finalSource === "llm" ? "agent" : "rules");
  return store.getIncident(incidentId);
}

/**
 * Triage one open incident end to end, in this process. Safe to call concurrently: the incident
 * is claimed atomically.
 */
export async function triageIncident(deps: TriageDeps, incidentId: string): Promise<Incident | null> {
  const { store } = deps;
  if (!store.claimIncident(incidentId, ["open"], "triaging")) return store.getIncident(incidentId);
  const incident = store.getIncident(incidentId)!;
  const model = deps.model ?? config().llm.model;
  store.addEvent({
    incidentId,
    kind: "agent_step",
    actor: "agent",
    title: deps.llm ? "Agent started triage" : "Rule-based triage (no LLM key configured)",
    detail: { model: deps.llm ? model : null, runner: "inline" },
  });

  let triage: Triage | null = null;
  if (deps.llm) {
    try {
      triage = await runAgentLoop({
        brief: incidentBrief(store, incident),
        llm: deps.llm,
        model,
        paypal: deps.paypal,
        toolkit: deps.toolkit,
        ledgerLookup: async (orderId) => ledgerSlice(store.ledger(), orderId),
        emit: (kind, title, detail) => {
          store.addEvent({ incidentId, kind, actor: "agent", title, detail });
        },
      });
      if (!triage) {
        store.addEvent({ incidentId, kind: "note", actor: "system", title: "Agent did not submit a triage; using the rule-based fallback", detail: null });
      }
    } catch (error) {
      store.addEvent({ incidentId, kind: "note", actor: "system", title: "LLM call failed; using the rule-based fallback", detail: { error: String(error).slice(0, 300) } });
    }
  }
  return applyTriage(store, deps.paypal, incidentId, triage, triage ? "llm" : "rules", triage ? model : null);
}
