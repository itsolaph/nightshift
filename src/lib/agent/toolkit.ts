// Creates the PayPal Agent Toolkit with read-only actions enabled. A new instance per agent run:
// the toolkit caches its OAuth token without refreshing it, and bakes date defaults into the
// list_transactions schema when constructed.

import { assertSandboxOnly, config } from "../config";
import type { ToolkitLike } from "./tools";

const READ_ONLY_ACTIONS = {
  orders: { get: true },
  invoices: { list: true, get: true },
  payments: { getRefunds: true },
  transactions: { list: true },
  disputes: { list: true, get: true },
};

export async function createReadOnlyToolkit(): Promise<ToolkitLike | null> {
  assertSandboxOnly();
  const { paypal } = config();
  if (!paypal.configured) return null;
  try {
    const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/openai");
    const toolkit = new PayPalAgentToolkit({
      clientId: paypal.clientId,
      clientSecret: paypal.clientSecret,
      configuration: { actions: READ_ONLY_ACTIONS, context: { sandbox: true } },
    });
    return {
      handleToolCall: (call) => toolkit.handleToolCall(call),
    };
  } catch (error) {
    console.warn("[agent] PayPal Agent Toolkit unavailable, falling back to REST reads:", String(error));
    return null;
  }
}
