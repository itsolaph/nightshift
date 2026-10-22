// The agent's tools. All of them are read-only: they look things up in PayPal or in Nightshift's
// ledger. The only "write" the agent has is `submit_triage`, which hands proposals to the policy
// gate; nothing here can move money.
//
// PayPal reads go through the official PayPal Agent Toolkit (@paypal/agent-toolkit) where it has
// the endpoint (orders, invoices, refunds, transactions, disputes). It has no tool for reading an
// authorization or a capture, so those two use Nightshift's own REST client. Tool names are
// allowlisted and arguments validated here, because the toolkit's handleToolCall dispatches any
// tool name it is given and puts ids into URL paths unchecked.

import { z } from "zod";
import type { Store } from "../db";
import { ACTION_TYPES } from "../domain";
import type { PayPalClient } from "../paypal/client";
import type { ChatTool, ToolCall } from "./llm";

const PAYPAL_ID = z.string().regex(/^[A-Za-z0-9-]{5,40}$/, "not a PayPal id");

/** The subset of the toolkit's surface Nightshift uses; tests pass a fake. */
export type ToolkitLike = {
  handleToolCall(call: ToolCall): Promise<{ content: unknown }>;
};

export type ToolContext = {
  store: Store;
  paypal: PayPalClient | null;
  toolkit: ToolkitLike | null;
};

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  args: z.ZodType;
  source: "agent-toolkit" | "nightshift-rest" | "ledger";
  needsPayPal: boolean;
  run: (args: never, ctx: ToolContext) => Promise<unknown>;
};

const idParam = (name: string, description: string) => ({
  type: "object",
  properties: { [name]: { type: "string", description } },
  required: [name],
  additionalProperties: false,
});

