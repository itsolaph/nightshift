// Numbers for the dashboard header, landing page and the AG Studio data sources.

import type { Store } from "./db";
import { daysBetween, DAY_MS } from "./clock";
import { config } from "./config";
import { INCIDENT_LABELS, type Incident } from "./domain";
import { expiresAt, honorEndsAt, uncapturedCents } from "./detectors/helpers";
import { detectorClock } from "./engine";

export function summary(store: Store) {
  const incidents = store.listIncidents();
  const actions = store.listActions();
  const clock = detectorClock(store);
  const open = incidents.filter((i) => !["resolved", "dismissed"].includes(i.status));
  return {
    incidents: incidents.length,
    open: open.length,
    awaitingApproval: actions.filter((a) => a.status === "awaiting_approval").length,
    savedCents: incidents.reduce((sum, i) => sum + i.savedCents, 0),
    atRiskCents: open.reduce((sum, i) => sum + i.atRiskCents, 0),
    autoExecuted: actions.filter((a) => a.decision === "auto" && a.status === "succeeded").length,
    blocked: actions.filter((a) => a.status === "blocked").length,
    clockOffsetDays: clock.offsetDays,
    clockNow: clock.now().toISOString(),
  };
}

export function connections(store: Store) {
  const cfg = config();
  const sweep = store.getKv<{ at: string; errors: string[]; orders: number; invoices: number }>("sweep:last");
  return {
    paypal: cfg.paypal.configured,
    webhookId: cfg.paypal.webhookId || store.getKv<string>("webhook:id") || null,
    publicBaseUrl: cfg.publicBaseUrl || null,
    llm: cfg.llm.configured,
    llmModel: cfg.llm.model,
    llmBaseUrl: cfg.llm.baseUrl,
    telegram: cfg.telegram.configured,
    agStudioLicensed: Boolean(cfg.agStudioLicense),
    demoMode: cfg.demoMode,
    workerMode: cfg.workerMode,
    lastSweep: sweep,
  };
}

const dateOnly = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

/** Flat tables for AG Studio and AG Grid. Dates stay ISO strings; Studio fields use accessors to turn them into Dates. */
export function analyticsData(store: Store) {
  const ledger = store.ledger();
  const incidents = store.listIncidents();
  const actions = store.listActions();
  const now = detectorClock(store).now();

  const incidentRows = incidents.map((i: Incident) => ({
    id: i.id,
    type: INCIDENT_LABELS[i.type],
    typeKey: i.type,
    title: i.title,
    status: i.status,
    orderId: i.orderId,
    subjectId: i.subject?.id ?? null,
    atRisk: i.atRiskCents / 100,
    saved: i.savedCents / 100,
    currency: i.currency,
    detectedAt: i.detectedAt,
    detectedDay: dateOnly(i.createdAt),
    deadline: i.deadline,
    diagnosisSource: i.diagnosisSource ?? "pending",
  }));

  const actionRows = actions.map((a) => ({
    id: a.id,
    incidentId: a.incidentId,
    type: a.type,
    decision: a.decision,
    status: a.status,
    proposedBy: a.proposedBy,
    amount: a.amountCents === null ? null : a.amountCents / 100,
    createdAt: a.createdAt,
    paypalStatus: a.response?.status ?? null,
  }));

  const authorizationRows = ledger.authorizations.map((a) => {
    const age = daysBetween(a.createdAt, now);
    const honor = honorEndsAt(a);
    const expiry = expiresAt(a);
    return {
      id: a.id,
      orderId: a.orderId,
      status: a.status,
      amount: a.amountCents / 100,
      uncaptured: uncapturedCents(ledger, a) / 100,
      createdAt: a.createdAt,
      ageDays: Math.max(0, Math.floor(age)),
      ageBucket: age < 3 ? "0-3 days (honor)" : age < 10 ? "4-9 days" : age < 20 ? "10-19 days" : age < 29 ? "20-28 days" : "29+ (expired)",
      honorEndsAt: honor.toISOString(),
      expiresAt: expiry.toISOString(),
      daysToExpiry: Math.round(((expiry.getTime() - now.getTime()) / DAY_MS) * 10) / 10,
      fulfillment: ledger.orders.find((o) => o.id === a.orderId)?.fulfillment ?? "unknown",
    };
  });

  const captureRows = ledger.captures.map((c) => ({
    id: c.id,
    orderId: c.orderId,
    authorizationId: c.authorizationId,
    status: c.status,
    failed: ["DECLINED", "FAILED"].includes(c.status) ? 1 : 0,
    amount: c.amountCents / 100,
    refunded:
      ledger.refunds.filter((r) => r.captureId === c.id && ["COMPLETED", "PENDING"].includes(r.status)).reduce((s, r) => s + r.amountCents, 0) / 100,
    createdAt: c.createdAt,
    day: dateOnly(c.createdAt),
  }));

  const attemptRows = ledger.captureAttempts.map((a) => ({
    id: a.id,
    orderId: a.orderId,
    authorizationId: a.authorizationId,
    ok: a.ok,
    failed: a.ok ? 0 : 1,
    httpStatus: a.httpStatus,
    error: a.errorIssue ?? a.errorName ?? null,
    source: a.source,
    at: a.at,
  }));

  const refundRows = ledger.refunds.map((r) => ({
    id: r.id,
    captureId: r.captureId,
    orderId: r.orderId,
    status: r.status,
    amount: r.amountCents / 100,
    createdAt: r.createdAt,
    day: dateOnly(r.createdAt),
  }));

  const orderRows = ledger.orders.map((o) => ({
    id: o.id,
    intent: o.intent,
    status: o.status,
    amount: o.amountCents / 100,
    currency: o.currency,
    payer: o.payer,
    cartRef: o.cartRef,
    description: o.description,
    fulfillment: o.fulfillment,
    shippedAt: o.shippedAt,
    createdAt: o.createdAt,
    source: o.source,
  }));

  const invoiceRows = ledger.invoices.map((i) => ({
    id: i.id,
    number: i.number,
    status: i.status,
    recipient: i.recipient,
    total: i.totalCents / 100,
    paid: i.paidCents / 100,
    owed: (i.totalCents - i.paidCents) / 100,
    currency: i.currency,
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    lastReminderAt: i.lastReminderAt,
  }));

  return {
    asOf: now.toISOString(),
    incidents: incidentRows,
    actions: actionRows,
    authorizations: authorizationRows,
    captures: captureRows,
    captureAttempts: attemptRows,
    refunds: refundRows,
    orders: orderRows,
    invoices: invoiceRows,
  };
}

export type AnalyticsData = ReturnType<typeof analyticsData>;
