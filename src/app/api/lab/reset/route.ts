// Clears Nightshift's local ledger, incidents and timeline and resets the demo clock.
// Sandbox objects at PayPal are untouched.

import { requireOwner } from "@/lib/owner";
import { store } from "@/lib/db";
import { jsonError, rateLimit } from "@/lib/http";
import { labRunning } from "@/lib/scenarios";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;
  const limited = rateLimit(request, "lab");
  if (limited) return limited;
  const s = store();
  if (labRunning(s)) return jsonError(409, "Wait for the running scenario to finish.");
  s.resetData();
  s.saveSettings({ demoClockOffsetDays: 0 });
  s.addEvent({ incidentId: null, kind: "note", actor: "lab", title: "Local data reset; demo clock back to +0 days", detail: null });
  return Response.json({ ok: true });
}
