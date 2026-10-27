import { connection } from "next/server";
import { store } from "@/lib/db";
import { config } from "@/lib/config";
import { labRunning, pendingApproval, SCENARIOS } from "@/lib/scenarios";
import { LabPanel } from "@/components/lab-panel";
import { EventItem } from "@/components/event-item";

export const metadata = { title: "Scenario lab" };

export default async function LabPage() {
  await connection();
  const s = store();
  const running = labRunning(s);
  const approval = running ? pendingApproval(s) : null;
  const cardsRefused = Boolean(s.getKv<boolean>("lab:cardsRefused"));
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
          <h1>Make the problems happen, for real</h1>
          <p>
            Nobody should wait 29 days to see this work. The lab creates real sandbox objects (paid orders, failed captures via negative testing, double refunds, overdue invoices), then the production watcher, detectors, agent and policy gate take over.
          </p>
        </div>
      </div>
      <div className="banner">
        Sandbox only. The demo clock moves Nightshift&apos;s detector clock, never PayPal&apos;s. A capture or reauthorization is a real sandbox call, so PayPal may answer differently from what the detector clock suggests (for example, refusing to reauthorize an authorization that is really minutes old). Those answers are recorded as they are.
      </div>
      {cardsRefused ? (
        <div className="banner info">
          This sandbox app cannot take card payments directly, so the lab pays through PayPal checkout: a sandbox buyer approves each order on PayPal&apos;s page (guest checkout with a test
          card), then the shop authorizes or captures it. The card-trigger scenario is skipped.
        </div>
      ) : null}
      {approval ? (
        <div className="banner signal">
          Waiting for a buyer to approve order <code>{approval.orderId}</code>.{" "}
          <a href={approval.url} target="_blank" rel="noreferrer">
            Open PayPal sandbox checkout
          </a>{" "}
          and pay as a guest with any sandbox test card, or log in with a sandbox personal account.
        </div>
      ) : null}
      {!cfg.paypal.configured ? (
        <div className="banner bad">
          PayPal sandbox credentials are missing, so the lab is disabled. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local.
        </div>
      ) : null}
      <LabPanel
        scenarios={SCENARIOS.map(({ id, title, story, incidentTypes, clockDays }) => ({ id, title, story, incidentTypes, clockDays }))}
        running={Boolean(running)}
        paypal={cfg.paypal.configured}
      />
      <section className="section">
        <div className="spread">
          <h2>Lab log</h2>
          {running ? (
            <span className="small">
              Running <code className="pid">{running.runId}</code>
            </span>
          ) : null}
        </div>
        <div className="sheet log-sheet">
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
      </section>
    </>
  );
}
