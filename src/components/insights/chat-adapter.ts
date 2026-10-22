// AG Studio LLM adapter for OpenAI-compatible Chat Completions endpoints (OpenRouter by default).
// AG Studio ships no adapters; its docs example targets the OpenAI Responses API, so Nightshift
// has its own. It runs in the browser and posts to Nightshift's /api/ai proxy, which holds the key.
// It maps Studio's conversation items to chat messages and the streamed deltas back to Studio's
// AG-UI style events. Studio executes the tools; the adapter never does.

import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";

export type ChatAdapterOptions = { endpoint: string; model: string };

type Json = Record<string, unknown>;

/** Studio's shape library marks "may be undefined" with an `anyOf: [{ not: {} }, ...]` branch; most providers reject `not`. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) out[key] = sanitizeSchema(value);
  if (Array.isArray(out.anyOf)) {
    const kept = (out.anyOf as Json[]).filter(
      (branch) => !(branch && Object.keys(branch).length === 1 && branch.not && Object.keys(branch.not as Json).length === 0),
    );
    if (kept.length === 1) {
      const rest = { ...out };
      delete rest.anyOf;
      return { ...kept[0], ...rest };
    }
    out.anyOf = kept;
  }
  return out;
}

export function toMessages(instructions: string | undefined, items: AgAiConversationItem[]): Json[] {
  const messages: Json[] = instructions ? [{ role: "system", content: instructions }] : [];
  let pending: (Json & { tool_calls?: Json[] }) | undefined;
  const flush = () => {
    if (pending) messages.push(pending);
    pending = undefined;
  };
  for (const item of items) {
    if (item.type === "message" && item.kind === "input") {
      flush();
      messages.push({ role: item.role, content: item.content.map((c) => (c.type === "text" ? c.text : "")).join("") });
    } else if (item.type === "message" && item.kind === "output") {
      flush();
      pending = { role: "assistant", content: item.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("") };
    } else if (item.type === "function_call") {
      pending ??= { role: "assistant", content: null };
      (pending.tool_calls ??= []).push({
        id: item.callId,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    } else if (item.type === "function_call_output") {
      flush();
      messages.push({ role: "tool", tool_call_id: item.callId, content: item.output });
    }
    // Reasoning items are not replayed.
  }
  flush();
  return messages;
}

function buildBody(options: ChatAdapterOptions, request: AgLlmRequest): Json {
  const body: Json = {
    model: request.model?.id ?? options.model,
    messages: toMessages(request.instructions, request.input),
    stream: true,
  };
  const tools = (request.tools ?? []).map((t) =>
    t.kind === "provided"
      ? t.provider
      : { type: "function", function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) } },
  );
  if (tools.length) {
    body.tools = tools;
    const choice = request.toolChoice;
    if (choice) body.tool_choice = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
  }
  if (request.responseFormat?.type === "json") {
    const f = request.responseFormat;
    body.response_format = { type: "json_schema", json_schema: { name: f.name, description: f.description, schema: sanitizeSchema(f.schema) } };
  }
  return body;
}

export function chatCompletionsAdapter(options: ChatAdapterOptions): AgLlmAdapter {
  return {
    executeTurn(request, turnOptions): AgLlmResponseHandler {
      let resolve!: (r: AgLlmResponse) => void;
      let reject!: (e: Error) => void;
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      void complete.catch(() => {});

      async function* run(): AsyncGenerator<AgAiEvent> {
        const messageId = `msg_${Date.now().toString(36)}`;
        let text = "";
        let textStarted = false;
        let reasoningStarted = false;
        let responseId = messageId;
        let model: string | undefined;
        let usage: AgLlmResponse["usage"];
        let finish: string | undefined;
        const calls = new Map<number, { id: string; name: string; args: string }>();
        try {
          const response = await fetch(`${options.endpoint}/chat/completions`, {
            method: "POST",
            signal: turnOptions?.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildBody(options, request)),
          });
          if (!response.ok || !response.body) {
            const errorText = await response.text().catch(() => "");
            let message = errorText;
            try {
              message = JSON.parse(errorText).error ?? errorText;
            } catch {
              /* plain text */
            }
            throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const raw of lines) {
              const line = raw.trim();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let chunk: Json;
              try {
                chunk = JSON.parse(data);
              } catch {
                continue;
              }
              if (chunk.error) throw new Error(String((chunk.error as Json).message ?? "Provider error"));
              responseId = (chunk.id as string) ?? responseId;
              model = (chunk.model as string) ?? model;
              const u = chunk.usage as Json | undefined;
              if (u) usage = { inputTokens: Number(u.prompt_tokens ?? 0), outputTokens: Number(u.completion_tokens ?? 0), totalTokens: Number(u.total_tokens ?? 0) };
              const choice = (chunk.choices as Json[] | undefined)?.[0];
              if (!choice) continue;
              const delta = (choice.delta ?? {}) as Json;
              if (typeof delta.reasoning === "string" && delta.reasoning) {
                yield { type: "REASONING_MESSAGE_CHUNK", messageId: reasoningStarted ? undefined : `${messageId}_r`, delta: delta.reasoning } as AgAiEvent;
                reasoningStarted = true;
              }
              if (typeof delta.content === "string" && delta.content) {
                text += delta.content;
                yield { type: "TEXT_MESSAGE_CHUNK", messageId: textStarted ? undefined : messageId, role: "assistant", delta: delta.content } as AgAiEvent;
                textStarted = true;
              }
              for (const tc of (delta.tool_calls as Json[] | undefined) ?? []) {
                const index = Number(tc.index ?? 0);
                const fn = (tc.function ?? {}) as Json;
                let call = calls.get(index);
                if (!call) {
                  call = { id: (tc.id as string) ?? `call_${index}_${Date.now()}`, name: (fn.name as string) ?? "", args: "" };
                  calls.set(index, call);
                  yield { type: "TOOL_CALL_START", toolCallId: call.id, toolCallName: call.name } as AgAiEvent;
                }
                if (typeof fn.arguments === "string" && fn.arguments) {
                  call.args += fn.arguments;
                  yield { type: "TOOL_CALL_ARGS", toolCallId: call.id, delta: fn.arguments } as AgAiEvent;
                }
              }
              if (choice.finish_reason) finish = String(choice.finish_reason);
            }
          }
          for (const call of calls.values()) yield { type: "TOOL_CALL_END", toolCallId: call.id } as AgAiEvent;
          const output: AgAiOutputItem[] = [];
          if (text) {
            output.push({ id: messageId, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
          }
          for (const c of calls.values()) {
            output.push({ id: c.id, kind: "output", type: "function_call", callId: c.id, name: c.name, arguments: c.args || "{}", status: "completed" });
          }
          resolve({
            id: responseId,
            createdAt: Date.now(),
            output,
            usage,
            model,
            status: finish === "length" ? "incomplete" : "completed",
            incompleteDetails: finish === "length" ? { reason: "max_output_tokens" } : undefined,
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      const iterator = run();
      return { stream: { [Symbol.asyncIterator]: () => iterator }, complete };
    },
  };
}
