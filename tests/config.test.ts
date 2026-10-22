import { describe, expect, it } from "vitest";
import { assertSandboxOnly, loadConfig, LiveEnvironmentRefused, SANDBOX_API_BASE } from "@/lib/config";
import { PayPalClient } from "@/lib/paypal/client";
import { formatMoney, toCents, toDecimal } from "@/lib/money";
import { signCallback, verifyCallback } from "@/lib/telegram";

describe("sandbox-only guard", () => {
  it("refuses PAYPAL_ENV=live and any non-sandbox API base", () => {
    expect(() => assertSandboxOnly({ PAYPAL_ENV: "live" })).toThrow(LiveEnvironmentRefused);
    expect(() => assertSandboxOnly({ PAYPAL_ENV: "LIVE" })).toThrow(LiveEnvironmentRefused);
    expect(() => assertSandboxOnly({ PAYPAL_ENV: "production" })).toThrow(LiveEnvironmentRefused);
    expect(() => assertSandboxOnly({ PAYPAL_API_BASE: "https://api-m.paypal.com" })).toThrow(LiveEnvironmentRefused);
    expect(() => assertSandboxOnly({ PAYPAL_ENV: "sandbox" })).not.toThrow();
    expect(() => assertSandboxOnly({})).not.toThrow();
    expect(() => loadConfig({ PAYPAL_ENV: "live" })).toThrow(LiveEnvironmentRefused);
  });

  it("the client only ever talks to the sandbox host", () => {
    const client = new PayPalClient({ clientId: "a", clientSecret: "b" });
    expect(client.apiBase).toBe(SANDBOX_API_BASE);
    expect(client.apiBase).not.toContain("api-m.paypal.com");
  });

  it("reads LLM defaults and the model allowlist", () => {
    const cfg = loadConfig({ LLM_API_KEY: "k", LLM_MODEL: "x/model", LLM_ALLOWED_MODELS: "y/other, x/model" });
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.llm.allowedModels).toEqual(["x/model", "y/other"]);
    expect(cfg.llm.maxTokens).toBe(1500);
    expect(loadConfig({}).llm.configured).toBe(false);
  });
});

describe("money", () => {
  it("converts between PayPal decimal strings and cents without float drift", () => {
    expect(toCents("42.00")).toBe(4200);
    expect(toCents("0.1")).toBe(10);
    expect(toCents("19.99")).toBe(1999);
    expect(toCents("-5.25")).toBe(-525);
    expect(toDecimal(1999)).toBe("19.99");
    expect(toDecimal(5)).toBe("0.05");
    expect(formatMoney(6400)).toBe("$64.00");
    expect(() => toCents("12.345")).toThrow();
    expect(() => toCents("ten")).toThrow();
  });
});

describe("telegram callbacks", () => {
  it("signs and verifies approve/reject buttons, rejecting tampering", () => {
    const data = signCallback("a", "act_123456789012");
    expect(data.length).toBeLessThanOrEqual(64);
    expect(verifyCallback(data)).toEqual({ verb: "a", actionId: "act_123456789012" });
    expect(verifyCallback(data.replace("a:", "r:"))).toBeNull();
    expect(verifyCallback(data.replace("act_123456789012", "act_999999999999"))).toBeNull();
    expect(verifyCallback("a:act_1")).toBeNull();
  });
});
