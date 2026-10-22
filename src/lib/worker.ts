// The background loop: sweep PayPal, run detectors, triage new incidents, recover stuck actions.
// Runs in-process next to the web server by default (WORKER_MODE=inline, started from
// instrumentation.ts) or as its own process with `npm run worker` (WORKER_MODE=external on the web).

import { store as defaultStore, type Store } from "./db";
import { paypal } from "./paypal/client";
import { config } from "./config";
import { detectAndOpen, sweep, WEBHOOK_EVENT_TYPES } from "./watcher";
import { executeAction } from "./executor";
import { ensureWebhook } from "./paypal/webhooks";
import { registerTelegramWebhook } from "./telegram";
import { dispatchTriage, recoverStuckTriage } from "./runner";

const SWEEP_EVERY_MS = 5 * 60_000;
const TICK_MS = 15_000;
const STUCK_EXECUTING_MS = 3 * 60_000;

/** Opens incidents and triages every open one. Returns how many were triaged. */
export async function detectAndTriage(s: Store = defaultStore()): Promise<number> {
  detectAndOpen(s);
  const open = s.listIncidents().filter((i) => i.status === "open");
  if (open.length === 0) return 0;
  let done = 0;
  // Two at a time keeps the LLM bill and PayPal rate limits calm.
  const queue = [...open].reverse();
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    for (let incident = queue.shift(); incident; incident = queue.shift()) {
      await dispatchTriage(s, incident.id);
      done++;
    }
  });
  await Promise.all(workers);
  return done;
}

/** Actions left in "executing" by a crash are retried with the same PayPal-Request-Id, so PayPal replays rather than repeats. */
async function recoverStuckActions(s: Store) {
  const stuck = s
    .listActionsByStatus("executing")
    .filter((a) => Date.now() - new Date(a.updatedAt).getTime() > STUCK_EXECUTING_MS);
  for (const action of stuck) {
    s.updateAction(action.id, { status: "approved" });
    await executeAction(s, paypal(), action.id, "recovery");
  }
}

export async function runCycle(s: Store = defaultStore(), opts: { forceSweep?: boolean } = {}) {
  const client = paypal();
  const last = s.getKv<{ at: string }>("sweep:last");
  const due = !last || Date.now() - new Date(last.at).getTime() > SWEEP_EVERY_MS;
  if (client && (due || opts.forceSweep)) {
    try {
      await sweep(s, client);
    } catch (error) {
      console.warn("[worker] sweep failed:", String(error));
    }
  }
  await recoverStuckActions(s);
  await recoverStuckTriage(s);
  await detectAndTriage(s);
}

const globalWorker = globalThis as unknown as { __nightshiftWorker?: { timer: NodeJS.Timeout; running: boolean } };

export async function startup(s: Store = defaultStore()) {
  const client = paypal();
  if (client) {
    try {
      console.log("[worker]", await ensureWebhook(s, client, WEBHOOK_EVENT_TYPES));
    } catch (error) {
      console.warn("[worker] webhook setup failed:", String(error));
    }
  } else {
    console.log("[worker] PayPal sandbox credentials not set: detectors and UI run, PayPal calls are off");
  }
  if (config().telegram.configured) console.log("[worker]", await registerTelegramWebhook().catch(String));
}

export function startWorkerLoop(s: Store = defaultStore()) {
  if (globalWorker.__nightshiftWorker) return;
  const state = { running: false, timer: undefined as unknown as NodeJS.Timeout };
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await runCycle(s);
    } catch (error) {
      console.warn("[worker] cycle failed:", String(error));
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(tick, TICK_MS);
  state.timer.unref?.();
  globalWorker.__nightshiftWorker = state;
  void startup(s).then(tick);
  console.log(`[worker] loop started (every ${TICK_MS / 1000}s, sweep every ${SWEEP_EVERY_MS / 60000} min)`);
}

