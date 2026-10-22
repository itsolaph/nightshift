// Callback API for agent runs on Render Workflows (workflows/index.ts). Bearer INTERNAL_API_TOKEN.
// The task reads the brief and ledger slices, streams its steps into the timeline, and hands back
// its diagnosis and proposals. The policy gate and executor run here, never in the task.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "@/lib/config";
import { store } from "@/lib/db";
import { jsonError, readJson } from "@/lib/http";
import { paypal } from "@/lib/paypal/client";
import { applyTriage, incidentBrief } from "@/lib/agent/triage";
import { ledgerSlice } from "@/lib/agent/tools";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  if (!token) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const Proposal = z.object({
  type: z.string().max(64),
  targetId: z.string().max(64).nullish(),
  amountCents: z.number().int().nullish(),
  currency: z.string().max(3).nullish(),
  note: z.string().max(500).nullish(),
  rationale: z.string().max(600),
});

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("event"), kind: z.enum(["agent_step", "agent_tool", "note"]), title: z.string().max(200), detail: z.unknown() }),
  z.object({ op: z.literal("ledger"), orderId: z.string().max(40) }),
  z.object({
    op: z.literal("result"),
    model: z.string().max(100),
    triage: z.object({ diagnosis: z.string().max(2000), confidence: z.enum(["high", "medium", "low"]), proposals: z.array(Proposal).max(5) }).nullable(),
    error: z.string().max(500).optional(),
  }),
]);

export async function GET(request: Request, ctx: RouteContext<"/api/internal/agent/[id]">) {
  if (!authorized(request)) return jsonError(401, "Unauthorized");
  const { id } = await ctx.params;
  const s = store();
  const incident = s.getIncident(id);
  if (!incident) return jsonError(404, "Unknown incident");
  return Response.json({ incidentId: id, status: incident.status, brief: incidentBrief(s, incident), model: config().llm.model });
}

export async function POST(request: Request, ctx: RouteContext<"/api/internal/agent/[id]">) {
  if (!authorized(request)) return jsonError(401, "Unauthorized");
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, "Bad body");
  const s = store();
  const incident = s.getIncident(id);
  if (!incident) return jsonError(404, "Unknown incident");
  const body = parsed.data;

  if (body.op === "ledger") return Response.json(ledgerSlice(s.ledger(), body.orderId));
  if (body.op === "event") {
    s.addEvent({ incidentId: id, kind: body.kind, actor: body.kind === "note" ? "system" : "agent", title: body.title, detail: body.detail ?? null });
    return Response.json({ ok: true });
  }
  if (incident.status !== "triaging" || incident.diagnosis) return jsonError(409, "Incident is no longer waiting for this run");
  if (body.error) s.addEvent({ incidentId: id, kind: "note", actor: "system", title: "Agent run failed on Render Workflows; using the rule-based fallback", detail: { error: body.error } });
  const updated = await applyTriage(s, paypal(), id, body.triage, body.triage ? "llm" : "rules", body.triage ? body.model : null);
  return Response.json({ status: updated?.status });
}
