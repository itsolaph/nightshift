// Runs one watcher cycle now: sweep PayPal, detect, triage. Used by the UI's "Sweep now" button and
// by the Render cron job (Authorization: Bearer CRON_SECRET).

import { config } from "@/lib/config";
import { store } from "@/lib/db";
import { rateLimit } from "@/lib/http";
import { runCycle } from "@/lib/worker";
import { requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = config().cronSecret;
  const fromCron = Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
  if (!fromCron) {
    const denied = requireOwner(request);
    if (denied) return denied;
    const limited = rateLimit(request, "sweep");
    if (limited) return limited;
  }
  const s = store();
  await runCycle(s, { forceSweep: true });
  return Response.json({ ok: true, lastSweep: s.getKv("sweep:last") });
}
