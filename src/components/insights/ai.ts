// AG Studio Agent Framework setup: Studio's built-in agents plus a custom "Nightshift analyst"
// agent with two custom tools. Only the primary agent talks to the user, and the built-in lead's
// delegation list is fixed, so the lead is re-declared with the analyst added to it.

import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgAiTool, type AgStudioApi } from "ag-studio";
import { chatCompletionsAdapter } from "./chat-adapter";

const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: "Costliest incidents", prompt: "Which incidents cost the most this week? Add a widget that shows them." },
  { label: "Why approval?", prompt: "Why did the double charge need my approval instead of being fixed automatically?" },
  { label: "Capture failures", prompt: "Add a chart of capture outcomes, failures highlighted, and tell me the capture failure rate." },
  { label: "Honor countdown", prompt: "Add an authorization countdown for the 3-day honor period." },
];

function policyTool(api: AgStudioApi): AgAiTool {
  return api.defineAiTool({
    name: "get_policy_rules",
    description:
      "Nightshift's current policy gate settings (auto-capture limit, autopilot, warning windows, demo clock offset) and the rules that decide auto / needs approval / forbidden.",
    params: (s) => s.object({}),
    execute: async (_args, ctx) => {
      const res = await fetch("/api/state", { signal: ctx.signal });
      if (!res.ok) return ctx.error("Could not read Nightshift settings.");
      const state = (await res.json()) as { settings: Record<string, unknown> };
      const rules = [
        "capture_authorization: auto only when the order shipped, the amount equals the uncaptured authorization, it is under the auto-capture limit and no earlier capture was declined; above 115% / +$75 or after expiry it is forbidden.",
        "reauthorize_authorization: auto up to the original amount; more needs approval; above 115% / +$75 forbidden.",
        "send_invoice_reminder: auto unless a reminder went out inside the cooldown.",
        "void_authorization and refund_capture: always need the owner; refunds above what is left on the capture are forbidden.",
        "Anything not on the allowlist, or on an object not in the ledger, is forbidden. The LLM never calls PayPal's money-moving endpoints.",
      ];
      return ctx.success(`Settings: ${JSON.stringify(state.settings)}\nRules:\n- ${rules.join("\n- ")}`, state.settings);
    },
  });
}

function incidentTool(api: AgStudioApi): AgAiTool {
  return api.defineAiTool({
    name: "get_incident_story",
    description: "The full story of one incident: the agent's diagnosis, each proposed action, the policy decision with reasons and what PayPal returned.",
    params: (s) => s.object({ incident_id: s.string({ description: "Incident id, e.g. inc_1a2b3c4d5e6f (field incidents.id)" }) }),
    execute: async (args, ctx) => {
      const res = await fetch(`/api/incidents/${encodeURIComponent(args.incident_id)}`, { signal: ctx.signal });
      if (!res.ok) return ctx.error(`No incident ${args.incident_id}.`);
      const body = (await res.json()) as {
        incident: { title: string; type: string; status: string; diagnosis: string | null; atRiskCents: number; savedCents: number };
        actions: { type: string; decision: string; status: string; reasons: string[]; amountCents: number | null; response: { status: number } | null }[];
      };
      const lines = [
        `${body.incident.title} (${body.incident.type}, ${body.incident.status}). At risk $${(body.incident.atRiskCents / 100).toFixed(2)}, protected $${(body.incident.savedCents / 100).toFixed(2)}.`,
        `Diagnosis: ${body.incident.diagnosis ?? "pending"}`,
        ...body.actions.map(
          (a) =>
            `- ${a.type}${a.amountCents ? ` $${(a.amountCents / 100).toFixed(2)}` : ""}: policy ${a.decision} (${a.reasons.join(" ")}); status ${a.status}${a.response ? `, PayPal HTTP ${a.response.status}` : ""}`,
        ),
      ];
      return ctx.success(lines.join("\n"), body);
    },
  });
}

const ANALYST_INSTRUCTIONS = `You are the Nightshift analyst for a small coffee roaster that sells through PayPal.
You answer questions about incidents (money problems Nightshift detected), what they cost, and why the policy gate decided what it did.
- Use execute_query on the incidents, actions, authorizations, captures, captureOutcomes and refunds tables for numbers. "Cost" means Money At Risk (atRisk); "still open" means openAtRisk.
- Use get_incident_story for the reasoning behind one incident and get_policy_rules for the rules.
- When the owner asks to see something, add a widget with add_widget (bar charts for rankings, value widgets for totals, grids for lists) with a clear title.
- The auth-countdown widget shows live authorization deadlines.
- Answer in two to four plain sentences with concrete dollar amounts. No jargon.`;

export function buildAi(model: string): AgAiHarnessSetup {
  const adapter = chatCompletionsAdapter({ endpoint: "/api/ai", model });

  return ({ api }) =>
    createAiHarness(api, ({ builtIn }) => {
      const analyst = directLlmRunner({
        id: "nightshift-analyst",
        name: "Nightshift analyst",
        description:
          "Answers questions about Nightshift incidents, money at risk or protected, capture failures, refunds and policy decisions, and builds widgets that show them.",
        schema: (s) => s.undefined(),
        instructions: () => ANALYST_INSTRUCTIONS,
        tools: ({ studio }) => [studio.viewSchema(), studio.viewPage(), studio.executeQuery(), studio.addWidget(), policyTool(api), incidentTool(api)],
        maxTurns: 24,
        adapter,
      });
      const lead = directLlmRunner({
        ...builtIn.lead,
        adapter,
        tools: ({ studio, tools: t }) => [
          studio.viewSchema(),
          studio.viewReport(),
          studio.viewPage(),
          t.plan.view(),
          t.plan.update(),
          t.plan.clear(),
          t.renameThread(),
          t.delegateTo(["data", "widget", "page", "planning", "nightshift-analyst"]),
        ],
        instructions: (ctx, params) =>
          `${builtIn.lead.instructions?.(ctx, params) ?? ""}\n\n## Nightshift\nDelegate questions about incidents, money at risk or protected, capture failures, refunds, approvals or why the policy gate decided something to nightshift-analyst. It can also add widgets for those answers.`,
      });
      const others = (["data", "page", "planning", "widget"] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter }));
      return { agents: [lead, ...others, analyst], primary: "lead", promptStarters: PROMPT_STARTERS };
    });
}
