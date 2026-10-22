// Minimal OpenAI-compatible chat-completions client with streaming and tool calls. Works with
// OpenRouter (the default) or any endpoint that speaks the same protocol.

import { config } from "../config";

export type ChatTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } };
  model?: string;
  maxTokens?: number;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
};

export type LlmClient = (request: ChatRequest) => Promise<ChatResult>;

export class LlmError extends Error {}

/** Streams one chat completion and assembles text and tool calls. */
export const chatCompletion: LlmClient = async (request) => {
  const { llm } = config();
  if (!llm.apiKey) throw new LlmError("LLM_API_KEY is not set");
  const model = request.model ?? llm.model;
  if (!llm.allowedModels.includes(model)) throw new LlmError(`Model ${model} is not on the allowlist`);

  const response = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Nightshift",
      ...(config().publicBaseUrl ? { "HTTP-Referer": config().publicBaseUrl } : {}),
    },
    body: JSON.stringify({
      model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tools?.length ? (request.toolChoice ?? "auto") : undefined,
      max_tokens: Math.min(request.maxTokens ?? llm.maxTokens, llm.maxTokens),
      temperature: 0.2,
      stream: true,
    }),
    signal: request.signal ?? AbortSignal.timeout(90_000),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new LlmError(`LLM request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return readStream(response.body, request.onText);
};

export async function readStream(body: ReadableStream<Uint8Array>, onText?: (delta: string) => void): Promise<ChatResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let content = "";
  let finishReason: string | null = null;
  let usage: ChatResult["usage"] = null;
  let buffer = "";

  const handle = (line: string) => {
    if (!line.startsWith("data:")) return; // ": OPENROUTER PROCESSING" keep-alives and blank lines
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: {
      error?: { message?: string };
      usage?: ChatResult["usage"];
      choices?: {
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new LlmError(chunk.error.message ?? "LLM stream error");
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.finish_reason === "error") throw new LlmError("LLM stream ended with an error");
    const delta = choice.delta;
    if (delta?.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const call = (calls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line.trimEnd());
  }
  if (buffer) handle(buffer.trimEnd());

  const toolCalls = Object.entries(calls)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([index, c]) => ({
      id: c.id || `call_${index}`,
      type: "function" as const,
      function: { name: c.name, arguments: c.args || "{}" },
    }));
  return { content, toolCalls, finishReason, usage };
}
