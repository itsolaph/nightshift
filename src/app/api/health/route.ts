import { store } from "@/lib/db";
import { connections } from "@/lib/summary";

export const dynamic = "force-dynamic";

export function GET() {
  const c = connections(store());
  return Response.json({ ok: true, paypal: c.paypal, llm: c.llm, worker: c.workerMode });
}
