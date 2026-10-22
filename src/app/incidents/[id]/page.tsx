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
    <div className="stack" style={{ gap: 10 }}>
      <div className="spread">
        <div className="row">
          <h3>{actionLabel(action.type)}</h3>
          {action.amountCents ? <Money cents={action.amountCents} currency={action.currency ?? "USD"} className="amber" /> : null}
          {action.targetId && action.type !== "ask_owner" ? <code className="pid">{action.targetId}</code> : null}
        </div>
        <ActionStatus status={action.status} />
      </div>
      <div className="triptych">
        <div className="agent">
          <div className="label">{action.proposedBy === "agent" ? "Agent proposed" : action.proposedBy === "rules" ? "Rules proposed" : "Owner proposed"}</div>
          <p className="small">{action.rationale}</p>
          {action.note ? <p className="small muted" style={{ marginTop: 6 }}>Note: {action.note}</p> : null}
        </div>
        <div className="policy">
          <div className="label">Policy said</div>
          <DecisionBadge decision={action.decision} />
          <ul className="reasons" style={{ marginTop: 8 }}>
            {action.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {action.decidedBy && action.decidedBy !== "policy" ? <p className="tiny muted" style={{ marginTop: 6 }}>Decided by {action.decidedBy}</p> : null}
        </div>
        <div className="paypal">
          <div className="label">PayPal returned</div>
          {response ? (
            <>
              <div className={`small ${response.status >= 200 && response.status < 300 ? "green" : "red"}`}>
                HTTP {response.status} {response.debugId ? <span className="muted mono tiny">debug id {response.debugId}</span> : null}
              </div>
              <details style={{ marginTop: 6 }}>
                <summary>Response body</summary>
                <pre className="tiny" style={{ marginTop: 6 }}>{JSON.stringify(response.body, null, 2)}</pre>
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
        <details>
          <summary>Exact API call{action.idempotencyKey ? ` (PayPal-Request-Id ${action.idempotencyKey})` : ""}</summary>
          <div style={{ marginTop: 8 }}>
            <PayPalCallView call={action.call} />
          </div>
        </details>
      ) : null}
      {action.status === "awaiting_approval" ? <ApprovalControls action={action} /> : null}
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
      <div className="page-head">
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <Link href="/tonight" className="small">
              Tonight
            </Link>
            <span className="faint">/</span>
            <span className="small muted">{INCIDENT_LABELS[incident.type]}</span>
          </div>
          <h1>{incident.title}</h1>
          <div className="row" style={{ marginTop: 10 }}>
            <IncidentStatus status={incident.status} />
            <span className="badge amber">At risk {formatMoney(incident.atRiskCents, incident.currency)}</span>
            {incident.savedCents ? <span className="badge green">Protected {formatMoney(incident.savedCents, incident.currency)}</span> : null}
            {incident.deadline ? <span className="badge">Deadline {incident.deadline.slice(0, 16).replace("T", " ")} UTC</span> : null}
            <span className="badge">Detected {incident.detectedAt.slice(0, 16).replace("T", " ")} (detector clock)</span>
          </div>
        </div>
      </div>

      <div className="grid main-side">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Diagnosis</h2>
              {incident.diagnosisSource === "llm" ? (
                <span className="badge violet">AI agent{incident.model ? ` (${incident.model})` : ""}</span>
              ) : incident.diagnosisSource === "rules" ? (
                <span className="badge" title="No LLM key configured, or the LLM call failed">Rule-based (no LLM)</span>
              ) : (
                <span className="badge violet">Agent working</span>
              )}
            </div>
            {incident.diagnosis ? <p className="quote" style={{ fontSize: "1rem" }}>{incident.diagnosis}</p> : <p className="muted">The agent is reading the evidence.</p>}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Decisions</h2>
                <p>The agent proposes, the policy gate decides, the executor calls PayPal.</p>
              </div>
            </div>
            {actions.length === 0 ? (
              <p className="muted">No proposals yet.</p>
            ) : (
              <div className="stack">
                {actions.map((a, i) => (
                  <div key={a.id}>
                    {i > 0 ? <hr className="sep" style={{ marginBottom: 16 }} /> : null}
                    <ActionTriptych action={a} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Evidence</h2>
            </div>
            <p className="small" style={{ marginBottom: 12 }}>{incident.evidence.summary}</p>
            <dl className="facts">
              {facts.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k.replaceAll("_", " ")}</dt>
                  <dd>{v === null ? <span className="faint">none</span> : String(v)}</dd>
                </div>
              ))}
            </dl>
            <div className="row" style={{ marginTop: 14 }}>
              {incident.evidence.refs.map((r, i) => (
                <PayPalId key={`${r.kind}-${r.id}-${i}`} refItem={r} />
              ))}
            </div>
            <p className="tiny faint" style={{ marginTop: 10 }}>All ids are real PayPal sandbox objects; GET them with your sandbox credentials to check.</p>
          </div>
        </div>

        <div className="card">
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
        </div>
      </div>
    </>
  );
}
