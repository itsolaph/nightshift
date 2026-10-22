// Shop integration: register a PayPal order with Nightshift (and its fulfilment state). Nightshift
// reads the order from PayPal itself; it never trusts amounts sent here.
// Authorization: Bearer INGEST_TOKEN. Disabled when INGEST_TOKEN is not set.

import { z } from "zod";
import { store } from "@/lib/db";
import { jsonError, readJson } from "@/lib/http";
import { ingestOrder } from "@/lib/ledger";
import { paypal } from "@/lib/paypal/client";

export const dynamic = "force-dynamic";

const Body = z.object({
  orderId: z.string().regex(/^[A-Z0-9]{5,36}$/),
  fulfillment: z.enum(["unfulfilled", "shipped", "cancelled"]).default("unfulfilled"),
  shippedAt: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  const token = process.env.INGEST_TOKEN?.trim();
  if (!token) return jsonError(404, "Ingest API disabled (set INGEST_TOKEN)");
  if (request.headers.get("authorization") !== `Bearer ${token}`) return jsonError(401, "Bad token");
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, "Expected { orderId, fulfillment?, shippedAt? }");
  const client = paypal();
  if (!client) return jsonError(503, "PayPal not connected");
  const result = await client.getOrder(parsed.data.orderId);
  if (!result.ok) return jsonError(502, `PayPal GET order returned ${result.status}`);
  const row = ingestOrder(store(), result.body, {
    source: "ingest",
    fulfillment: parsed.data.fulfillment,
    shippedAt: parsed.data.fulfillment === "shipped" ? (parsed.data.shippedAt ?? new Date().toISOString()) : null,
  });
  return Response.json({ order: row });
}
