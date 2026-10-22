// `npm run worker`: the background loop as its own process. Use with WORKER_MODE=external on the
// web process so the loop doesn't also run there. Both must share the same SQLite file.

import { loadEnvLocal } from "./env";

async function main() {
  loadEnvLocal();
  const { config } = await import("../src/lib/config");
  config(); // refuses PAYPAL_ENV=live
  const { startWorkerLoop } = await import("../src/lib/worker");
  startWorkerLoop();
  // The loop's timer is unref'd for the in-process case; keep this process alive.
  setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
