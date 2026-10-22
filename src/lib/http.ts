// Small helpers for route handlers: client IP, per-IP rate limits, JSON errors.
// The limiter is in memory, which fits a single-instance deployment (one Render web service).

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  // The rightmost entry is the one the hosting proxy appended; the left ones are client-supplied.
  if (forwarded) return forwarded.split(",").at(-1)!.trim();
  return request.headers.get("x-real-ip") ?? "local";
}

type Bucket = { count: number; resetAt: number };
const buckets = (globalThis as unknown as { __nightshiftBuckets?: Map<string, Bucket> }).__nightshiftBuckets ?? new Map<string, Bucket>();
(globalThis as unknown as { __nightshiftBuckets?: Map<string, Bucket> }).__nightshiftBuckets = buckets;

export const LIMITS = {
  ai: { max: 30, windowMs: 10 * 60_000 },
  lab: { max: 4, windowMs: 10 * 60_000 },
  mutate: { max: 60, windowMs: 10 * 60_000 },
  sweep: { max: 10, windowMs: 10 * 60_000 },
} as const;

/** Returns null when allowed, or a 429 response. */
export function rateLimit(request: Request, group: keyof typeof LIMITS): Response | null {
  const { max, windowMs } = LIMITS[group];
  const key = `${group}:${clientIp(request)}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  bucket.count++;
  if (bucket.count <= max) return null;
  const retry = Math.ceil((bucket.resetAt - now) / 1000);
  return Response.json(
    { error: `Rate limit reached for this demo (${max} per ${windowMs / 60000} min). Try again in ${retry}s.` },
    { status: 429, headers: { "Retry-After": String(retry) } },
  );
}

export function resetRateLimits() {
  buckets.clear();
}

export const jsonError = (status: number, error: string) => Response.json({ error }, { status });

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
