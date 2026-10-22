// The AG Studio chat-completions adapter: conversation mapping, schema clean-up, and streaming.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgAiConversationItem, AgLlmRequest } from "ag-studio";
import { chatCompletionsAdapter, sanitizeSchema, toMessages } from "@/components/insights/chat-adapter";

describe("chat adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps Studio conversation items to chat messages, merging tool calls into the assistant turn", () => {
    const items = [
      { kind: "input", type: "message", id: "1", role: "user", status: "completed", content: [{ type: "text", text: "Which incidents cost most?" }] },
      { kind: "output", type: "message", id: "2", role: "assistant", status: "completed", content: [{ type: "text", text: "Checking.", annotations: [] }] },
      { kind: "output", type: "function_call", id: "3", callId: "c1", name: "execute_query", arguments: '{"q":1}' },
      { type: "function_call_output", callId: "c1", output: "rows", status: "completed" },
    ] as unknown as AgAiConversationItem[];
    expect(toMessages("Be brief.", items)).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Which incidents cost most?" },
      { role: "assistant", content: "Checking.", tool_calls: [{ id: "c1", type: "function", function: { name: "execute_query", arguments: '{"q":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "rows" },
    ]);
  });

  it("drops the shape library's `not: {}` branches that providers reject", () => {
    expect(sanitizeSchema({ type: "object", properties: { a: { anyOf: [{ not: {} }, { type: "string" }], description: "x" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string", description: "x" } },
    });
  });

  it("streams text and tool calls as Studio events and resolves the response", async () => {
    const sse = [
      'data: {"id":"r1","model":"m","choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"view_schema","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = chatCompletionsAdapter({ endpoint: "/api/ai", model: "x/model" });
    const handler = adapter.executeTurn({ input: [], tools: [{ name: "view_schema", description: "d", parameters: { type: "object" } }], responseFormat: { type: "text" } } as unknown as AgLlmRequest);
    const events: string[] = [];
    for await (const e of handler.stream) events.push((e as { type: string }).type);
    const response = await handler.complete;
    expect(events).toEqual(["TEXT_MESSAGE_CHUNK", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(response.status).toBe("completed");
    expect(response.output.map((o) => o.type)).toEqual(["message", "function_call"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "x/model", stream: true, tools: [{ type: "function", function: { name: "view_schema" } }] });
  });

  it("rejects the turn with the proxy's error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Rate limit reached" }, { status: 429 })));
    const handler = chatCompletionsAdapter({ endpoint: "/api/ai", model: "m" }).executeTurn({ input: [], responseFormat: { type: "text" } } as unknown as AgLlmRequest);
    for await (const _ of handler.stream) void _;
    await expect(handler.complete).rejects.toThrow("Rate limit reached");
  });
});
