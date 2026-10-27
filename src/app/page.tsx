import Link from "next/link";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { connections, summary } from "@/lib/summary";
import { DecisionBadge, Money, clockTime } from "@/components/ui";

const LOSSES = [
  {
    title: "Authorizations that lapse",
    cost: "After 3 days PayPal stops guaranteeing the funds; after 29 days the authorization is gone. A slow week in the roastery is enough.",
    does: "Captures shipped orders, reauthorizes unshipped ones, asks you before day 29.",
  },
  {
    title: "Captures that fail quietly",
    cost: "The parcel has left, the capture came back INSTRUMENT_DECLINED, and the error went to a log nobody reads.",
    does: "Asks you: contact the buyer, or retry the capture once.",
  },
  {
    title: "Double charges and double refunds",
    cost: "A double click charges a cart twice; a retry in a support tool refunds the same $20 twice. Disputes or write-offs.",
    does: "Proposes refunding the second charge; refunds always wait for you.",
  },
  {
    title: "Invoices nobody chases",
    cost: "Wholesale invoices go overdue or get half paid, and nobody sends the reminder.",
    does: "Sends a PayPal reminder, once per cooldown.",
  },
  {
    title: "Refund spikes",
    cost: "A bad batch ships and refunds jump to a third of captures. You hear about it from the bank statement.",
    does: "Flags the spike and asks you to check the batch.",
  },
  {
    title: "Dispute deadlines",
    cost: "Miss the date and PayPal closes it in the buyer's favour.",
    does: "Asks you to respond before the date.",
  },
];

const FLOW = [
  { title: "Watch", body: "Verified webhooks and a sweep of Orders, Payments, Invoicing and Transaction Search build a local ledger." },
  { title: "Detect", body: "Plain, tested code opens an incident with the money at risk, the deadline and the PayPal ids." },
  { title: "Agent proposes", body: "An LLM reads the evidence with read-only PayPal tools and writes a diagnosis." },
  { title: "Policy decides", body: "A deterministic gate, not the LLM, marks each proposal auto, needs approval or forbidden.", gate: true },
  { title: "PayPal executes", body: "Only cleared actions run, with an idempotency key; the response lands in the audit trail." },
];

export default async function Home() {
  await connection();
  const s = store();
  const stats = summary(s);
  const conn = connections(s);
  const recent = s
    .recentEvents(40)
    .filter((e) => ["detected", "policy", "outcome", "paypal_response"].includes(e.kind))
    .slice(-6)
    .reverse();
  const incidents = new Map(recent.flatMap((e) => (e.incidentId ? [[e.incidentId, s.getIncident(e.incidentId)] as const] : [])));
  const decisionOf = (detail: unknown) => {
    const d = (detail as { decision?: unknown } | null)?.decision;
    return d === "auto" || d === "needs_approval" || d === "forbidden" ? d : null;
  };

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>The payments operator on the night shift.</h1>
          <p className="lede">Fixes the safe PayPal problems itself and asks you before anything risky.</p>
          <div className="actions">
            <Link href="/lab" className="btn primary big">
              Try the scenario lab
            </Link>
            <Link href="/tonight" className="btn big">
              Open tonight&apos;s feed
            </Link>
          </div>
          <ul className="status-strip" aria-label="Connections">
            <li>PayPal sandbox {conn.paypal ? "connected" : "not connected"}</li>
            <li>{conn.llm ? `AI agent (${conn.llmModel})` : "Rule-based triage (no LLM key)"}</li>
            <li>{conn.webhookId ? "Webhooks verified" : "Sweep only (no webhook)"}</li>
          </ul>
        </div>

        <figure className="sheet night-sheet">
          <div className="sheet-head">
            <h2>Last night</h2>
            <dl className="sheet-figures">
              <div>
                <dt>Protected</dt>
                <dd>
                  <Money cents={stats.savedCents} />
                </dd>
              </div>
              <div>
                <dt>Waiting for you</dt>
                <dd className={`num ${stats.awaitingApproval ? "signal" : ""}`}>{stats.awaitingApproval}</dd>
              </div>
            </dl>
          </div>
          {recent.length === 0 ? (
            <p className="muted small sheet-empty">Nothing yet. Run the night in the scenario lab and this fills up with real sandbox activity.</p>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">What happened</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => {
                  const incident = e.incidentId ? incidents.get(e.incidentId) : undefined;
                  const decision = e.kind === "policy" ? decisionOf(e.detail) : null;
                  return (
                    <tr key={e.seq} className={decision === "needs_approval" ? "is-signal" : undefined}>
                      <td className="num time">{clockTime(e.at)}</td>
                      <td>{e.incidentId ? <Link href={`/incidents/${e.incidentId}`}>{e.title}</Link> : e.title}</td>
                      <td className="num">{incident ? <Money cents={incident.atRiskCents} currency={incident.currency} /> : null}</td>
                      <td>{decision ? <DecisionBadge decision={decision} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <figcaption>AI proposes, policy decides. Times in UTC.</figcaption>
        </figure>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Where the money goes</h2>
          <p className="sub">Six ways a one-to-five-person PayPal shop that charges when it ships loses money without noticing. Nightshift has a detector for each.</p>
        </div>
        <table className="ledger loss-table">
          <thead>
            <tr>
              <th scope="col">The failure</th>
              <th scope="col">What it costs</th>
              <th scope="col">What Nightshift does</th>
            </tr>
          </thead>
          <tbody>
            {LOSSES.map((l) => (
              <tr key={l.title}>
                <th scope="row">{l.title}</th>
                <td>{l.cost}</td>
                <td>{l.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="band">
        <div className="band-inner">
          <div className="section-head">
            <h2>How it works</h2>
            <p className="sub">The agent never touches a money-moving PayPal endpoint. It proposes; the policy gate decides; the executor calls PayPal.</p>
          </div>
          <ol className="flow">
            {FLOW.map((f) => (
              <li key={f.title} className={`flow-step ${f.gate ? "gate" : ""}`}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section closing">
        <div>
          <h2>See it on real sandbox data</h2>
          <p className="sub">
            The scenario lab creates real sandbox orders, failed captures, double refunds and overdue invoices, then moves the detector clock forward. Every id can be looked up in the sandbox.
          </p>
        </div>
        <Link href="/lab" className="btn primary">
          Run the night
        </Link>
      </section>
    </>
  );
}
