// Passwordless judge entrance for the sandbox demo. A judge session is its own role with its own
// signed cookie; it is never an owner cookie and grants only: start "Run the night", and approve or
// reject an existing pending action. Every gate is re-read from the environment on each use.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookie, isOwner, ownerPasscode } from "@/lib/owner";

export const JUDGE_COOKIE = "ns_judge";
export const JUDGE_ACTOR = "judge (sandbox demo)";
export const JUDGE_MAX_SECONDS = 2 * 3600;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const flag = (v: string | undefined, want: string) => v?.trim().toLowerCase() === want;

/** The signing secret and deadline (epoch ms) when every gate is open, else null. Fails closed. */
function gate(now: number): { secret: string; untilMs: number } | null {
  const env = process.env;
  if (!flag(env.JUDGE_DEMO_ENABLED, "true") || !flag(env.DEMO_MODE, "true") || !flag(env.PAYPAL_ENV, "sandbox")) return null;
  const secret = env.JUDGE_SESSION_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret) < 32) return null;
  const until = env.JUDGE_DEMO_UNTIL?.trim() ?? "";
  if (!ISO.test(until)) return null;
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs) || untilMs <= now) return null;
  return { secret, untilMs };
}

export const judgeEnabled = (now = Date.now()) => gate(now) !== null;

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`nightshift-judge:${payload}`).digest("base64url");

/** A signed session value and its lifetime in seconds, or null when the gates are closed. */
export function issueJudgeSession(now = Date.now()): { value: string; maxAge: number } | null {
  const g = gate(now);
  if (!g) return null;
  const iat = Math.floor(now / 1000);
  const exp = Math.min(iat + JUDGE_MAX_SECONDS, Math.floor(g.untilMs / 1000));
  if (exp <= iat) return null;
  const payload = `v1.${iat}.${exp}.${randomBytes(12).toString("base64url")}`;
  return { value: `${payload}.${sign(g.secret, payload)}`, maxAge: exp - iat };
}

export function verifyJudgeSession(request: Request, now = Date.now()): boolean {
  const g = gate(now);
  if (!g) return false;
  const raw = cookie(request, JUDGE_COOKIE);
  const parts = raw?.split(".");
  if (!parts || parts.length !== 5 || parts[0] !== "v1") return false;
  const [, iatS, expS, , sig] = parts;
  if (!/^\d+$/.test(iatS) || !/^\d+$/.test(expS)) return false;
  const iat = Number(iatS);
  const exp = Number(expS);
  const nowS = now / 1000;
  if (exp <= nowS || iat > nowS + 60 || exp - iat > JUDGE_MAX_SECONDS || exp > g.untilMs / 1000) return false;
  const want = Buffer.from(sign(g.secret, parts.slice(0, 4).join(".")));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Who is calling. A passcode-verified owner is the owner. Otherwise a valid judge session is a
 * judge. With no OWNER_PASSCODE the demo stays open and everyone else is the owner, as before.
 */
export function callerRole(request: Request): "owner" | "judge" | null {
  if (ownerPasscode() && isOwner(request)) return "owner";
  if (verifyJudgeSession(request)) return "judge";
  return isOwner(request) ? "owner" : null;
}
