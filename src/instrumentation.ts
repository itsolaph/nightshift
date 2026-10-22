// Starts Nightshift's background worker inside the Next.js server process (WORKER_MODE=inline,
// the default). With WORKER_MODE=external the loop runs in its own process (`npm run worker`).

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { config } = await import("./lib/config");
  // Throws on PAYPAL_ENV=live: the server refuses to start.
  const cfg = config();
  if (cfg.workerMode !== "inline") return;
  const { startWorkerLoop } = await import("./lib/worker");
  startWorkerLoop();
}
