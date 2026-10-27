// Shared presentational pieces. Server-safe (no hooks) unless noted.

import { ACTION_LABELS, INCIDENT_LABELS, type ActionRecord, type ActionType, type Incident, type IncidentType, type PayPalRef } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { CopyId } from "./copy-id";

export function Money({ cents, currency = "USD", className }: { cents: number; currency?: string; className?: string }) {
  return <span className={`num ${className ?? ""}`}>{formatMoney(cents, currency)}</span>;
}

const STATUS: Record<Incident["status"], { label: string; tone: string }> = {
  open: { label: "Open", tone: "firm" },
  triaging: { label: "Agent working", tone: "" },
  awaiting_approval: { label: "Needs you", tone: "signal" },
  resolved: { label: "Resolved", tone: "quiet" },
  failed: { label: "Failed", tone: "firm" },
  dismissed: { label: "Closed by owner", tone: "quiet" },
};

export function IncidentStatus({ status }: { status: Incident["status"] }) {
  const s = STATUS[status];
  return <span className={`word ${s.tone}`}>{s.label}</span>;
}

export function IncidentTypeBadge({ type }: { type: IncidentType }) {
  return <span className="word quiet">{INCIDENT_LABELS[type]}</span>;
}

const DECISION: Record<ActionRecord["decision"], { label: string; tone: string }> = {
  auto: { label: "Auto", tone: "" },
  needs_approval: { label: "Needs approval", tone: "signal" },
  forbidden: { label: "Forbidden", tone: "firm" },
};

export function DecisionBadge({ decision }: { decision: ActionRecord["decision"] }) {
  const d = DECISION[decision];
  return <span className={`word decision ${d.tone}`}>{d.label}</span>;
}

const ACTION_STATUS: Record<ActionRecord["status"], { label: string; tone: string }> = {
  awaiting_approval: { label: "Waiting for you", tone: "signal" },
  approved: { label: "Approved", tone: "" },
  rejected: { label: "Rejected", tone: "quiet" },
  executing: { label: "Calling PayPal", tone: "" },
  succeeded: { label: "PayPal OK", tone: "" },
  failed: { label: "PayPal refused", tone: "firm" },
  blocked: { label: "Blocked by policy", tone: "firm" },
  done: { label: "Done", tone: "" },
};

export function ActionStatus({ status }: { status: ActionRecord["status"] }) {
  const s = ACTION_STATUS[status];
  return <span className={`word ${s.tone}`}>{s.label}</span>;
}

export const actionLabel = (type: string) => ACTION_LABELS[type as ActionType] ?? type;

export function PayPalId({ refItem }: { refItem: PayPalRef }) {
  return (
    <span className="pid-ref">
      <span className="pid-kind">{refItem.kind}</span>
      <CopyId id={refItem.id} />
    </span>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clockTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

export function PayPalCallView({ call }: { call: ActionRecord["call"] }) {
  if (!call) return <div className="call muted">No PayPal call. This action only changes Nightshift.</div>;
  return (
    <div className="call">
      <div>
        <span className="method">{call.method}</span> {call.path}
      </div>
      {call.body !== undefined ? <pre>{JSON.stringify(call.body, null, 2)}</pre> : null}
    </div>
  );
}
