// Optional owner passcode. With OWNER_PASSCODE set, every route that changes money state or policy
// (approvals, settings, fulfilment, scenario lab, manual sweep) needs the owner cookie, set by
// POST /api/owner. Without it the app is an open sandbox demo, which the README says plainly.

import { createHash, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE = "ns_owner";

export function ownerPasscode(): string {
  return process.env.OWNER_PASSCODE?.trim() ?? "";
}

export function ownerToken(passcode = ownerPasscode()): string {
  return createHash("sha256").update(`nightshift-owner:${passcode}`).digest("hex");
}

export function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try { return decodeURIComponent(v.join("=")); }
      catch { return null; }
    }
  }
  return null;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function isOwner(request: Request): boolean {
  const passcode = ownerPasscode();
  if (!passcode) return true;
  const fromCookie = cookie(request, OWNER_COOKIE);
  if (fromCookie && same(fromCookie, ownerToken(passcode))) return true;
  const fromHeader = request.headers.get("x-owner-passcode");
  return Boolean(fromHeader && same(fromHeader, passcode));
}

/** null when allowed, otherwise a 401 the UI turns into "unlock in Settings". */
export function requireOwner(request: Request): Response | null {
  return isOwner(request) ? null : ownerRequired();
}

export const ownerRequired = () => Response.json({ error: "Owner passcode required. Unlock in Settings first.", owner: false }, { status: 401 });
