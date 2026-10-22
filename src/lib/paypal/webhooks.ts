// Webhook verification and registration. Every incoming PayPal webhook is checked with
// POST /v1/notifications/verify-webhook-signature before Nightshift acts on it.

import { config } from "../config";
import type { Store } from "../db";
import type { PayPalClient } from "./client";

export const WEBHOOK_HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

export type VerifyResult = { verified: boolean; reason: string };

/** The webhook id to verify against: PAYPAL_WEBHOOK_ID, or the one Nightshift registered at startup. */
export function webhookId(store: Store): string {
  return config().paypal.webhookId || store.getKv<string>("webhook:id") || "";
}

export async function verifyWebhook(
  client: PayPalClient | null,
  headers: Headers,
  rawBody: string,
  id: string,
): Promise<VerifyResult> {
  if (!client) return { verified: false, reason: "PayPal is not connected" };
  if (!id) return { verified: false, reason: "No webhook id configured (PAYPAL_WEBHOOK_ID)" };
  const get = (name: string) => headers.get(name) ?? "";
  const fields = {
    auth_algo: get(WEBHOOK_HEADERS.authAlgo),
    cert_url: get(WEBHOOK_HEADERS.certUrl),
    transmission_id: get(WEBHOOK_HEADERS.transmissionId),
    transmission_sig: get(WEBHOOK_HEADERS.transmissionSig),
    transmission_time: get(WEBHOOK_HEADERS.transmissionTime),
    webhook_id: id,
  };
  const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { verified: false, reason: `Missing headers: ${missing.join(", ")}` };
  // The cert must come from PayPal; PayPal's verify endpoint checks this too, this is belt and braces.
  let certHost = "";
  try {
    certHost = new URL(fields.cert_url).hostname;
  } catch {
    return { verified: false, reason: "cert_url is not a URL" };
  }
  if (!certHost.endsWith(".paypal.com")) return { verified: false, reason: `cert_url host ${certHost} is not paypal.com` };
  try {
    JSON.parse(rawBody);
  } catch {
    return { verified: false, reason: "Body is not JSON" };
  }

  const result = await client.verifyWebhookSignature(fields, rawBody);
  if (!result.ok) return { verified: false, reason: `verify-webhook-signature returned HTTP ${result.status}` };
  const status = result.body?.verification_status;
  return status === "SUCCESS" ? { verified: true, reason: "SUCCESS" } : { verified: false, reason: status ?? "FAILURE" };
}

/** On startup: when PUBLIC_BASE_URL is an https URL and no webhook id is set, find or create Nightshift's webhook. */
export async function ensureWebhook(store: Store, client: PayPalClient, eventTypes: string[]): Promise<string> {
  const { publicBaseUrl, paypal } = config();
  if (paypal.webhookId) return `Using PAYPAL_WEBHOOK_ID ${paypal.webhookId}`;
  if (!publicBaseUrl.startsWith("https://")) return "No https PUBLIC_BASE_URL: webhooks off, the periodic sweep still runs";
  const url = `${publicBaseUrl}/api/webhooks/paypal`;
  const list = await client.listWebhooks();
  const existing = list.ok ? list.body.webhooks?.find((w) => w.url === url) : undefined;
  if (existing) {
    store.setKv("webhook:id", existing.id);
    return `Found webhook ${existing.id} for ${url}`;
  }
  const created = await client.createWebhook(url, eventTypes);
  if (!created.ok) return `Webhook creation failed: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`;
  store.setKv("webhook:id", created.body.id);
  return `Created webhook ${created.body.id} for ${url}`;
}
