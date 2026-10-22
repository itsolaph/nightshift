// Telegram approvals (optional). Verifies Telegram's secret-token header, the chat id and the HMAC
// on the button's callback data before touching an action.

import { config } from "@/lib/config";
import { store } from "@/lib/db";
import { ApprovalError, decideAction } from "@/lib/engine";
import { paypal } from "@/lib/paypal/client";
import { answerCallback, verifyCallback, verifyWebhookSecret } from "@/lib/telegram";

export const dynamic = "force-dynamic";

type Update = {
  callback_query?: { id: string; data?: string; from?: { username?: string; id?: number }; message?: { chat?: { id?: number | string } } };
};

export async function POST(request: Request) {
  const tg = config().telegram;
  if (!tg.configured) return new Response("Telegram not configured", { status: 404 });
  if (!verifyWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"))) {
    return new Response("Bad secret", { status: 401 });
  }
  const update = (await request.json().catch(() => ({}))) as Update;
  const query = update.callback_query;
  if (!query?.data) return Response.json({ ok: true });
  if (String(query.message?.chat?.id ?? "") !== tg.chatId) {
    await answerCallback(query.id, "This chat is not allowed to approve.");
    return Response.json({ ok: true });
  }
  const verified = verifyCallback(query.data);
  if (!verified) {
    await answerCallback(query.id, "Invalid button.");
    return Response.json({ ok: true });
  }
  const by = `owner (telegram${query.from?.username ? ` @${query.from.username}` : ""})`;
  try {
    const action = await decideAction(
      store(),
      paypal(),
      verified.actionId,
      verified.verb === "a" ? { kind: "approve", by } : { kind: "reject", reason: "Rejected in Telegram", by },
    );
    await answerCallback(query.id, `${verified.verb === "a" ? "Approved" : "Rejected"}: ${action.status}`);
  } catch (error) {
    await answerCallback(query.id, error instanceof ApprovalError ? error.message : "Something went wrong.");
  }
  return Response.json({ ok: true });
}
