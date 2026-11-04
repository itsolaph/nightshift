import { jsonError, rateLimit, readJson } from "@/lib/http";
import { verifyJudgeSession } from "@/lib/judge";
import { OWNER_COOKIE, isOwner, ownerPasscode, ownerToken } from "@/lib/owner";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const owner = isOwner(request);
  return Response.json({ required: Boolean(ownerPasscode()), owner, judge: !owner && verifyJudgeSession(request) });
}

export async function POST(request: Request) {
  const limited = rateLimit(request, "mutate");
  if (limited) return limited;
  const passcode = ownerPasscode();
  if (!passcode) return Response.json({ owner: true, required: false });
  const body = await readJson<{ passcode?: string }>(request);
  if (body?.passcode !== passcode) return jsonError(401, "Wrong passcode");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json(
    { owner: true },
    { headers: { "Set-Cookie": `${OWNER_COOKIE}=${ownerToken(passcode)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` } },
  );
}

export function DELETE() {
  return Response.json({ owner: false }, { headers: { "Set-Cookie": `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
}
