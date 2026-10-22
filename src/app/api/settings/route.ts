import { z } from "zod";
import { store } from "@/lib/db";
import { jsonError, rateLimit, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const Patch = z
  .object({
    demoClockOffsetDays: z.number().int().min(0).max(60),
    autopilot: z.boolean(),
    autoCaptureMaxCents: z.number().int().min(0).max(10_000_000),
    honorWarningHours: z.number().int().min(1).max(72),
    expiryWarningDays: z.number().int().min(1).max(14),
    uncapturedAfterHours: z.number().int().min(1).max(168),
    duplicateWindowMinutes: z.number().int().min(1).max(1440),
    refundSpikeRate: z.number().min(0.05).max(1),
    refundSpikeMinCount: z.number().int().min(2).max(100),
    invoiceReminderCooldownHours: z.number().int().min(1).max(720),
  })
  .partial()
  .strict();

export function GET() {
  return Response.json(store().settings());
}

export async function POST(request: Request) {
  const limited = rateLimit(request, "mutate");
  if (limited) return limited;
  const parsed = Patch.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const s = store();
  const before = s.settings();
  const after = s.saveSettings(parsed.data);
  const changed = Object.keys(parsed.data).filter((k) => before[k as keyof typeof before] !== after[k as keyof typeof after]);
  if (changed.length) {
    s.addEvent({
      incidentId: null,
      kind: "note",
      actor: "owner",
      title: `Settings changed: ${changed.join(", ")}`,
      detail: Object.fromEntries(changed.map((k) => [k, { from: before[k as keyof typeof before], to: after[k as keyof typeof after] }])),
    });
  }
  return Response.json(after);
}
