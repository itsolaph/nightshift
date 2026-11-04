// The owner's decision on an action in the approvals inbox: approve (optionally with an edited
// amount), reject, or answer the agent's question. The policy gate re-checks edited amounts.

import { ownerRequired } from "@/lib/owner";
import { JUDGE_ACTOR, callerRole } from "@/lib/judge";
import { z } from "zod";
import { store } from "@/lib/db";
import { ApprovalError, decideAction } from "@/lib/engine";
import { jsonError, rateLimit, readJson } from "@/lib/http";
import { paypal } from "@/lib/paypal/client";
import { toCents } from "@/lib/money";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional() }),
  z.object({ decision: z.literal("reject"), reason: z.string().max(300).optional() }),
  z.object({ decision: z.literal("answer"), reply: z.string().min(1).max(1000) }),
]);

export async function POST(request: Request, ctx: RouteContext<"/api/actions/[id]">) {
  const role = callerRole(request);
  if (!role) return ownerRequired();
  const limited = rateLimit(request, "mutate");
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, "Expected { decision: approve | reject | answer }");
  const body = parsed.data;
  const by = role === "judge" ? JUDGE_ACTOR : "owner (web)";
  if (role === "judge" && (body.decision === "answer" || (body.decision === "approve" && body.amount !== undefined))) {
    return jsonError(403, "The judge demo may only approve or reject as proposed.");
  }
  try {
    const action = await decideAction(
      store(),
      paypal(),
      id,
      body.decision === "approve"
        ? { kind: "approve", amountCents: body.amount ? toCents(body.amount) : undefined, by }
        : body.decision === "reject"
          ? { kind: "reject", reason: body.reason, by }
          : { kind: "answer", reply: body.reply, by },
    );
    return Response.json({ action });
  } catch (error) {
    if (error instanceof ApprovalError) return jsonError(409, error.message);
    throw error;
  }
}
