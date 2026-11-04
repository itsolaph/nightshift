// Scenario lab (sandbox only): seeds real sandbox objects. Rate limited per IP.

import { ownerRequired } from "@/lib/owner";
import { callerRole } from "@/lib/judge";
import { z } from "zod";
import { store } from "@/lib/db";
import { jsonError, rateLimit, readJson } from "@/lib/http";
import { paypal } from "@/lib/paypal/client";
import { labLogger, labRunning, runSingleScenario, runTheNight, scenarioById } from "@/lib/scenarios";

export const dynamic = "force-dynamic";

const Body = z.object({ scenario: z.string().max(64) });

export async function POST(request: Request) {
  const role = callerRole(request);
  if (!role) return ownerRequired();
  const limited = rateLimit(request, "lab");
  if (limited) return limited;
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, "Expected { scenario }");
  if (role === "judge" && parsed.data.scenario !== "night") return jsonError(403, "The judge demo may only run the night.");
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
  void runSingleScenario(s, client, scenario, runId).catch((error) => labLogger(s, runId)(`Scenario failed: ${String(error)}`));
  return Response.json({ runId, started: scenario.id }, { status: 202 });
}
