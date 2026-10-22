// Scenario lab (sandbox only): seeds real sandbox objects. Rate limited per IP.

import { requireOwner } from "@/lib/owner";
import { z } from "zod";
import { store } from "@/lib/db";
import { jsonError, rateLimit, readJson } from "@/lib/http";
import { paypal } from "@/lib/paypal/client";
import { labLogger, labRunning, runScenario, runTheNight, scenarioById } from "@/lib/scenarios";
import { detectAndTriage } from "@/lib/worker";

export const dynamic = "force-dynamic";

const Body = z.object({ scenario: z.string().max(64) });

export async function POST(request: Request) {
  const denied = requireOwner(request);
  if (denied) return denied;
  const limited = rateLimit(request, "lab");
  if (limited) return limited;
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, "Expected { scenario }");
  const client = paypal();
  if (!client) return jsonError(503, "PayPal sandbox credentials are not configured, so the lab cannot create sandbox objects.");
  const s = store();
  if (labRunning(s)) return jsonError(409, "A lab run is already in progress.");

  const runId = `lab_${Date.now().toString(36)}`;
  if (parsed.data.scenario === "night") {
    void runTheNight(s, client, runId).catch((error) => labLogger(s, runId)(`Run the night failed: ${String(error)}`));
    return Response.json({ runId, started: "night" }, { status: 202 });
  }
  const scenario = scenarioById(parsed.data.scenario);
  if (!scenario) return jsonError(404, "Unknown scenario");
  void (async () => {
    const log = labLogger(s, runId);
    s.setKv("lab:running", { runId, startedAt: new Date().toISOString() });
    try {
      const ok = await runScenario({ store: s, client, log, runId }, scenario);
      const settings = s.settings();
      if (ok && settings.demoClockOffsetDays < scenario.clockDays) {
        s.saveSettings({ demoClockOffsetDays: scenario.clockDays });
        log(`Demo clock moved to +${scenario.clockDays} days so the detectors can see this scenario`);
      }
      const triaged = await detectAndTriage(s);
      log(`Watcher ran; ${triaged} incident(s) triaged`);
    } catch (error) {
      log(`Scenario failed: ${String(error)}`);
    } finally {
      s.setKv("lab:running", null);
    }
  })();
  return Response.json({ runId, started: scenario.id }, { status: 202 });
}
