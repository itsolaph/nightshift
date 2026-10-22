// PayPal webhook listener. Every delivery is verified with
// POST /v1/notifications/verify-webhook-signature before Nightshift acts on it; unverified events
// are stored for the audit trail and otherwise ignored.

import { after } from "next/server";
import { store } from "@/lib/db";
import { paypal } from "@/lib/paypal/client";
import { verifyWebhook, webhookId } from "@/lib/paypal/webhooks";
import type { WebhookEvent } from "@/lib/paypal/types";
import { handleWebhookEvent } from "@/lib/watcher";
import { detectAndTriage } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 512_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!event?.id || !event.event_type) return Response.json({ error: "Not a PayPal webhook event" }, { status: 400 });

  const s = store();
  const client = paypal();
  const verification = await verifyWebhook(client, request.headers, raw, webhookId(s));
  const fresh = s.recordWebhook(event.id, event.event_type, verification.verified, event);

  if (!verification.verified) {
    s.addEvent({
      incidentId: null,
      kind: "note",
      actor: "watcher",
      title: `Ignored unverified webhook ${event.event_type}`,
      detail: { eventId: event.id, reason: verification.reason },
    });
    return Response.json({ verified: false, reason: verification.reason }, { status: 400 });
  }
  if (!fresh) return Response.json({ verified: true, duplicate: true });

  after(async () => {
    const outcome = await handleWebhookEvent(s, client, event);
    s.addEvent({
      incidentId: null,
      kind: "note",
      actor: "watcher",
      title: `Webhook ${event.event_type}: ${outcome}`,
      detail: { eventId: event.id, resourceId: event.resource?.id ?? null },
    });
    await detectAndTriage(s);
  });
  return Response.json({ verified: true });
}
