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
          <p>Refunds, voids, captures above the evidence and anything needing your judgement stop here, with the exact PayPal call, before it runs.</p>
        </div>
      </div>

      {waiting.length === 0 ? (
        <div className="sheet empty">
          <h3>All clear</h3>
          <p>
            When the policy gate routes something to you it shows up here{process.env.TELEGRAM_BOT_TOKEN ? " and in Telegram" : ""}. Try the <Link href="/lab">scenario lab</Link> to create a double charge.
          </p>
        </div>
      ) : (
        <div className="approval-list">
          {waiting.map((action) => {
            const incident = s.getIncident(action.incidentId);
            return (
              <article key={action.id} className="approval sheet">
                <header className="approval-head">
                  <div>
                    <p className="approval-kind">
                      <span className="word signal">{action.type === "ask_owner" ? "Question from the agent" : actionLabel(action.type)}</span>
                      <span className="muted">{timeAgo(action.createdAt)}</span>
                    </p>
                    {incident ? (
                      <h2>
                        <Link href={`/incidents/${incident.id}`}>{incident.title}</Link>
                      </h2>
                    ) : null}
                    {incident ? <p className="small muted">{INCIDENT_LABELS[incident.type]}</p> : null}
                  </div>
                  {action.amountCents ? (
                    <div className="approval-amount">
                      <span className="small muted">Amount</span>
                      <span className="amount">
                        <Money cents={action.amountCents} currency={action.currency ?? "USD"} />
                      </span>
                    </div>
                  ) : null}
                </header>
                <div className="approval-body">
                  <div className="approval-read">
                    {action.type === "ask_owner" && action.note ? <p className="quote">{action.note}</p> : null}
                    {incident?.diagnosis ? (
                      <div>
                        <h3 className="label">{incident.diagnosisSource === "llm" ? "Agent's diagnosis" : "Rule-based diagnosis"}</h3>
                        <p className="prose">{incident.diagnosis}</p>
                      </div>
                    ) : null}
                    <div>
                      <h3 className="label">{action.proposedBy === "agent" ? "Why the agent proposed it" : "Why"}</h3>
                      <p className="prose">{action.rationale}</p>
                    </div>
                  </div>
                  <div className="approval-verdict">
                    <div className="verdict">
                      <h3 className="label">Policy said</h3>
                      <DecisionBadge decision={action.decision} />
                      <ul className="reasons">
                        {action.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                    {action.type !== "ask_owner" ? (
                      <div>
                        <h3 className="label">What happens if you approve</h3>
                        <PayPalCallView call={action.call} />
                      </div>
                    ) : null}
                  </div>
                </div>
                <footer className="approval-foot">
                  <ApprovalControls action={action} />
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {decided.length ? (
        <section className="section">
          <h2>Recently decided</h2>
          <table className="ledger decided">
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Action</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Decided by</th>
                <th scope="col" className="num">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>
                    <ActionStatus status={a.status} />
                  </td>
                  <td>
                    <Link href={`/incidents/${a.incidentId}`}>{actionLabel(a.type)}</Link>
                  </td>
                  <td className="num">{a.amountCents ? <Money cents={a.amountCents} currency={a.currency ?? "USD"} /> : null}</td>
                  <td>{a.decidedBy}</td>
                  <td className="num muted">{timeAgo(a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
