// Where agent runs happen. Inline by default: the worker calls triageIncident in its own process.

import type { Store } from "./db";
import { paypal } from "./paypal/client";
import { createReadOnlyToolkit } from "./agent/toolkit";
import { defaultLlm, triageIncident, type TriageDeps } from "./agent/triage";

export async function triageDeps(store: Store): Promise<TriageDeps> {
  return { store, paypal: paypal(), toolkit: await createReadOnlyToolkit(), llm: defaultLlm() };
}

export async function dispatchTriage(store: Store, incidentId: string) {
  return triageIncident(await triageDeps(store), incidentId);
}
