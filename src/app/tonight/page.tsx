import Link from "next/link";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { analyticsData, connections, summary } from "@/lib/summary";
import { EventItem } from "@/components/event-item";
import { IncidentsGrid } from "@/components/incidents-grid";
import { Kpi, Money } from "@/components/ui";
import { SweepButton } from "@/components/sweep-button";

export const metadata = { title: "Tonight" };

export default async function TonightPage() {
  await connection();
  const s = store();
  const stats = summary(s);
  const conn = connections(s);
  const events = s.recentEvents(80).reverse();
  const data = analyticsData(s);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>What Nightshift caught</h1>
          <p>Every incident the detectors opened, what the agent proposed, what the policy gate allowed and what PayPal answered. This page updates live.</p>
        </div>
        <div className="row">
          <SweepButton disabled={!conn.paypal} />
          <Link href="/lab" className="btn primary">
            Run the night
          </Link>
        </div>
      </div>

      {!conn.paypal ? (
        <div className="banner" style={{ marginBottom: 16 }}>
          PayPal sandbox credentials are not set, so Nightshift cannot read or seed sandbox data. Add them to <code>.env.local</code> (see the README) and restart.
        </div>
      ) : null}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Kpi label="Money protected" tone="green" value={<Money cents={stats.savedCents} />} sub={`${stats.autoExecuted} action(s) ran on autopilot`} />
        <Kpi label="Still at risk" tone="amber" value={<Money cents={stats.atRiskCents} />} sub={`${stats.open} open incident(s)`} />
        <Kpi label="Waiting for you" value={stats.awaitingApproval} sub={stats.awaitingApproval ? "See approvals" : "Nothing to decide"} />
        <Kpi label="Blocked by policy" tone={stats.blocked ? "red" : undefined} value={stats.blocked} sub="Proposals the gate refused" />
      </div>

      <div className="grid main-side">
        <div className="card flush">
          <div className="card-head" style={{ padding: "16px 18px 0" }}>
            <div>
              <h2>Incidents</h2>
              <p>Click a row for the diagnosis, the decision and the PayPal response.</p>
            </div>
            <span className="badge">{data.incidents.length}</span>
          </div>
          <div style={{ padding: 12 }}>
            <IncidentsGrid rows={data.incidents} height={560} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Live feed</h2>
              <p>Newest first.</p>
            </div>
          </div>
          <div className="feed feed-scroll">
            {events.length === 0 ? (
              <div className="empty">
                <h3>Quiet night so far</h3>
                <p>Run a scenario in the lab to see the watcher, the agent and the policy gate at work.</p>
              </div>
            ) : (
              events.map((e) => <EventItem key={e.seq} event={e} compact link />)
            )}
          </div>
        </div>
      </div>
    </>
  );
}
