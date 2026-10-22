// The owner (or the shop) marks an order shipped or cancelled. PayPal has no fulfilment state for
// an authorize-then-capture order, so Nightshift's ledger keeps it.

import { z } from "zod";
import { store } from "@/lib/db";
import { jsonError, rateLimit, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({ fulfillment: z.enum(["unfulfilled", "shipped", "cancelled"]) });

export async function POST(request: Request, ctx: RouteContext<"/api/orders/[id]/fulfillment">) {
  const limited = rateLimit(request, "mutate");
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, "Expected { fulfillment }");
  const s = store();
  const order = s.getLedger("order", id);
  if (!order) return jsonError(404, "Order not in the ledger");
  const shippedAt = parsed.data.fulfillment === "shipped" ? (order.shippedAt ?? new Date().toISOString()) : null;
  s.putLedger("order", { ...order, fulfillment: parsed.data.fulfillment, shippedAt, updatedAt: new Date().toISOString() });
  s.addEvent({ incidentId: null, kind: "note", actor: "owner", title: `Order ${id} marked ${parsed.data.fulfillment}`, detail: null });
  return Response.json({ ok: true });
}
