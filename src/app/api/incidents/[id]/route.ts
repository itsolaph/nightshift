import { store } from "@/lib/db";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/incidents/[id]">) {
  const { id } = await ctx.params;
  const s = store();
  const incident = s.getIncident(id);
  if (!incident) return jsonError(404, "Unknown incident");
  return Response.json({ incident, actions: s.listActions(id), timeline: s.incidentEvents(id) });
}
