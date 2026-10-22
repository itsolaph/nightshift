// Server-side proxy for the AG Studio assistant. Studio's chat-completions adapter runs in the
// browser and posts here; this route adds the LLM key (it never reaches the browser), enforces the
// model allowlist and a max_tokens cap, rate-limits per IP, and streams the provider's SSE back.

import { config } from "@/lib/config";
import { jsonError, rateLimit, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 400_000;
const STUDIO_MAX_TOKENS = 4000;

export async function POST(request: Request) {
  const { llm } = config();
  if (!llm.configured) return jsonError(503, "The assistant is off: set LLM_API_KEY on the server.");
  const limited = rateLimit(request, "ai");
  if (limited) return limited;

  const body = await readJson<Record<string, unknown>>(request);
  if (!body || !Array.isArray(body.messages)) return jsonError(400, "Expected a chat-completions body");
  if (JSON.stringify(body).length > MAX_BODY_CHARS) return jsonError(413, "Conversation too long for this demo; start a new chat.");
  const model = typeof body.model === "string" && body.model ? body.model : llm.model;
  if (!llm.allowedModels.includes(model)) return jsonError(400, `Model "${model}" is not enabled on this server.`);

  // Only forward the fields the adapter uses.
  const forwarded = {
    model,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.min(Number(body.max_tokens) || STUDIO_MAX_TOKENS, STUDIO_MAX_TOKENS),
  };

  const upstream = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}`, "X-Title": "Nightshift insights" },
    body: JSON.stringify(forwarded),
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}
