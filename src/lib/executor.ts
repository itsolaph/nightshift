// The executor: the only code that calls money-moving PayPal endpoints. It runs an action only
// after the policy gate said `auto` or the owner approved it, claims it atomically so it runs once,
// and sends a PayPal-Request-Id derived from incident + action so even a retried HTTP call can
// never move money twice.

import { createHash } from "node:crypto";
import type { Store } from "./db";
import type { ActionRecord, Incident } from "./domain";
import { applyPayPalResult, recordCaptureAttempt } from "./ledger";
import { describeError, type PayPalClient } from "./paypal/client";
import { formatMoney } from "./money";

/** Deterministic PayPal-Request-Id for an action. Same incident + action + target + amount = same key. */
export function idempotencyKey(
  incidentId: string,
  type: string,
  targetId: string | null,
  amountCents: number | null,
): string {
  const digest = createHash("sha256")
    .update([incidentId, type, targetId ?? "-", amountCents ?? "-"].join("|"))
    .digest("hex")
    .slice(0, 32);
  // PayPal mentions a 38-character limit for request ids: "ns-" + 32 hex = 35.
  return `ns-${digest}`;
}

/** Money an action recovers or protects when it succeeds, for the "money saved" totals. */
function savedBy(action: ActionRecord): number {
  switch (action.type) {
    case "capture_authorization":
    case "reauthorize_authorization":
    case "refund_capture":
      return action.amountCents ?? 0;
    default:
      return 0;
  }
}

export type ExecuteResult = { action: ActionRecord; executed: boolean };

export async function executeAction(
  store: Store,
  client: PayPalClient | null,
  actionId: string,
  actor: string = "policy",
): Promise<ExecuteResult> {
  const claimed = store.claimAction(actionId, ["approved"], "executing");
  if (!claimed) {
    // Already executed, running elsewhere, rejected or still waiting for approval.
    return { action: store.getAction(actionId)!, executed: false };
  }
  const action = claimed;
  const incident = store.getIncident(action.incidentId);

  // Actions with no PayPal call: closing an incident, or the owner's answer to a question.
  if (!action.call) {
    const done = store.updateAction(action.id, { status: "done" });
    if (incident && action.type === "mark_resolved") {
      store.updateIncident(incident.id, { status: "resolved" });
      store.addEvent({
        incidentId: incident.id,
        kind: "outcome",
        actor: "executor",
        title: "Incident closed",
        detail: { note: action.note, by: actor },
      });
    }
    return { action: done, executed: true };
  }

  if (!client) {
    const failed = store.updateAction(action.id, {
      status: "failed",
      response: { status: 0, body: { message: "PayPal is not connected" }, debugId: null },
    });
    store.addEvent({
      incidentId: action.incidentId,
      kind: "outcome",
      actor: "executor",
      title: "Not executed: PayPal sandbox credentials are missing",
      detail: { actionId: action.id },
    });
    return { action: failed, executed: false };
  }

  store.addEvent({
    incidentId: action.incidentId,
    kind: "paypal_call",
    actor: "executor",
    title: `${action.call.method} ${action.call.path}`,
    detail: { actionId: action.id, requestId: action.idempotencyKey, body: action.call.body ?? null, approvedBy: actor },
  });

  const result = await client.request(action.call.method, action.call.path, {
    body: action.call.body ?? (action.call.method === "POST" ? {} : undefined),
    requestId: action.idempotencyKey,
  });

  const response = { status: result.status, body: result.body, debugId: result.debugId };
  const error = result.ok ? null : describeError(result.body);
  store.addEvent({
    incidentId: action.incidentId,
    kind: "paypal_response",
    actor: "paypal",
    title: result.ok ? `PayPal returned ${result.status}` : `PayPal refused: ${result.status} ${error?.message ?? ""}`.trim(),
    detail: { actionId: action.id, ...response, durationMs: result.durationMs },
  });

  if (action.type === "capture_authorization" && action.targetId) {
    const auth = store.getLedger("authorization", action.targetId);
    if (auth) recordCaptureAttempt(store, { orderId: auth.orderId, authorizationId: auth.id, result, source: "nightshift" });
  }

  if (!result.ok) {
    const failed = store.updateAction(action.id, { status: "failed", response });
    if (incident) escalateAfterFailure(store, incident, failed, error?.message ?? `HTTP ${result.status}`);
    return { action: failed, executed: true };
  }

  if (action.targetId) applyPayPalResult(store, action.type, action.targetId, result.body);
  const succeeded = store.updateAction(action.id, { status: "succeeded", response });
  if (incident) {
    const saved = savedBy(succeeded);
    const updated = store.updateIncident(incident.id, { savedCents: incident.savedCents + saved });
    const open = store.listActions(incident.id).some((a) => a.status === "awaiting_approval");
    if (!open) store.updateIncident(incident.id, { status: "resolved" });
    store.addEvent({
      incidentId: incident.id,
      kind: "outcome",
      actor: "executor",
      title: saved > 0 ? `${formatMoney(saved, succeeded.currency ?? updated.currency)} protected` : "Done",
      detail: { actionId: succeeded.id, type: succeeded.type },
    });
  }
  return { action: succeeded, executed: true };
}

/** A PayPal refusal turns into a question for the owner rather than a silent failure. */
function escalateAfterFailure(store: Store, incident: Incident, failed: ActionRecord, message: string) {
  const key = idempotencyKey(incident.id, "ask_owner", failed.id, null);
  if (!store.findActionByKey(key)) {
    const now = new Date().toISOString();
    store.insertAction({
      id: `act_${key.slice(-12)}`,
      incidentId: incident.id,
      type: "ask_owner",
      targetId: failed.id,
      amountCents: null,
      currency: null,
      note: `PayPal refused "${failed.type}" (${message}). Nightshift will not retry a refused money movement on its own. What should happen next?`,
      rationale: "Executor escalation after a PayPal error.",
      proposedBy: "rules",
      decision: "needs_approval",
      reasons: ["PayPal refused the previous action."],
      status: "awaiting_approval",
      idempotencyKey: key,
      call: null,
      response: null,
      createdAt: now,
      updatedAt: now,
      decidedBy: null,
    });
  }
  store.updateIncident(incident.id, { status: "awaiting_approval" });
  store.addEvent({
    incidentId: incident.id,
    kind: "approval",
    actor: "executor",
    title: "Escalated to the owner after PayPal refused the action",
    detail: { actionId: failed.id, message },
  });
}
