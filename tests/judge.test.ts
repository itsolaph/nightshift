// The passwordless judge entrance for the sandbox demo: gates, signed session, and the narrow
// allowlist of routes a judge may use. PayPal is the in-memory fake; the scenario runner is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/scenarios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scenarios")>()),
  runTheNight: vi.fn(async () => {}),
  runSingleScenario: vi.fn(async () => {}),
}));

import { createHmac } from "node:crypto";
import { GET as judgeEntrance } from "@/app/judge/route";
import { POST as labRun } from "@/app/api/lab/run/route";
import { POST as labReset } from "@/app/api/lab/reset/route";
import { POST as actionsPost } from "@/app/api/actions/[id]/route";
import { POST as settingsPost } from "@/app/api/settings/route";
import { POST as sweepPost } from "@/app/api/sweep/route";
import { POST as fulfillmentPost } from "@/app/api/orders/[id]/fulfillment/route";
import { GET as ownerGet, POST as ownerPost } from "@/app/api/owner/route";
import { resetConfigCache } from "@/lib/config";
import { Store, setStore } from "@/lib/db";
import { resetRateLimits } from "@/lib/http";
import { PayPalClient, setPayPalClient } from "@/lib/paypal/client";
import { ingestOrder } from "@/lib/ledger";
import { detectAndOpen } from "@/lib/watcher";
import { processProposals } from "@/lib/engine";
import { runTheNight, runSingleScenario } from "@/lib/scenarios";
import { JUDGE_COOKIE, JUDGE_ACTOR, issueJudgeSession, judgeEnabled, verifyJudgeSession } from "@/lib/judge";
import { OWNER_COOKIE, ownerToken } from "@/lib/owner";
import { FakePayPal } from "./fake-paypal";

const SECRET = "x".repeat(40);
const future = () => new Date(Date.now() + 24 * 3600_000).toISOString();
const GATE_KEYS = ["JUDGE_DEMO_ENABLED", "DEMO_MODE", "PAYPAL_ENV", "JUDGE_SESSION_SECRET", "JUDGE_DEMO_UNTIL", "OWNER_PASSCODE"];

function enable(extra: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    JUDGE_DEMO_ENABLED: "true",
    DEMO_MODE: "true",
    PAYPAL_ENV: "sandbox",
    JUDGE_SESSION_SECRET: SECRET,
    JUDGE_DEMO_UNTIL: future(),
    OWNER_PASSCODE: "owner-pass-123",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
}

