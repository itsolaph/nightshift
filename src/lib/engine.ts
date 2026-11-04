// Wires the pieces together: proposals from the agent go through the policy gate, cleared actions
// go to the executor, everything else waits in the approvals inbox. Also the owner's approve /
// reject / edit-amount path, which re-runs the gate on the edited action.

import { randomUUID } from "node:crypto";
import type { Store } from "./db";
import { ACTION_LABELS, type ActionRecord, type ActionType, type Incident, type ProposedAction } from "./domain";
import { executeAction, idempotencyKey } from "./executor";
import { evaluate, subjectSettled } from "./policy/gate";
import { makeClock } from "./clock";
import type { PayPalClient } from "./paypal/client";
import { formatMoney } from "./money";
import { notifyApprovalNeeded } from "./telegram";

export function detectorClock(store: Store) {
  return makeClock(store.settings().demoClockOffsetDays);
}

const label = (type: string) => ACTION_LABELS[type as ActionType] ?? type;

/** Gate, record and (when cleared) execute each proposal. Returns the stored action records. */
export async function processProposals(
  store: Store,
  client: PayPalClient | null,
  incidentId: string,
  proposals: ProposedAction[],
  proposedBy: ActionRecord["proposedBy"],
): Promise<ActionRecord[]> {
  const records: ActionRecord[] = [];
  for (const proposal of proposals) {
    const incident = store.getIncident(incidentId);
    if (!incident) break;
    const gate = evaluate({
      proposal,
      incident,
      ledger: store.ledger(),
      settings: store.settings(),
      now: detectorClock(store).now(),
    });
    const key = idempotencyKey(incident.id, gate.action.type, gate.action.targetId, gate.action.amountCents);
    const existing = store.findActionByKey(key);
    if (existing) {
      records.push(existing);
      continue;
    }
    const at = new Date().toISOString();
    const status: ActionRecord["status"] =
      gate.decision === "auto" ? "approved" : gate.decision === "needs_approval" ? "awaiting_approval" : "blocked";
    const record = store.insertAction({
      id: `act_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      incidentId: incident.id,
      type: gate.action.type,
      targetId: gate.action.targetId,
      amountCents: gate.action.amountCents,
      currency: gate.action.currency,
      note: gate.action.note,
      rationale: proposal.rationale,
      proposedBy,
      decision: gate.decision,
      reasons: gate.reasons,
      status,
      idempotencyKey: key,
      call: gate.call,
      response: null,
      createdAt: at,
      updatedAt: at,
      decidedBy: gate.decision === "auto" ? "policy" : null,
    });
    store.addEvent({
      incidentId: incident.id,
      kind: "proposal",
      actor: proposedBy === "agent" ? "agent" : "system",
      title: `${proposedBy === "agent" ? "Agent" : "Rules"} proposed: ${label(record.type)}${
        record.amountCents ? ` ${formatMoney(record.amountCents, record.currency ?? incident.currency)}` : ""
      }`,
      detail: { actionId: record.id, rationale: proposal.rationale, targetId: record.targetId, note: record.note },
    });
    store.addEvent({
      incidentId: incident.id,
      kind: "policy",
      actor: "policy",
      title:
        gate.decision === "auto"
          ? "Policy said: auto-execute"
          : gate.decision === "needs_approval"
            ? "Policy said: needs the owner's approval"
            : "Policy said: forbidden",
      detail: { actionId: record.id, decision: gate.decision, reasons: gate.reasons, call: gate.call },
    });
    records.push(record);
  }

  for (const record of records) {
    if (record.status === "approved") await executeAction(store, client, record.id, "policy");
  }
  settleIncident(store, incidentId);
  const waiting = store.listActions(incidentId).filter((a) => a.status === "awaiting_approval");
  for (const action of waiting) void notifyApprovalNeeded(store, action);
  return records.map((r) => store.getAction(r.id)!);
}

/** Works out the incident status from its actions after a round of proposals or approvals. */
export function settleIncident(store: Store, incidentId: string): Incident | null {
  const incident = store.getIncident(incidentId);
  if (!incident || incident.status === "resolved" || incident.status === "dismissed") return incident;
  const actions = store.listActions(incidentId);
  if (actions.some((a) => a.status === "awaiting_approval")) {
    return store.updateIncident(incidentId, { status: "awaiting_approval" });
  }
  if (actions.some((a) => a.status === "executing" || a.status === "approved")) return incident;
  if (actions.length > 0 && actions.every((a) => a.status === "blocked")) {
    // Everything the agent proposed was forbidden: a human has to look.
    const key = idempotencyKey(incidentId, "ask_owner", "gate", null);
    if (!store.findActionByKey(key)) {
      const at = new Date().toISOString();
      store.insertAction({
        id: `act_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        incidentId,
        type: "ask_owner",
        targetId: null,
        amountCents: null,
        currency: null,
        note: "The policy gate blocked every action the agent proposed. Please decide what to do.",
        rationale: "Nothing the agent proposed was allowed.",
        proposedBy: "rules",
        decision: "needs_approval",
        reasons: ["All proposals were forbidden."],
        status: "awaiting_approval",
        idempotencyKey: key,
        call: null,
        response: null,
        createdAt: at,
        updatedAt: at,
        decidedBy: null,
      });
    }
    return store.updateIncident(incidentId, { status: "awaiting_approval" });
  }
  if (actions.some((a) => a.status === "succeeded" || (a.status === "done" && a.type === "mark_resolved"))) {
    return store.updateIncident(incidentId, { status: "resolved" });
  }
  if (actions.some((a) => a.status === "done" && a.type === "ask_owner")) {
    // The owner answered. That closes the question, not necessarily the money problem.
    const settled = incident.atRiskCents === 0 || subjectSettled(incident, store.ledger());
    if (!settled) {
      store.addEvent({
        incidentId,
        kind: "outcome",
        actor: "system",
        title: `Closed by the owner; ${formatMoney(incident.atRiskCents, incident.currency)} still at risk`,
        detail: null,
      });
    }
    return store.updateIncident(incidentId, { status: settled ? "resolved" : "dismissed" });
  }
  if (actions.some((a) => a.status === "failed")) return store.updateIncident(incidentId, { status: "failed" });
  return incident;
}

