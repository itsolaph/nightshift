import Link from "next/link";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { connections, summary } from "@/lib/summary";
import { IconArrow, IconShield } from "@/components/icons";
import { Money, clockTime } from "@/components/ui";

const LOSSES = [
  {
    title: "Authorizations that lapse",
    body: "You authorize at checkout and capture when you ship. After 3 days PayPal stops guaranteeing the funds; after 29 days the authorization is gone. A slow week in the roastery is enough.",
  },
  {
    title: "Captures that fail quietly",
    body: "The parcel has left, the capture came back INSTRUMENT_DECLINED, and the error went to a log nobody reads. The goods are gone and so is the money.",
  },
  {
    title: "Double charges and double refunds",
    body: "A double click charges the same cart twice; a retry in a support tool refunds the same $20 twice. Both turn into disputes or write-offs.",
  },
  {
    title: "Invoices nobody chases",
    body: "Wholesale invoices go overdue or get half paid. Nobody sends the reminder, because nobody is looking.",
  },
  {
    title: "Refund spikes",
    body: "A bad batch ships and refunds jump to a third of captures. You hear about it from the bank statement.",
  },
  {
    title: "Dispute deadlines",
    body: "A dispute waits for your response. Miss the date and PayPal closes it in the buyer's favour.",
  },
];

const FLOW = [
  { n: "01", title: "Watch", body: "Verified PayPal webhooks plus a sweep of Orders, Payments, Invoicing and Transaction Search build a local ledger." },
  { n: "02", title: "Detect", body: "Plain, tested code opens an incident with the money at risk, the deadline and the raw PayPal ids." },
  { n: "03", title: "Agent proposes", body: "An LLM reads the evidence with read-only PayPal tools and writes a diagnosis in plain English." },
  { n: "04", title: "Policy decides", body: "A deterministic gate, not the LLM, marks each proposal auto, needs approval or forbidden.", gate: true },
  { n: "05", title: "PayPal executes", body: "Only cleared actions run, with an idempotency key, and the full response lands in the audit trail." },
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

  return (
    <>
      <section className="hero">
        <div>
          <h1>
            The payments operator that works
            <br />
            the night shift.
          </h1>
          <p className="lede">
            For one-to-five-person PayPal shops. Small shops that charge when they ship lose money quietly: authorizations lapse, captures fail after the parcel has left, buyers get charged twice. Nightshift watches every order, authorization, capture, refund and invoice on your PayPal account, fixes the safe problems itself and asks you before anything risky.
          </p>
          <div className="actions">
            <Link href="/lab" className="btn primary big">
              Try the scenario lab <IconArrow size={16} />
            </Link>
            <Link href="/tonight" className="btn big">
              Open tonight&apos;s feed
            </Link>
          </div>
          <div className="status-strip" style={{ marginTop: 22 }}>
            <span>PayPal sandbox {conn.paypal ? "connected" : "not connected"}</span>
            <span>{conn.llm ? `AI agent (${conn.llmModel})` : "Rule-based triage (no LLM key)"}</span>
            <span>{conn.webhookId ? "Webhooks verified" : "Sweep only (no webhook)"}</span>
          </div>
        </div>

        <div className="moon-card">
          <div className="spread" style={{ marginBottom: 14 }}>
            <strong>Last night</strong>
            <span className="badge">
              <IconShield size={14} /> AI proposes, policy decides
            </span>
          </div>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div>
              <div className="kpi-label">Protected</div>
              <div className="kpi-value green">
                <Money cents={stats.savedCents} />
              </div>
            </div>
            <div>
              <div className="kpi-label">Waiting for you</div>
              <div className="kpi-value amber">{stats.awaitingApproval}</div>
            </div>
          </div>
          <div className="mini-feed">
            {recent.length === 0 ? (
              <p className="muted small">Nothing yet. Run the night in the scenario lab and this fills up with real sandbox activity.</p>
            ) : (
              recent.map((e) => (
                <div key={e.seq} className="item">
                  <span className="time">{clockTime(e.at)}</span>
                  <span>
                    {e.incidentId ? (
                      <Link href={`/incidents/${e.incidentId}`} style={{ color: "var(--ns-ink)" }}>
                        {e.title}
                      </Link>
                    ) : (
                      e.title
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Where the money goes</h2>
        <p className="sub">Six ways an authorize-then-capture shop loses money without noticing. Nightshift has a detector for each.</p>
        <div className="loss-list">
          {LOSSES.map((l) => (
            <div key={l.title} className="loss">
              <h3>{l.title}</h3>
              <p>{l.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>How it works</h2>
        <p className="sub">The agent never touches a money-moving PayPal endpoint. It can only propose; the policy gate decides and the executor calls PayPal.</p>
        <div className="flow">
          {FLOW.map((f) => (
            <div key={f.n} className={`flow-step ${f.gate ? "gate" : ""}`}>
              <div className="n">{f.n}</div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="card">
          <div className="spread">
            <div>
              <h2>See it on real sandbox data</h2>
              <p className="muted" style={{ marginTop: 6, maxWidth: 720 }}>
                The scenario lab creates real PayPal sandbox orders, failed captures, double refunds and overdue invoices, then moves Nightshift&apos;s detector clock forward. Every id you see can be looked up in the sandbox.
              </p>
            </div>
            <Link href="/lab" className="btn primary">
              Run the night
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