const post = (url: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

async function judgeCookie(): Promise<string> {
  const res = await judgeEntrance(new Request("http://x/judge"));
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0];
}

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(GATE_KEYS.map((k) => [k, process.env[k]]));
  resetRateLimits();
  vi.mocked(runTheNight).mockClear();
  vi.mocked(runSingleScenario).mockClear();
});
afterEach(() => {
  for (const k of GATE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfigCache();
  vi.useRealTimers();
});

describe("GET /judge entrance", () => {
  it("sets a scoped HttpOnly judge cookie and redirects to /lab without running anything", async () => {
    enable();
    const res = await judgeEntrance(new Request("http://x/judge"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/lab\?/);
    const set = res.headers.get("set-cookie")!;
    expect(set.startsWith(`${JUDGE_COOKIE}=`)).toBe(true);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(set).not.toContain("Secure");
    expect(set).not.toContain(OWNER_COOKIE);
    const maxAge = Number(/Max-Age=(\d+)/.exec(set)![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(7200);
    expect(res.headers.get("location")).not.toContain(SECRET);
    expect(set).not.toContain(SECRET);
    expect(runTheNight).not.toHaveBeenCalled();
  });

  it("marks the cookie Secure on https", async () => {
    enable();
    const res = await judgeEntrance(new Request("https://x/judge"));
    expect(res.headers.get("set-cookie")).toContain("Secure");
    const proxied = await judgeEntrance(new Request("http://x/judge", { headers: { "x-forwarded-proto": "https" } }));
    expect(proxied.headers.get("set-cookie")).toContain("Secure");
  });

  it("caps the session at the configured deadline when it is sooner than two hours", async () => {
    enable({ JUDGE_DEMO_UNTIL: new Date(Date.now() + 600_000).toISOString() });
    const res = await judgeEntrance(new Request("http://x/judge"));
    const maxAge = Number(/Max-Age=(\d+)/.exec(res.headers.get("set-cookie")!)![1]);
    expect(maxAge).toBeLessThanOrEqual(600);
    expect(maxAge).toBeGreaterThan(590);
  });

  const closed: [string, Record<string, string | undefined>][] = [
    ["JUDGE_DEMO_ENABLED unset", { JUDGE_DEMO_ENABLED: undefined }],
    ["JUDGE_DEMO_ENABLED not exactly true", { JUDGE_DEMO_ENABLED: "1" }],
    ["DEMO_MODE unset", { DEMO_MODE: undefined }],
    ["DEMO_MODE false", { DEMO_MODE: "false" }],
    ["PAYPAL_ENV unset", { PAYPAL_ENV: undefined }],
    ["PAYPAL_ENV live", { PAYPAL_ENV: "live" }],
    ["secret unset", { JUDGE_SESSION_SECRET: undefined }],
    ["secret too short", { JUDGE_SESSION_SECRET: "short-secret" }],
    ["deadline unset", { JUDGE_DEMO_UNTIL: undefined }],
    ["deadline garbage", { JUDGE_DEMO_UNTIL: "tomorrow-ish" }],
    ["deadline expired", { JUDGE_DEMO_UNTIL: new Date(Date.now() - 1000).toISOString() }],
  ];
  it.each(closed)("returns 404 and no cookie when %s", async (_name, env) => {
    enable(env);
    const res = await judgeEntrance(new Request("http://x/judge"));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(judgeEnabled()).toBe(false);
  });

  it("is rate limited per IP", async () => {
    enable();
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await judgeEntrance(new Request("http://x/judge", { headers: { "x-forwarded-for": "9.9.9.9" } }))).status;
    expect(last).toBe(429);
  });
});

describe("judge session", () => {
  const withCookie = (value: string) => new Request("http://x/api/lab/run", { headers: { cookie: value } });

  it("verifies a fresh session", async () => {
    enable();
    expect(verifyJudgeSession(withCookie(await judgeCookie()))).toBe(true);
  });

  it("rejects missing, malformed and tampered values", async () => {
    enable();
    const good = await judgeCookie();
    const value = good.slice(JUDGE_COOKIE.length + 1);
    expect(verifyJudgeSession(new Request("http://x/"))).toBe(false);
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=garbage`))).toBe(false);
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=%E0%A4%A`))).toBe(false);
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=`))).toBe(false);
    const parts = value.split(".");
    const tamperedExp = [...parts];
    tamperedExp[2] = String(Number(parts[2]) + 3600);
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=${tamperedExp.join(".")}`))).toBe(false);
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=${value.slice(0, -2)}xx`))).toBe(false);
  });

  it("rejects a session signed with a different secret", async () => {
    enable();
    const good = await judgeCookie();
    enable({ JUDGE_SESSION_SECRET: "y".repeat(40) });
    expect(verifyJudgeSession(withCookie(good))).toBe(false);
  });

  it("rejects an expired session and one that outlives its two hour bound", async () => {
    enable();
    const now = Date.now();
    const expired = issueJudgeSession(now - 3 * 3600_000)!;
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=${expired.value}`))).toBe(false);
    // Forged with the right secret but a 3 hour lifetime.
    const iat = Math.floor(now / 1000);
    const exp = iat + 3 * 3600;
    const forged = `v1.${iat}.${exp}.nonce`;
    const sig = createHmac("sha256", SECRET).update(`nightshift-judge:${forged}`).digest("base64url");
    expect(verifyJudgeSession(withCookie(`${JUDGE_COOKIE}=${forged}.${sig}`))).toBe(false);
  });

  it("rechecks every gate on each use", async () => {
    enable();
    const good = await judgeCookie();
    expect(verifyJudgeSession(withCookie(good))).toBe(true);
    for (const off of [{ JUDGE_DEMO_ENABLED: "false" }, { DEMO_MODE: "false" }, { PAYPAL_ENV: "live" }, { JUDGE_DEMO_UNTIL: new Date(Date.now() - 1000).toISOString() }]) {
      enable(off);
      expect(verifyJudgeSession(withCookie(good))).toBe(false);
    }
  });

  it("stops working once the deadline passes, even inside the two hours", async () => {
    enable({ JUDGE_DEMO_UNTIL: new Date(Date.now() + 60_000).toISOString() });
    const good = await judgeCookie();
    vi.useFakeTimers({ now: Date.now() + 120_000 });
    expect(verifyJudgeSession(withCookie(good))).toBe(false);
  });
});

