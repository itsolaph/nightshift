import { connection } from "next/server";
import { store } from "@/lib/db";
import { config } from "@/lib/config";
import { labRunning, SCENARIOS } from "@/lib/scenarios";
import { LabPanel } from "@/components/lab-panel";
import { EventItem } from "@/components/event-item";

export const metadata = { title: "Scenario lab" };

export default async function LabPage() {
  await connection();
  const s = store();
  const running = labRunning(s);
  const log = s
    .recentEvents(300)
    .filter((e) => e.actor === "lab" || e.kind === "detected" || e.kind === "outcome" || e.kind === "policy")
    .slice(-60)
    .reverse();
  const cfg = config();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Scenario lab, sandbox only</div>
          <h1>Make the problems happen, for real</h1>
          <p>
            Nobody should have to wait 29 days to see this work. The lab creates real PayPal sandbox objects (card orders, failed captures via negative testing, double refunds, overdue invoices) and
            then gets out of the way: the same watcher, detectors, agent and policy gate that run in production take it from there.
          </p>
        </div>
      </div>
      <div className="banner" style={{ marginBottom: 16 }}>
        Sandbox only. The demo clock moves Nightshift&apos;s detector clock, never PayPal&apos;s. A capture or reauthorization is a real sandbox call, so PayPal may answer differently from what the detector clock suggests (for example, refusing to reauthorize an authorization that is really minutes old). Those answers are recorded as they are.
      </div>
      {!cfg.paypal.configured ? (
        <div className="banner bad" style={{ marginBottom: 16 }}>
          PayPal sandbox credentials are missing, so the lab is disabled. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local.
        </div>
      ) : null}
      <LabPanel
        scenarios={SCENARIOS.map(({ id, title, story, incidentTypes, clockDays }) => ({ id, title, story, incidentTypes, clockDays }))}
        running={Boolean(running)}
        paypal={cfg.paypal.configured}
      />
      <div className="section">
        <div className="spread">
          <h2>Lab log</h2>
          {running ? <span className="badge violet">Running {running.runId}</span> : null}
        </div>
        <div className="card" style={{ marginTop: 12 }}>
          {log.length ? (
            <div className="feed feed-scroll">
              {log.map((e) => (
                <EventItem key={e.seq} event={e} compact link />
              ))}
            </div>
          ) : (
            <p className="muted">Nothing yet.</p>
          )}
        </div>
      </div>
    </>
  );
}
