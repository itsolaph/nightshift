import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { INCIDENT_LABELS, type ActionRecord } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { EventItem } from "@/components/event-item";
import { ApprovalControls } from "@/components/approval-controls";
import {
  ActionStatus,
  DecisionBadge,
  IncidentStatus,
  Money,
  PayPalCallView,
  PayPalId,
  actionLabel,
} from "@/components/ui";

export async function generateMetadata({ params }: PageProps<"/incidents/[id]">) {
  const { id } = await params;
  return { title: `Incident ${id}` };
}

function ActionTriptych({ action }: { action: ActionRecord }) {
  const response = action.response;
  return (
    <div className="action">
      <div className="action-head">
        <h3>{actionLabel(action.type)}</h3>
        {action.amountCents ? <Money cents={action.amountCents} currency={action.currency ?? "USD"} className="action-amount" /> : null}
        {action.targetId && action.type !== "ask_owner" ? <code className="pid">{action.targetId}</code> : null}
        <span className="action-status">
          <ActionStatus status={action.status} />
        </span>
      </div>
      <div className="triptych">
        <div className="agent">
          <h4 className="label">{action.proposedBy === "agent" ? "Agent proposed" : action.proposedBy === "rules" ? "Rules proposed" : "Owner proposed"}</h4>
          <p className="prose">{action.rationale}</p>
          {action.note ? <p className="small muted">Note: {action.note}</p> : null}
        </div>
        <div className="policy">
          <h4 className="label">Policy said</h4>
          <DecisionBadge decision={action.decision} />
          <ul className="reasons">
            {action.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {action.decidedBy && action.decidedBy !== "policy" ? <p className="small muted">Decided by {action.decidedBy}</p> : null}
        </div>
        <div className="paypal">
          <h4 className="label">PayPal returned</h4>
          {response ? (
            <>
              <p className={`http ${response.status >= 200 && response.status < 300 ? "" : "firm"}`}>
                HTTP <span className="num">{response.status}</span>
              </p>
              {response.debugId ? <p className="small muted">debug id <span className="mono">{response.debugId}</span></p> : null}
              <details>
                <summary>Response body</summary>
                <pre className="tiny">{JSON.stringify(response.body, null, 2)}</pre>
              </details>
            </>
          ) : action.call ? (
            <p className="small muted">{action.status === "blocked" ? "Never called: the policy gate refused it." : action.status === "rejected" ? "Never called: the owner rejected it." : "Not called yet."}</p>
          ) : (
            <p className="small muted">No PayPal call for this action.</p>
          )}
        </div>
      </div>
      {action.call ? (
        <details className="api-call">
          <summary>Exact API call{action.idempotencyKey ? ` (PayPal-Request-Id ${action.idempotencyKey})` : ""}</summary>
          <PayPalCallView call={action.call} />
        </details>
      ) : null}
      {action.status === "awaiting_approval" ? (
        <div className="action-controls">
          <ApprovalControls action={action} />
        </div>
      ) : null}
    </div>
  );
}

export default async function IncidentPage({ params }: PageProps<"/incidents/[id]">) {
  await connection();
  const { id } = await params;
  const s = store();
  const incident = s.getIncident(id);
  if (!incident) notFound();
  const actions = s.listActions(id);
  const timeline = s.incidentEvents(id);
  const facts = Object.entries(incident.evidence.facts);

  return (
    <>
      <div className="page-head case-head">
        <div>
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/tonight">Tonight</Link>
            <span aria-hidden="true">/</span>
            <span className="muted">{INCIDENT_LABELS[incident.type]}</span>
          </nav>
          <h1>{incident.title}</h1>
        </div>
        <dl className="case-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <IncidentStatus status={incident.status} />
            </dd>
          </div>
          <div>
            <dt>At risk</dt>
            <dd className={`num ${incident.savedCents ? "" : "signal"}`}>{formatMoney(incident.atRiskCents, incident.currency)}</dd>
          </div>
          {incident.savedCents ? (
            <div>
              <dt>Protected</dt>
              <dd className="num">{formatMoney(incident.savedCents, incident.currency)}</dd>
            </div>
          ) : null}
          {incident.deadline ? (
            <div>
              <dt>Deadline, UTC</dt>
              <dd className="num">{incident.deadline.slice(0, 16).replace("T", " ")}</dd>
            </div>
          ) : null}
          <div>
            <dt>Detected (detector clock)</dt>
            <dd className="num">{incident.detectedAt.slice(0, 16).replace("T", " ")}</dd>
          </div>
        </dl>
      </div>

      <div className="grid main-side case">
        <div className="case-main">
          <section className="case-section diagnosis">
            <div className="card-head">
              <h2>Diagnosis</h2>
              {incident.diagnosisSource === "llm" ? (
                <span className="small muted">AI agent{incident.model ? ` (${incident.model})` : ""}</span>
              ) : incident.diagnosisSource === "rules" ? (
                <span className="small muted" title="No LLM key configured, or the LLM call failed">
                  Rule-based (no LLM)
                </span>
              ) : (
                <span className="small muted">Agent working</span>
              )}
            </div>
            {incident.diagnosis ? <p className="diagnosis-text">{incident.diagnosis}</p> : <p className="muted">The agent is reading the evidence.</p>}
          </section>

          <section className="case-section">
            <div className="card-head">
              <div>
                <h2>Decisions</h2>
                <p>The agent proposes, the policy gate decides, the executor calls PayPal.</p>
              </div>
            </div>
            {actions.length === 0 ? (
              <p className="muted">No proposals yet.</p>
            ) : (
              <div className="actions-list">
                {actions.map((a) => (
                  <ActionTriptych key={a.id} action={a} />
                ))}
              </div>
            )}
          </section>

          <section className="case-section">
            <div className="card-head">
              <h2>Evidence</h2>
            </div>
            <p className="prose">{incident.evidence.summary}</p>
            <dl className="facts">
              {facts.map(([k, v]) => (
                <div key={k} className="fact">
                  <dt>{k.replaceAll("_", " ")}</dt>
                  <dd className="num">{v === null ? <span className="muted">none</span> : String(v)}</dd>
                </div>
              ))}
            </dl>
            <div className="row refs">
              {incident.evidence.refs.map((r, i) => (
                <PayPalId key={`${r.kind}-${r.id}-${i}`} refItem={r} />
              ))}
            </div>
            <p className="small muted">All ids are real PayPal sandbox objects; GET them with your sandbox credentials to check.</p>
          </section>
        </div>

        <section className="side-panel">
          <div className="card-head">
            <div>
              <h2>Audit trail</h2>
              <p>Detected, diagnosed, decided, executed. Live.</p>
            </div>
          </div>
          <div className="feed">
            {timeline.map((e) => (
              <EventItem key={e.seq} event={e} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