describe("judge privileges", () => {
  beforeEach(() => {
    const fake = new FakePayPal();
    setPayPalClient(new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} }));
    setStore(new Store(":memory:"));
  });
  afterEach(() => setPayPalClient(null));

  it("may start the night, through the existing lab limits", async () => {
    enable();
    const cookie = await judgeCookie();
    const res = await labRun(post("/api/lab/run", { cookie }, { scenario: "night" }));
    expect(res.status).toBe(202);
    expect(runTheNight).toHaveBeenCalledTimes(1);
  });

  it("is subject to the lab rate limit", async () => {
    enable();
    const cookie = await judgeCookie();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await labRun(post("/api/lab/run", { cookie }, { scenario: "night" }))).status);
    expect(statuses).toContain(429);
  });

  it("is refused other scenarios, unknown bodies and the owner-less default", async () => {
    enable();
    const cookie = await judgeCookie();
    expect((await labRun(post("/api/lab/run", { cookie }, { scenario: "double-charge" }))).status).toBe(403);
    expect((await labRun(post("/api/lab/run", { cookie }, { nope: 1 }))).status).toBe(400);
    expect((await labRun(post("/api/lab/run", {}, { scenario: "night" }))).status).toBe(401);
    expect(runSingleScenario).not.toHaveBeenCalled();
    expect(runTheNight).not.toHaveBeenCalled();
  });

  it("cannot reach owner-only routes", async () => {
    enable();
    const cookie = await judgeCookie();
    expect((await settingsPost(post("/api/settings", { cookie }, { autopilot: true }))).status).toBe(401);
    expect((await labReset(post("/api/lab/reset", { cookie }))).status).toBe(401);
    expect((await sweepPost(post("/api/sweep", { cookie }))).status).toBe(401);
    expect((await fulfillmentPost(post("/api/orders/X/fulfillment", { cookie }, { fulfillment: "shipped" }), { params: Promise.resolve({ id: "X" }) } as never)).status).toBe(401);
  });

  it("is never reported as owner and cannot mint an owner cookie", async () => {
    enable();
    const cookie = await judgeCookie();
    const who = await (await ownerGet(new Request("http://x/api/owner", { headers: { cookie } }))).json();
    expect(who.owner).toBe(false);
    expect(who.judge).toBe(true);
    expect((await ownerPost(post("/api/owner", { cookie }, { passcode: "wrong" }))).status).toBe(401);
    const real = await (await ownerGet(new Request("http://x/api/owner", { headers: { cookie: `${OWNER_COOKIE}=${ownerToken("owner-pass-123")}` } }))).json();
    expect(real.owner).toBe(true);
    expect(real.judge).toBe(false);
  });

  it("does not turn the judge cookie into an owner when no judge gate is open", async () => {
    enable();
    const cookie = await judgeCookie();
    enable({ JUDGE_DEMO_ENABLED: undefined });
    expect((await labRun(post("/api/lab/run", { cookie }, { scenario: "night" }))).status).toBe(401);
  });

  async function pending() {
    const store = new Store(":memory:");
    setStore(store);
    const fake = new FakePayPal();
    const client = new PayPalClient({ clientId: "id", clientSecret: "secret", fetch: fake.fetch, sleep: async () => {} });
    setPayPalClient(client);
    const order = await client.createOrder({
      intent: "AUTHORIZE",
      purchase_units: [{ amount: { currency_code: "USD", value: "42.00" } }],
      payment_source: { card: { number: "4012888888881881", expiry: "2030-12", name: "Buyer" } },
    });
    ingestOrder(store, order.body, { fulfillment: "shipped", shippedAt: new Date(Date.now() - 20 * 3600_000).toISOString() });
    const [incident] = detectAndOpen(store);
    const authId = store.listLedger("authorization")[0].id;
    store.saveSettings({ autopilot: false });
    const [action] = await processProposals(store, client, incident.id, [{ type: "capture_authorization", targetId: authId, rationale: "t" }], "agent");
    expect(action.status).toBe("awaiting_approval");
    return { store, action, fake };
  }
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

  it("may approve a pending action; the audit actor is the judge, not the owner", async () => {
    enable();
    const { store, action, fake } = await pending();
    const cookie = await judgeCookie();
    const res = await actionsPost(post(`/api/actions/${action.id}`, { cookie }, { decision: "approve" }), ctx(action.id));
    expect(res.status).toBe(200);
    const after = store.getAction(action.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.decidedBy).toBe(JUDGE_ACTOR);
    expect(JUDGE_ACTOR).toMatch(/^judge/);
    expect(JSON.stringify(after)).not.toContain("owner (web)");
    const events = store.incidentEvents(action.incidentId).filter((e) => e.kind === "approval");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.actor === "judge")).toBe(true);
    expect(events.every((e) => !/owner/i.test(e.title))).toBe(true);
    // Exactly one capture, through the (fake) sandbox client.
    expect(fake.requests.filter((r) => r.path.endsWith("/capture"))).toHaveLength(1);
  });

  it("is idempotent: a second approval is a conflict, not a second capture", async () => {
    enable();
    const { action, fake } = await pending();
    const cookie = await judgeCookie();
    await actionsPost(post(`/api/actions/${action.id}`, { cookie }, { decision: "approve" }), ctx(action.id));
    const again = await actionsPost(post(`/api/actions/${action.id}`, { cookie }, { decision: "approve" }), ctx(action.id));
    expect(again.status).toBe(409);
    expect(fake.requests.filter((r) => r.path.endsWith("/capture"))).toHaveLength(1);
  });

  it("may reject a pending action", async () => {
    enable();
    const { store, action } = await pending();
    const cookie = await judgeCookie();
    const res = await actionsPost(post(`/api/actions/${action.id}`, { cookie }, { decision: "reject" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(store.getAction(action.id)!.decidedBy).toBe(JUDGE_ACTOR);
  });

  it("is refused amount edits and answers, and the action stays pending", async () => {
    enable();
    const { store, action } = await pending();
    const cookie = await judgeCookie();
    const edited = await actionsPost(post(`/api/actions/${action.id}`, { cookie }, { decision: "approve", amount: "1.00" }), ctx(action.id));
    expect(edited.status).toBe(403);
    const answered = await actionsPost(post(`/api/actions/${action.id}`, { cookie }, { decision: "answer", reply: "yes" }), ctx(action.id));
    expect(answered.status).toBe(403);
    expect(store.getAction(action.id)!.status).toBe("awaiting_approval");
  });

  it("an unknown action id is still a policy-level 409, never a bypass", async () => {
    enable();
    const cookie = await judgeCookie();
    const res = await actionsPost(post("/api/actions/nope", { cookie }, { decision: "approve" }), ctx("nope"));
    expect(res.status).toBe(409);
  });

  it("the owner keeps full access and the owner actor, even with a judge cookie too", async () => {
    enable();
    const { store, action } = await pending();
    const both = `${await judgeCookie()}; ${OWNER_COOKIE}=${ownerToken("owner-pass-123")}`;
    const res = await actionsPost(post(`/api/actions/${action.id}`, { cookie: both }, { decision: "approve", amount: "42.00" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(store.getAction(action.id)!.decidedBy).toBe("owner (web)");
    expect((await settingsPost(post("/api/settings", { cookie: both }, { autopilot: true }))).status).toBe(200);
  });

  it("without an owner passcode the existing open demo is unchanged", async () => {
    enable({ OWNER_PASSCODE: undefined });
    const { store, action } = await pending();
    const res = await actionsPost(post(`/api/actions/${action.id}`, {}, { decision: "approve", amount: "42.00" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(store.getAction(action.id)!.decidedBy).toBe("owner (web)");
  });
});
