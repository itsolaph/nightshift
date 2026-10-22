// Environment configuration. Read once per process, validated, with a hard guard against
// production PayPal: this hackathon build only ever talks to the sandbox.

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

export type AppConfig = {
  paypal: {
    clientId: string;
    clientSecret: string;
    webhookId: string;
    apiBase: string;
    configured: boolean;
  };
  publicBaseUrl: string;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    allowedModels: string[];
    maxTokens: number;
    configured: boolean;
  };
  agStudioLicense: string;
  telegram: { botToken: string; chatId: string; webhookSecret: string; configured: boolean };
  demoMode: boolean;
  databasePath: string;
  workerMode: "inline" | "external" | "off";
  cronSecret: string;
  lab: {
    /** auto: card orders first, PayPal checkout once the sandbox app refuses cards. */
    paymentSource: "auto" | "card" | "paypal";
    /** auto: headless guest checkout when playwright-core and Chromium are there, else manual. */
    buyerApproval: "auto" | "headless" | "manual";
    chromiumPath: string;
    approvalTimeoutMs: number;
  };
};

export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
// A cheap model with tool calling on OpenRouter ($0.10 / $0.50 per 1M tokens, checked against
// https://openrouter.ai/api/v1/models in Oct 2026). Override with LLM_MODEL.
export const DEFAULT_LLM_MODEL = "anthropic/claude-haiku-5.5";

export class LiveEnvironmentRefused extends Error {
  constructor() {
    super(
      "PAYPAL_ENV=live is refused: this build of Nightshift only runs against the PayPal sandbox (api-m.sandbox.paypal.com).",
    );
    this.name = "LiveEnvironmentRefused";
  }
}

/** Throws when anything points Nightshift at production PayPal. Called at startup and on every client creation. */
export function assertSandboxOnly(env: Record<string, string | undefined> = process.env): void {
  const mode = (env.PAYPAL_ENV ?? "sandbox").trim().toLowerCase();
  if (mode !== "sandbox") throw new LiveEnvironmentRefused();
  const base = env.PAYPAL_API_BASE?.trim();
  if (base && base !== SANDBOX_API_BASE) throw new LiveEnvironmentRefused();
}

/** The value if it is one of `options` (case-insensitive), else the first option. */
const oneOf = <T extends string>(value: string | undefined, options: readonly T[]): T => {
  const v = value?.trim().toLowerCase();
  return options.find((o) => o === v) ?? options[0];
};

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  assertSandboxOnly(env);
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
  const model = env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const allowed = list(env.LLM_ALLOWED_MODELS);
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? "";
  const workerMode = (env.WORKER_MODE?.trim() || "inline") as AppConfig["workerMode"];
  return {
    paypal: {
      clientId,
      clientSecret,
      webhookId: env.PAYPAL_WEBHOOK_ID?.trim() ?? "",
      apiBase: SANDBOX_API_BASE,
      configured: Boolean(clientId && clientSecret),
    },
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() ?? "").replace(/\/+$/, ""),
    llm: {
      baseUrl: (env.LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL).replace(/\/+$/, ""),
      apiKey,
      model,
      allowedModels: allowed.length ? Array.from(new Set([model, ...allowed])) : [model],
      maxTokens: Number(env.LLM_MAX_TOKENS) > 0 ? Math.min(Number(env.LLM_MAX_TOKENS), 8000) : 1500,
      configured: Boolean(apiKey),
    },
    agStudioLicense: env.AG_STUDIO?.trim() ?? "",
    telegram: {
      botToken,
      chatId,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "",
      configured: Boolean(botToken && chatId),
    },
    demoMode: (env.DEMO_MODE ?? "true").trim().toLowerCase() !== "false",
    databasePath: env.DATABASE_PATH?.trim() || "data/nightshift.db",
    workerMode: ["inline", "external", "off"].includes(workerMode) ? workerMode : "inline",
    cronSecret: env.CRON_SECRET?.trim() ?? "",
    lab: {
      paymentSource: oneOf(env.LAB_PAYMENT_SOURCE, ["auto", "card", "paypal"] as const),
      buyerApproval: oneOf(env.LAB_BUYER_APPROVAL, ["auto", "headless", "manual"] as const),
      chromiumPath: env.LAB_CHROMIUM_PATH?.trim() ?? "",
      approvalTimeoutMs: (Number(env.LAB_APPROVAL_TIMEOUT_SECONDS) > 0 ? Number(env.LAB_APPROVAL_TIMEOUT_SECONDS) : 600) * 1000,
    },
  };
}

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** For tests. */
export function resetConfigCache() {
  cached = null;
}
