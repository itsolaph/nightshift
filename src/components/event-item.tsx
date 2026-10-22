// One timeline event, rendered for the live feed and the incident timeline.

import Link from "next/link";
import type { TimelineEvent } from "@/lib/domain";
import { clockTime } from "./ui";

const ACTOR: Record<TimelineEvent["actor"], { short: string; label: string }> = {
  watcher: { short: "W", label: "Watcher" },
  detector: { short: "D", label: "Detector" },
  agent: { short: "AI", label: "Agent" },
  policy: { short: "P", label: "Policy gate" },
  executor: { short: "EX", label: "Executor" },
  paypal: { short: "PP", label: "PayPal" },
  owner: { short: "You", label: "Owner" },
  system: { short: "S", label: "System" },
  lab: { short: "LAB", label: "Scenario lab" },
};

const SOURCE_LABEL: Record<string, string> = {
  "agent-toolkit": "via PayPal Agent Toolkit",
  "nightshift-rest": "via Nightshift REST client",
  ledger: "Nightshift ledger",
};

type Detail = Record<string, unknown> | null;

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function Body({ event, compact }: { event: TimelineEvent; compact: boolean }) {
  const d = (event.detail ?? null) as Detail;
  if (!d) return null;
  switch (event.kind) {
    case "agent_step":
    case "diagnosis":
      return d.text ? <div className={event.kind === "diagnosis" ? "quote" : "feed-detail"}>{str(d.text)}</div> : null;
    case "agent_tool":
      return (
        <div className="feed-detail">
          <div className="row small">
            <code>{str(d.tool)}</code>
            <span className="muted">{SOURCE_LABEL[str(d.source)] ?? ""}</span>
            <span className={d.ok ? "green" : "red"}>{d.ok ? "ok" : "error"}</span>
          </div>
          <div className="mono tiny muted" style={{ marginTop: 4 }}>args {str(d.args)}</div>
          {!compact ? (
            <details style={{ marginTop: 4 }}>
              <summary>Result</summary>
              <pre className="tiny">{str(d.result)}</pre>
            </details>
          ) : null}
        </div>
      );
    case "proposal":
      return d.rationale ? <div className="small muted">{str(d.rationale)}</div> : null;
    case "policy": {
      const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
      return reasons.length ? (
        <ul className="reasons" style={{ marginTop: 4 }}>
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null;
    }
    case "paypal_call":
      return (
        <div className="feed-detail mono tiny">
          PayPal-Request-Id: {str(d.requestId)}
          {d.body && !compact ? <pre style={{ marginTop: 4 }}>{str(d.body)}</pre> : null}
        </div>
      );
    case "paypal_response":
      return compact ? (
        <div className="mono tiny muted">debug id {str(d.debugId) || "n/a"}</div>
      ) : (
        <details className="feed-detail" open={false}>
          <summary>
            HTTP {str(d.status)}, debug id {str(d.debugId) || "n/a"}, {str(d.durationMs)} ms
          </summary>
          <pre className="tiny" style={{ marginTop: 4 }}>{str(d.body)}</pre>
        </details>
      );
    case "detected":
      return compact ? null : (
        <div className="small muted" style={{ marginTop: 2 }}>
          {str((d.evidence as Detail)?.summary)}
        </div>
      );
    case "approval":
      return d.reply ? <div className="quote">{str(d.reply)}</div> : d.reason ? <div className="small muted">{str(d.reason)}</div> : null;
    case "note": {
      const data = d.data as Detail;
      if (!data || compact) return null;
      return (
        <details className="feed-detail">
          <summary>Details</summary>
          <pre className="tiny">{str(data)}</pre>
        </details>
      );
    }
    default:
      return null;
  }
}

export function EventItem({ event, compact = false, link = false }: { event: TimelineEvent; compact?: boolean; link?: boolean }) {
  const actor = ACTOR[event.actor] ?? ACTOR.system;
  return (
    <div className="feed-item">
      <div className={`feed-icon ${event.actor}`} title={actor.label}>
        {actor.short}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="feed-title">
          {link && event.incidentId ? <Link href={`/incidents/${event.incidentId}`} style={{ color: "inherit" }}>{event.title}</Link> : event.title}
        </div>
        <div className="feed-meta">
          <span>{clockTime(event.at)}</span>
          <span>{actor.label}</span>
          {link && event.incidentId ? (
            <Link href={`/incidents/${event.incidentId}`} className="tiny">
              open incident
            </Link>
          ) : null}
        </div>
        <Body event={event} compact={compact} />
      </div>
    </div>
  );
}
