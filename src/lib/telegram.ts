// Optional Telegram approvals. Only active when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set;
// the web inbox works the same without it.
//
// Three checks on every button press: Telegram's secret-token header (set when the webhook is
// registered), the chat id matching TELEGRAM_CHAT_ID, and an HMAC over the callback data so a
// forged callback can't approve an action.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import type { Store } from "./db";
import { ACTION_LABELS, type ActionRecord, type ActionType } from "./domain";
import { formatMoney } from "./money";

const API = "https://api.telegram.org";

function secret(): string {
  const { botToken, webhookSecret } = config().telegram;
  return webhookSecret || createHash("sha256").update(`nightshift-telegram:${botToken}`).digest("hex").slice(0, 48);
}

export function signCallback(verb: "a" | "r", actionId: string): string {
  const sig = createHmac("sha256", secret()).update(`${verb}:${actionId}`).digest("hex").slice(0, 16);
  return `${verb}:${actionId}:${sig}`;
}

export function verifyCallback(data: string): { verb: "a" | "r"; actionId: string } | null {
  const [verb, actionId, sig] = data.split(":");
  if ((verb !== "a" && verb !== "r") || !actionId || !sig) return null;
  const expected = signCallback(verb, actionId).split(":")[2];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { verb, actionId };
}

export function verifyWebhookSecret(header: string | null): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function call(method: string, body: unknown) {
  const { botToken } = config().telegram;
  const response = await fetch(`${API}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => ({ ok: false }));
}

export async function notifyApprovalNeeded(store: Store, action: ActionRecord) {
  const tg = config().telegram;
  if (!tg.configured || action.status !== "awaiting_approval") return;
  const sentKey = `telegram:sent:${action.id}`;
  if (store.getKv(sentKey)) return;
  store.setKv(sentKey, true);
  const incident = store.getIncident(action.incidentId);
  const label = ACTION_LABELS[action.type as ActionType] ?? action.type;
  const amount = action.amountCents ? ` ${formatMoney(action.amountCents, action.currency ?? "USD")}` : "";
  const link = config().publicBaseUrl ? `\n${config().publicBaseUrl}/approvals` : "";
  const text = [
    `Nightshift needs a decision`,
    incident ? `Incident: ${incident.title}` : "",
    `Proposed: ${label}${amount}`,
    action.call ? `Call: ${action.call.method} ${action.call.path}` : "",
    action.note ? `Note: ${action.note}` : "",
    `Why: ${action.reasons.join(" ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    await call("sendMessage", {
      chat_id: tg.chatId,
      text: text + link,
      reply_markup: {
        inline_keyboard: [
          [
            { text: action.type === "ask_owner" ? "Acknowledge" : "Approve", callback_data: signCallback("a", action.id) },
            { text: "Reject", callback_data: signCallback("r", action.id) },
          ],
        ],
      },
    });
  } catch (error) {
    console.warn("[telegram] sendMessage failed", String(error));
  }
}

export async function answerCallback(callbackQueryId: string, text: string) {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text.slice(0, 190) });
}

/** Registers the Telegram webhook when a public https URL is configured. */
export async function registerTelegramWebhook(): Promise<string> {
  const { telegram, publicBaseUrl } = config();
  if (!telegram.configured) return "Telegram not configured";
  if (!publicBaseUrl.startsWith("https://")) return "Telegram webhook needs an https PUBLIC_BASE_URL";
  const result = await call("setWebhook", {
    url: `${publicBaseUrl}/api/telegram/webhook`,
    secret_token: secret(),
    allowed_updates: ["callback_query"],
  });
  return result.ok ? "Telegram webhook registered" : `Telegram setWebhook failed: ${result.description ?? "unknown"}`;
}
