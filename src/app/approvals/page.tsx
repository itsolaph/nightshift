import Link from "next/link";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { INCIDENT_LABELS } from "@/lib/domain";
import { ApprovalControls } from "@/components/approval-controls";
import { ActionStatus, DecisionBadge, Money, PayPalCallView, actionLabel, timeAgo } from "@/components/ui";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  await connection();
  const s = store();
  const waiting = s.listActionsByStatus("awaiting_approval");
  const decided = s
    .listActions()
    .filter((a) => a.decidedBy && a.decidedBy !== "policy" && a.status !== "awaiting_approval")
    .slice(0, 12);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{waiting.length ? `${waiting.length} decision${waiting.length === 1 ? "" : "s"} waiting for you` : "Nothing waiting for you"}</h1>
          <p>Anything that sends money back, cancels a payment, charges more than the evidence supports or needs your judgement stops here. You see the agent&apos;s reasoning, the policy&apos;s reasons and the exact PayPal call before it runs.</p>
        </div>
      </div>

      {waiting.length === 0 ? (
        <div className="card empty">
          <h3>All clear</h3>
          <p>
            When the policy gate routes something to you it shows up here{process.env.TELEGRAM_BOT_TOKEN ? " and in Telegram" : ""}. Try the <Link href="/lab">scenario lab</Link> to create a double charge.
          </p>
        </div>
      ) : (
        <div className="grid cols-2">
          {waiting.map((action) => {
            const incident = s.getIncident(action.incidentId);
            return (
              <article key={action.id} className="approval">
                <div className="approval-head">
                  <div className="spread">
                    <span className="badge amber">{action.type === "ask_owner" ? "Question from the agent" : actionLabel(action.type)}</span>
                    <span className="tiny faint">{timeAgo(action.createdAt)}</span>
                  </div>
                  {incident ? (
                    <h3 style={{ marginTop: 10 }}>
                      <Link href={`/incidents/${incident.id}`} style={{ color: "inherit" }}>
                        {incident.title}
                      </Link>
                    </h3>
                  ) : null}
                  {incident ? <div className="tiny muted">{INCIDENT_LABELS[incident.type]}</div> : null}
                </div>
                <div className="approval-body">
                  {action.amountCents ? (
                    <div>
                      <div className="tiny muted">Amount</div>
                      <div className="amount">
                        <Money cents={action.amountCents} currency={action.currency ?? "USD"} />
                      </div>
                    </div>
                  ) : null}
                  {action.type === "ask_owner" && action.note ? <p className="quote">{action.note}</p> : null}
                  {incident?.diagnosis ? (
                    <div>
                      <div className="tiny muted" style={{ marginBottom: 4 }}>
                        {incident.diagnosisSource === "llm" ? "Agent's diagnosis" : "Rule-based diagnosis"}
                      </div>
                      <p className="small">{incident.diagnosis}</p>
                    </div>
                  ) : null}
                  <div>
                    <div className="tiny muted" style={{ marginBottom: 4 }}>
                      {action.proposedBy === "agent" ? "Why the agent proposed it" : "Why"}
                    </div>
                    <p className="small">{action.rationale}</p>
                  </div>
                  <div>
                    <div className="row" style={{ marginBottom: 4 }}>
                      <span className="tiny muted">Policy said</span>
                      <DecisionBadge decision={action.decision} />
                    </div>
                    <ul className="reasons">
                      {action.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                  {action.type !== "ask_owner" ? (
                    <div>
                      <div className="tiny muted" style={{ marginBottom: 4 }}>
                        What happens if you approve
                      </div>
                      <PayPalCallView call={action.call} />
                    </div>
                  ) : null}
                </div>
                <div className="approval-foot">
                  <ApprovalControls action={action} />
                </div>
              </article>
            );
          })}
        </div>
      )}

      {decided.length ? (
        <div className="section">
          <h2>Recently decided</h2>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="feed">
              {decided.map((a) => (
                <div key={a.id} className="spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--ns-border)" }}>
                  <div className="row">
                    <ActionStatus status={a.status} />
                    <Link href={`/incidents/${a.incidentId}`}>{actionLabel(a.type)}</Link>
                    {a.amountCents ? <Money cents={a.amountCents} currency={a.currency ?? "USD"} className="muted small" /> : null}
                  </div>
                  <span className="tiny faint">
                    {a.decidedBy} · {timeAgo(a.updatedAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
