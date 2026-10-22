import { store } from "@/lib/db";
import { connections, summary } from "@/lib/summary";
import { labRunning } from "@/lib/scenarios";

export const dynamic = "force-dynamic";

export function GET() {
  const s = store();
  return Response.json({ summary: summary(s), connections: connections(s), settings: s.settings(), lab: labRunning(s) });
}