export type ApprovalDecision =
  | { kind: "approve"; amountCents?: number; by: string }
  | { kind: "reject"; reason?: string; by: string }
  | { kind: "answer"; reply: string; by: string };

export class ApprovalError extends Error {}

/** Honest audit actor: a judge session is not the owner. */
const who = (by: string) => (by.startsWith("judge") ? ({ actor: "judge", name: "Judge" } as const) : ({ actor: "owner", name: "Owner" } as const));

/** The owner's decision on an action waiting in the inbox. */
export async function decideAction(
  store: Store,
  client: PayPalClient | null,
  actionId: string,
  decision: ApprovalDecision,
): Promise<ActionRecord> {
  const action = store.getAction(actionId);
  if (!action) throw new ApprovalError("Unknown action.");
  if (action.status !== "awaiting_approval") throw new ApprovalError(`This action is already ${action.status}.`);
  const incident = store.getIncident(action.incidentId);
  if (!incident) throw new ApprovalError("Unknown incident.");

  if (decision.kind === "reject") {
    const rejected = store.claimAction(actionId, ["awaiting_approval"], "rejected", { decidedBy: decision.by });
    if (!rejected) throw new ApprovalError("Someone else decided first.");
    store.addEvent({
      incidentId: incident.id,
      kind: "approval",
      actor: who(decision.by).actor,
      title: `${who(decision.by).name} rejected: ${label(action.type)}`,
      detail: { actionId, reason: decision.reason ?? null, by: decision.by },
    });
    const remaining = store.listActions(incident.id).filter((a) => a.status === "awaiting_approval");
    if (remaining.length === 0) {
      const anyDone = store.listActions(incident.id).some((a) => a.status === "succeeded" || a.status === "done");
      store.updateIncident(incident.id, { status: anyDone ? "resolved" : "dismissed" });
    }
    return rejected;
  }

  if (decision.kind === "answer" || action.type === "ask_owner") {
    const reply = decision.kind === "answer" ? decision.reply : "Approved.";
    const done = store.claimAction(actionId, ["awaiting_approval"], "done", {
      decidedBy: decision.by,
      response: { status: 200, body: { reply }, debugId: null },
    });
    if (!done) throw new ApprovalError("Someone else decided first.");
    store.addEvent({
      incidentId: incident.id,
      kind: "approval",
      actor: "owner",
      title: "Owner answered the agent",
      detail: { actionId, reply, by: decision.by },
    });
    settleIncident(store, incident.id);
    return done;
  }

  // Approve, possibly with an edited amount. The gate re-checks every approval against the ledger
  // as it is now (the authorization may have expired or been captured since, or the incident may
  // be closed). The owner may approve what needs approval, never what is forbidden.
  const amountCents = decision.amountCents ?? action.amountCents;
  const gate = evaluate({
    proposal: {
      type: action.type,
      targetId: action.targetId,
      amountCents,
      currency: action.currency,
      note: action.note,
      rationale: action.rationale,
    },
    incident,
    ledger: store.ledger(),
    settings: store.settings(),
    now: detectorClock(store).now(),
  });
  if (gate.decision === "forbidden") {
    if (decision.amountCents === undefined || decision.amountCents === action.amountCents) {
      // The world changed since the proposal: take it out of the inbox.
      store.claimAction(actionId, ["awaiting_approval"], "blocked", { reasons: [...action.reasons, ...gate.reasons], decidedBy: "policy (re-check)" });
      store.addEvent({ incidentId: incident.id, kind: "policy", actor: "policy", title: "Policy re-check at approval: forbidden", detail: { actionId, reasons: gate.reasons } });
      settleIncident(store, incident.id);
    }
    throw new ApprovalError(`Policy forbids this now: ${gate.reasons.join(" ")}`);
  }
  let toRun = action;
  if (gate.action.amountCents !== action.amountCents) {
    const key = idempotencyKey(incident.id, action.type, action.targetId, gate.action.amountCents);
    const clash = store.findActionByKey(key);
    if (clash && clash.id !== action.id) throw new ApprovalError(`An action for that exact amount already exists (${clash.status}).`);
    toRun = store.updateAction(actionId, {
      amountCents: gate.action.amountCents,
      call: gate.call,
      reasons: [...gate.reasons, `Amount edited by the owner from ${formatMoney(action.amountCents ?? 0, action.currency ?? "USD")}.`],
      idempotencyKey: key,
    });
  } else {
    toRun = store.updateAction(actionId, { call: gate.call });
  }
  const approved = store.claimAction(toRun.id, ["awaiting_approval"], "approved", { decidedBy: decision.by });
  if (!approved) throw new ApprovalError("Someone else decided first.");
  store.addEvent({
    incidentId: incident.id,
    kind: "approval",
    actor: who(decision.by).actor,
    title: `${who(decision.by).name} approved: ${label(approved.type)}${
      approved.amountCents ? ` ${formatMoney(approved.amountCents, approved.currency ?? incident.currency)}` : ""
    }`,
    detail: { actionId, by: decision.by },
  });
  const { action: result } = await executeAction(store, client, approved.id, decision.by);
  settleIncident(store, incident.id);
  return result;
}
