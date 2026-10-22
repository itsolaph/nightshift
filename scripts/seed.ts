// `npm run seed`: "Run the night" headlessly. Creates real PayPal sandbox objects, moves the demo
// clock (+1, +5, +27 days), runs the watcher, agent and policy gate, and prints the timeline.
// Uses the same SQLite file as the web app (DATABASE_PATH, default data/nightshift.db).
//
//   npm run seed             run the whole night
//   npm run seed -- --reset  clear local data first

import { loadEnvLocal } from "./env";

async function main() {
  loadEnvLocal();
  const { store } = await import("../src/lib/db");
  const { paypal } = await import("../src/lib/paypal/client");
  const { runTheNight } = await import("../src/lib/scenarios");
  const { summary } = await import("../src/lib/summary");
  const { formatMoney } = await import("../src/lib/money");

  const client = paypal();
  if (!client) {
    console.error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. Put your sandbox app credentials in .env.local.");
    process.exit(1);
  }
  const s = store();
  if (process.argv.includes("--reset")) {
    s.resetData();
    s.saveSettings({ demoClockOffsetDays: 0 });
    console.log("Local data cleared.");
  }

  let seq = s.lastSeq();
  const timer = setInterval(() => {
    for (const e of s.eventsSince(seq, 500)) {
      seq = e.seq;
      console.log(`${e.at.slice(11, 19)}  ${e.actor.padEnd(8)}  ${e.title}`);
    }
  }, 300);

  const outcome = await runTheNight(s, client);
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(timer);
  for (const e of s.eventsSince(seq, 500)) console.log(`${e.at.slice(11, 19)}  ${e.actor.padEnd(8)}  ${e.title}`);

  const stats = summary(s);
  console.log("\nScenarios:", Object.entries(outcome).map(([k, ok]) => `${ok ? "ok" : "FAILED"} ${k}`).join(", "));
  console.log(
    `Incidents: ${stats.incidents}, protected ${formatMoney(stats.savedCents)}, at risk ${formatMoney(stats.atRiskCents)}, waiting for approval ${stats.awaitingApproval}.`,
  );
  console.log("Open the app (npm run dev) and go to /tonight or /approvals.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
