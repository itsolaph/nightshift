// Deliberately public sandbox-demo entrance: no credentials, only a short-lived, narrowly scoped
// judge cookie. Off (404) unless every gate in lib/judge.ts is open. Never runs anything itself.

import { rateLimit } from "@/lib/http";
import { JUDGE_COOKIE, issueJudgeSession } from "@/lib/judge";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const limited = rateLimit(request, "mutate");
  if (limited) return limited;
  const session = issueJudgeSession();
  if (!session) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/lab?judge=sandbox-demo",
      "Cache-Control": "no-store",
      "Set-Cookie": `${JUDGE_COOKIE}=${session.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxAge}${https ? "; Secure" : ""}`,
    },
  });
}
