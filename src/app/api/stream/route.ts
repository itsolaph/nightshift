// Server-sent events: the timeline as it is written. The UI uses this to show the agent thinking,
// the policy deciding and PayPal answering, live. Polls SQLite, so it also sees events written by a
// worker running in another process.

import { store } from "@/lib/db";

export const dynamic = "force-dynamic";

const POLL_MS = 600;
const MAX_LIFETIME_MS = 5 * 60_000; // EventSource reconnects on its own

export function GET(request: Request) {
  const url = new URL(request.url);
  const lastEventId = Number(request.headers.get("last-event-id") ?? url.searchParams.get("since") ?? NaN);
  const incidentId = url.searchParams.get("incident");
  const s = store();
  let since = Number.isFinite(lastEventId) ? lastEventId : s.lastSeq();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const started = Date.now();
      let lastBeat = Date.now();
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      send(`retry: 2000\n: connected\n\n`);
      timer = setInterval(() => {
        if (request.signal.aborted || Date.now() - started > MAX_LIFETIME_MS) return stop();
        const events = s.eventsSince(since, 100);
        for (const event of events) {
          since = event.seq;
          if (incidentId && event.incidentId !== incidentId) continue;
          send(`id: ${event.seq}\nevent: timeline\ndata: ${JSON.stringify(event)}\n\n`);
        }
        if (Date.now() - lastBeat > 15_000) {
          lastBeat = Date.now();
          send(`: keep-alive\n\n`);
        }
      }, POLL_MS);
      request.signal.addEventListener("abort", stop);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