async function viaToolkit(ctx: ToolContext, name: string, args: unknown) {
  if (!ctx.toolkit) return { error: "PayPal is not connected" };
  const message = await ctx.toolkit.handleToolCall({
    id: `ns_${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  try {
    return JSON.parse(content);
  } catch {
    return { raw: content };
  }
}

async function viaRest<T>(ctx: ToolContext, fn: (client: PayPalClient) => Promise<{ ok: boolean; status: number; body: T }>) {
  if (!ctx.paypal) return { error: "PayPal is not connected" };
  const result = await fn(ctx.paypal);
  return result.ok ? result.body : { error: `PayPal returned ${result.status}`, body: result.body };
}

const TOOLS: ToolDef[] = [
  {
    name: "get_order",
    description: "Read a PayPal order (Orders v2), including its authorizations, captures and refunds.",
    parameters: idParam("id", "PayPal order id"),
    args: z.object({ id: PAYPAL_ID }),
    source: "agent-toolkit",
    needsPayPal: true,
    run: (args: { id: string }, ctx) => viaToolkit(ctx, "get_order", args),
  },
  {
    name: "get_authorization",
    description: "Read a PayPal authorization (Payments v2): status, amount, expiration_time.",
    parameters: idParam("authorization_id", "PayPal authorization id"),
    args: z.object({ authorization_id: PAYPAL_ID }),
    source: "nightshift-rest",
    needsPayPal: true,
    run: (args: { authorization_id: string }, ctx) => viaRest(ctx, (c) => c.getAuthorization(args.authorization_id)),
  },
  {
    name: "get_capture",
    description: "Read a PayPal capture (Payments v2): status, status_details, amount, related order and authorization.",
    parameters: idParam("capture_id", "PayPal capture id"),
    args: z.object({ capture_id: PAYPAL_ID }),
    source: "nightshift-rest",
    needsPayPal: true,
    run: (args: { capture_id: string }, ctx) => viaRest(ctx, (c) => c.getCapture(args.capture_id)),
  },
  {
    name: "get_refund",
    description: "Read a PayPal refund (Payments v2).",
    parameters: idParam("refund_id", "PayPal refund id"),
    args: z.object({ refund_id: PAYPAL_ID }),
    source: "agent-toolkit",
    needsPayPal: true,
    run: (args: { refund_id: string }, ctx) => viaToolkit(ctx, "get_refund", args),
  },
  {
    name: "get_invoice",
    description: "Read a PayPal invoice (Invoicing v2): status, due date, amount, payments.",
    parameters: idParam("invoice_id", "PayPal invoice id, like INV2-XXXX-XXXX-XXXX-XXXX"),
    args: z.object({ invoice_id: PAYPAL_ID }),
    source: "agent-toolkit",
    needsPayPal: true,
    run: (args: { invoice_id: string }, ctx) => viaToolkit(ctx, "get_invoice", args),
  },
  {
    name: "list_transactions",
    description:
      "Search the merchant's PayPal transaction history (Transaction Search). New activity can take up to 3 hours to appear, so an empty result does not prove a payment is missing.",
    parameters: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Optional transaction (capture/refund) id to look up" },
        start_date: { type: "string", description: "ISO 8601 date-time without fractional seconds" },
        end_date: { type: "string", description: "ISO 8601 date-time without fractional seconds, at most 31 days after start_date" },
      },
      additionalProperties: false,
    },
    args: z.object({
      transaction_id: PAYPAL_ID.optional(),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).optional(),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).optional(),
    }),
    source: "agent-toolkit",
    needsPayPal: true,
    run: (args: Record<string, string>, ctx) => {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
      const noMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
      return viaToolkit(ctx, "list_transactions", {
        start_date: noMs(start),
        end_date: noMs(end),
        search_months: 1,
        ...args,
      });
    },
  },
  {
    name: "list_disputes",
    description: "List the merchant's PayPal disputes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    args: z.object({}),
    source: "agent-toolkit",
    needsPayPal: true,
    run: (_args: Record<string, never>, ctx) => viaToolkit(ctx, "list_disputes", { page_size: 10 }),
  },
  {
    name: "ledger_lookup",
    description:
      "Read Nightshift's own ledger for an order: the shop's fulfilment status (shipped or not), every authorization, capture, refund and failed capture attempt Nightshift knows about. Use this for anything PayPal does not store, like whether the goods shipped.",
    parameters: idParam("order_id", "PayPal order id"),
    args: z.object({ order_id: PAYPAL_ID }),
    source: "ledger",
    needsPayPal: false,
    run: async (args: { order_id: string }, ctx) => {
      const ledger = ctx.store.ledger();
      const order = ledger.orders.find((o) => o.id === args.order_id);
      if (!order) return { error: `Order ${args.order_id} is not in the ledger` };
      const { buyerNote, ...rest } = order;
      return {
        order: rest,
        buyer_note_untrusted: buyerNote ?? null,
        authorizations: ledger.authorizations.filter((a) => a.orderId === order.id),
        captures: ledger.captures.filter((c) => c.orderId === order.id),
        refunds: ledger.refunds.filter((r) => r.orderId === order.id),
        failed_capture_attempts: ledger.captureAttempts.filter((a) => a.orderId === order.id && !a.ok),
      };
    },
  },
];

export const SUBMIT_TRIAGE = "submit_triage";

const submitParameters = {
  type: "object",
  properties: {
    diagnosis: {
      type: "string",
      description: "2 to 4 plain-English sentences for a shop owner who is not a payments expert: what happened, how much money, what happens if nobody acts.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    proposals: {
      type: "array",
      description: "The actions you recommend, in order. The policy gate decides which run automatically.",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTION_TYPES] },
          target_id: {
            type: ["string", "null"],
            description: "Authorization id for capture/reauthorize/void, capture id for refund, invoice id for reminders, null otherwise.",
          },
          amount: { type: ["string", "null"], description: 'Decimal amount like "42.00", or null for the default (full remaining amount).' },
          note: { type: ["string", "null"], description: "For ask_owner: the question. Otherwise an optional note to the payer." },
          rationale: { type: "string", description: "One sentence: why this action." },
        },
        required: ["action", "target_id", "amount", "note", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["diagnosis", "confidence", "proposals"],
  additionalProperties: false,
};

export const submitTriageArgs = z.object({
  diagnosis: z.string().min(1).max(2000),
  confidence: z.enum(["high", "medium", "low"]).catch("medium"),
  proposals: z
    .array(
      z.object({
        action: z.string().max(64),
        target_id: z.string().max(64).nullish(),
        amount: z.union([z.string(), z.number()]).nullish(),
        note: z.string().max(500).nullish(),
        rationale: z.string().max(600).catch(""),
      }),
    )
    .max(5),
});

export function toolDefinitions(ctx: Pick<ToolContext, "paypal" | "toolkit">): ChatTool[] {
  const available = TOOLS.filter((t) => !t.needsPayPal || ctx.paypal || ctx.toolkit);
  return [
    ...available.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    {
      type: "function" as const,
      function: {
        name: SUBMIT_TRIAGE,
        description: "Finish: submit your diagnosis and proposed actions. Call exactly once, after reading the evidence.",
        parameters: submitParameters,
      },
    },
  ];
}

export const READ_TOOL_NAMES = TOOLS.map((t) => t.name);

export function toolSource(name: string) {
  return TOOLS.find((t) => t.name === name)?.source ?? null;
}

const MAX_RESULT_CHARS = 6000;

/** Runs a read tool after allowlist and argument checks. Never throws; errors go back to the model. */
export async function runReadTool(call: ToolCall, ctx: ToolContext): Promise<{ result: unknown; text: string; ok: boolean }> {
  const tool = TOOLS.find((t) => t.name === call.function.name);
  if (!tool) {
    const result = { error: `Tool ${call.function.name} is not available. Read tools only; propose actions via submit_triage.` };
    return { result, text: JSON.stringify(result), ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    const result = { error: "Arguments were not valid JSON" };
    return { result, text: JSON.stringify(result), ok: false };
  }
  const parsed = tool.args.safeParse(raw);
  if (!parsed.success) {
    const result = { error: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    return { result, text: JSON.stringify(result), ok: false };
  }
  try {
    const result = await tool.run(parsed.data as never, ctx);
    let text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}... (truncated)`;
    const ok = !(result && typeof result === "object" && "error" in result);
    return { result, text, ok };
  } catch (error) {
    const result = { error: `Tool failed: ${String(error).slice(0, 200)}` };
    return { result, text: JSON.stringify(result), ok: false };
  }
}
