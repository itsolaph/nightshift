// SQLite storage through Node's built-in node:sqlite (no native add-on to compile). Ledger rows
// are JSON documents keyed by (kind, id); incidents, actions and the timeline have real columns
// where ordering, uniqueness or atomic status changes matter.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import {
  DEFAULT_SETTINGS,
  type ActionRecord,
  type ActionStatus,
  type CaptureAttempt,
  type Incident,
  type IncidentDraft,
  type IncidentStatus,
  type Ledger,
  type LedgerAuthorization,
  type LedgerCapture,
  type LedgerDispute,
  type LedgerInvoice,
  type LedgerOrder,
  type LedgerRefund,
  type Settings,
  type TimelineEvent,
} from "./domain";

type LedgerKinds = {
  order: LedgerOrder;
  authorization: LedgerAuthorization;
  capture: LedgerCapture;
  refund: LedgerRefund;
  invoice: LedgerInvoice;
  capture_attempt: CaptureAttempt;
  dispute: LedgerDispute;
};
export type LedgerKind = keyof LedgerKinds;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS ledger_order ON ledger(order_id);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_incident ON actions(incident_id);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_incident ON events(incident_id);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  verified INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const nowIso = () => new Date().toISOString();

type Row = Record<string, unknown>;
const parse = <T>(row: Row | undefined): T | null => (row ? (JSON.parse(String(row.data)) as T) : null);

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // --- Ledger -----------------------------------------------------------------------

  putLedger<K extends LedgerKind>(kind: K, doc: LedgerKinds[K]) {
    const orderId = "orderId" in doc ? (doc as { orderId: string }).orderId : kind === "order" ? doc.id : null;
    this.db
      .prepare(
        `INSERT INTO ledger (kind, id, order_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET order_id = excluded.order_id, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(kind, doc.id, orderId, JSON.stringify(doc), nowIso());
  }

  getLedger<K extends LedgerKind>(kind: K, id: string): LedgerKinds[K] | null {
    return parse(this.db.prepare("SELECT data FROM ledger WHERE kind = ? AND id = ?").get(kind, id) as Row | undefined);
  }

  listLedger<K extends LedgerKind>(kind: K): LedgerKinds[K][] {
    return (this.db.prepare("SELECT data FROM ledger WHERE kind = ? ORDER BY updated_at").all(kind) as Row[]).map(
      (r) => JSON.parse(String(r.data)),
    );
  }

  ledger(): Ledger {
    return {
      orders: this.listLedger("order"),
      authorizations: this.listLedger("authorization"),
      captures: this.listLedger("capture"),
      refunds: this.listLedger("refund"),
      invoices: this.listLedger("invoice"),
      captureAttempts: this.listLedger("capture_attempt"),
      disputes: this.listLedger("dispute"),
    };
  }

  // --- Incidents ----------------------------------------------------------------------

  /** Opens an incident unless one with the same dedupe key already exists. Returns the new incident or null. */
  openIncident(draft: IncidentDraft, detectedAt: string): Incident | null {
    const existing = this.db.prepare("SELECT id FROM incidents WHERE dedupe_key = ?").get(draft.dedupeKey);
    if (existing) return null;
    const now = nowIso();
    const incident: Incident = {
      ...draft,
      id: `inc_${randomUUID().slice(0, 12)}`,
      status: "open",
      savedCents: 0,
      detectedAt,
      createdAt: now,
      updatedAt: now,
      diagnosis: null,
      diagnosisSource: null,
      model: null,
    };
    this.db
      .prepare("INSERT INTO incidents (id, dedupe_key, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(incident.id, incident.dedupeKey, incident.status, JSON.stringify(incident), now, now);
    return incident;
  }

  getIncident(id: string): Incident | null {
    return parse(this.db.prepare("SELECT data FROM incidents WHERE id = ?").get(id) as Row | undefined);
  }

  listIncidents(): Incident[] {
    return (this.db.prepare("SELECT data FROM incidents ORDER BY created_at DESC").all() as Row[]).map((r) =>
      JSON.parse(String(r.data)),
    );
  }

  updateIncident(id: string, patch: Partial<Incident>): Incident {
    const current = this.getIncident(id);
    if (!current) throw new Error(`Unknown incident ${id}`);
    const next: Incident = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare("UPDATE incidents SET status = ?, data = ?, updated_at = ? WHERE id = ?")
      .run(next.status, JSON.stringify(next), next.updatedAt, id);
    return next;
  }

  /** Atomically moves an incident from one status to another; false when another worker got there first. */
  claimIncident(id: string, from: IncidentStatus[], to: IncidentStatus): boolean {
    return this.transaction(() => {
      const current = this.getIncident(id);
      if (!current || !from.includes(current.status)) return false;
      this.updateIncident(id, { status: to });
      return true;
    });
  }

  // --- Actions ------------------------------------------------------------------------

  insertAction(action: ActionRecord): ActionRecord {
    this.db
      .prepare(
        "INSERT INTO actions (id, incident_id, status, idempotency_key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        action.id,
        action.incidentId,
        action.status,
        action.idempotencyKey,
        JSON.stringify(action),
        action.createdAt,
        action.updatedAt,
      );
    return action;
  }

  findActionByKey(key: string): ActionRecord | null {
    return parse(this.db.prepare("SELECT data FROM actions WHERE idempotency_key = ?").get(key) as Row | undefined);
  }

  getAction(id: string): ActionRecord | null {
    return parse(this.db.prepare("SELECT data FROM actions WHERE id = ?").get(id) as Row | undefined);
  }

  listActions(incidentId?: string): ActionRecord[] {
    const rows = incidentId
      ? this.db.prepare("SELECT data FROM actions WHERE incident_id = ? ORDER BY created_at").all(incidentId)
      : this.db.prepare("SELECT data FROM actions ORDER BY created_at DESC").all();
    return (rows as Row[]).map((r) => JSON.parse(String(r.data)));
  }

  listActionsByStatus(status: ActionStatus): ActionRecord[] {
    return (
      this.db.prepare("SELECT data FROM actions WHERE status = ? ORDER BY created_at").all(status) as Row[]
    ).map((r) => JSON.parse(String(r.data)));
  }

  updateAction(id: string, patch: Partial<ActionRecord>): ActionRecord {
    const current = this.getAction(id);
    if (!current) throw new Error(`Unknown action ${id}`);
    const next: ActionRecord = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare("UPDATE actions SET status = ?, idempotency_key = ?, data = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.idempotencyKey, JSON.stringify(next), next.updatedAt, id);
    return next;
  }

  /** Atomic status transition for an action, so two approvals or two workers can't both execute it. */
  claimAction(id: string, from: ActionStatus[], to: ActionStatus, patch: Partial<ActionRecord> = {}): ActionRecord | null {
    return this.transaction(() => {
      const current = this.getAction(id);
      if (!current || !from.includes(current.status)) return null;
      return this.updateAction(id, { ...patch, status: to });
    });
  }

  // --- Timeline -----------------------------------------------------------------------

  addEvent(event: Omit<TimelineEvent, "seq" | "at"> & { at?: string }): TimelineEvent {
    const at = event.at ?? nowIso();
    const body = { actor: event.actor, title: event.title, detail: event.detail ?? null };
    const result = this.db
      .prepare("INSERT INTO events (incident_id, at, kind, data) VALUES (?, ?, ?, ?)")
      .run(event.incidentId, at, event.kind, JSON.stringify(body));
    return { ...event, ...body, at, seq: Number(result.lastInsertRowid) };
  }

  private toEvent(row: Row): TimelineEvent {
    const body = JSON.parse(String(row.data));
    return {
      seq: Number(row.seq),
      incidentId: (row.incident_id as string | null) ?? null,
      at: String(row.at),
      kind: row.kind as TimelineEvent["kind"],
      actor: body.actor,
      title: body.title,
      detail: body.detail,
    };
  }

  eventsSince(seq: number, limit = 200): TimelineEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as Row[]
    ).map((r) => this.toEvent(r));
  }

  recentEvents(limit = 100): TimelineEvent[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit) as Row[])
      .map((r) => this.toEvent(r))
      .reverse();
  }

  incidentEvents(incidentId: string): TimelineEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE incident_id = ? ORDER BY seq").all(incidentId) as Row[]
    ).map((r) => this.toEvent(r));
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as Row | undefined;
    return Number(row?.seq ?? 0);
  }

  // --- Webhooks -----------------------------------------------------------------------

  /** Records a webhook delivery; false when this event id was already stored (PayPal retries deliveries). */
  recordWebhook(id: string, eventType: string, verified: boolean, body: unknown): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO webhook_events (id, event_type, verified, received_at, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, eventType, verified ? 1 : 0, nowIso(), JSON.stringify(body));
    return Number(result.changes) > 0;
  }

  listWebhooks(limit = 50): { id: string; eventType: string; verified: boolean; receivedAt: string }[] {
    return (
      this.db
        .prepare("SELECT id, event_type, verified, received_at FROM webhook_events ORDER BY received_at DESC LIMIT ?")
        .all(limit) as Row[]
    ).map((r) => ({
      id: String(r.id),
      eventType: String(r.event_type),
      verified: Boolean(r.verified),
      receivedAt: String(r.received_at),
    }));
  }

  // --- Settings and small state -------------------------------------------------------

  settings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Row[];
    const stored = Object.fromEntries(rows.map((r) => [String(r.key), JSON.parse(String(r.value))]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS && value !== undefined) stmt.run(key, JSON.stringify(value));
    }
    return this.settings();
  }

  getKv<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }

  setKv(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  /** Wipes ledger, incidents, actions and the timeline. Settings survive. */
  resetData() {
    this.db.exec("DELETE FROM ledger; DELETE FROM incidents; DELETE FROM actions; DELETE FROM events; DELETE FROM webhook_events; DELETE FROM kv;");
  }
}

const globalStore = globalThis as unknown as { __nightshiftStore?: Store };

/** The process-wide store. Next.js dev reloads modules, so it is pinned on globalThis. */
export function store(): Store {
  if (!globalStore.__nightshiftStore) globalStore.__nightshiftStore = new Store(config().databasePath);
  return globalStore.__nightshiftStore;
}

export function setStore(s: Store) {
  globalStore.__nightshiftStore = s;
}
