// AG Studio data sources built from Nightshift's ledger and incident log.

import type { AgDataSourcesDefinition, AgExpressionFieldDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from "ag-studio";
import type { AnalyticsData } from "@/lib/summary";
import type { NightshiftRegistry } from "./countdown-widget";

type Spec = [id: string, name: string, format: AgFormat, hide?: boolean];
const fields = (specs: Spec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({
    id,
    name,
    format,
    ...(format === "currencyFormat" ? { formatOptions: { format: "$#,##0.00" } } : {}),
    ...(hide ? { hide } : {}),
  }));

const manyToOne = (id: string, source: string, target: string): AgRelationDefinition => {
  const [sourceTable, sourceField] = source.split(".");
  const [targetTable, targetField] = target.split(".");
  return { id, source: { tableId: sourceTable, fieldId: sourceField }, target: { tableId: targetTable, fieldId: targetField }, type: "many-to-one" };
};

const ratio = (id: string, name: string, description: string, numerator: string, denominator: string): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: "percentageFormat",
  isMeasure: true,
  expression: { operator: "divide", inputs: [{ id: numerator, aggregation: "sum" }, { id: denominator, aggregation: "sum" }] },
});

const AGE_BUCKETS: Record<string, string> = {
  "0-3 days (honor)": "00-03 days (honor period)",
  "4-9 days": "04-09 days",
  "10-19 days": "10-19 days",
  "20-28 days": "20-28 days",
  "29+ (expired)": "29+ days (expired)",
};

export function buildStudioData(data: AnalyticsData): AgDataSourcesDefinition<NightshiftRegistry> {
  const open = (status: string) => !["resolved", "dismissed"].includes(status);
  const incidents = data.incidents.map((i) => ({
    ...i,
    openAtRisk: open(i.status) ? i.atRisk : 0,
    isOpen: open(i.status),
    detectedDay: i.detectedAt.slice(0, 10),
  }));
  const captureOutcomes = [
    ...data.captures.map((c) => ({ id: c.id, kind: `Capture ${c.status}`, failed: c.failed, attempts: 1, amount: c.amount, day: c.day })),
    ...data.captureAttempts
      .filter((a) => !a.ok)
      .map((a) => ({ id: a.id, kind: `Rejected call (${a.error ?? a.httpStatus})`, failed: 1, attempts: 1, amount: 0, day: a.at.slice(0, 10) })),
  ];
  const authorizations = data.authorizations.map((a) => ({ ...a, ageBucket: AGE_BUCKETS[a.ageBucket] ?? a.ageBucket }));

  return {
    description:
      "Nightshift's view of one small PayPal merchant (a coffee roaster) running authorize-then-capture. Incidents are money problems Nightshift detected; " +
      "actions are what the AI agent proposed and what the deterministic policy gate decided (auto, needs_approval, forbidden). Amounts are USD. " +
      "'At risk' is money that could be lost if nobody acts; 'Protected' is money Nightshift recovered or secured.",
    sources: [
      {
        id: "incidents",
        description: "One row per incident Nightshift opened. Use openAtRisk for money still at risk right now.",
        data: incidents,
        fields: fields([
          ["id", "Incident ID", "textFormat", true],
          ["type", "Incident Type", "textFormat"],
          ["typeKey", "Incident Type Key", "textFormat", true],
          ["title", "Incident", "textFormat"],
          ["status", "Incident Status", "textFormat"],
          ["orderId", "Order ID", "textFormat"],
          ["subjectId", "PayPal Object ID", "textFormat"],
          ["atRisk", "Money At Risk", "currencyFormat"],
          ["openAtRisk", "Open Money At Risk", "currencyFormat"],
          ["saved", "Money Protected", "currencyFormat"],
          ["isOpen", "Is Open", "booleanFormat"],
          ["detectedAt", "Detected At", "dateTimeFormat"],
          ["detectedDay", "Detected Day", "dateFormat"],
          ["deadline", "Deadline", "dateTimeFormat"],
          ["diagnosisSource", "Diagnosed By", "textFormat"],
        ]),
      },
      {
        id: "actions",
        description: "Every action proposed for an incident, with the policy gate's decision and the execution status.",
        data: data.actions,
        fields: fields([
          ["id", "Action ID", "textFormat", true],
          ["incidentId", "Incident ID", "textFormat", true],
          ["type", "Action Type", "textFormat"],
          ["decision", "Policy Decision", "textFormat"],
          ["status", "Action Status", "textFormat"],
          ["proposedBy", "Proposed By", "textFormat"],
          ["amount", "Action Amount", "currencyFormat"],
          ["createdAt", "Proposed At", "dateTimeFormat"],
          ["paypalStatus", "PayPal HTTP Status", "integerFormat"],
        ]),
      },
      {
        id: "authorizations",
        description: "PayPal authorizations in the ledger with their age on Nightshift's detector clock. Honor period 3 days, hard expiry 29 days.",
        data: authorizations,
        fields: fields([
          ["id", "Authorization ID", "textFormat"],
          ["orderId", "Authorization Order ID", "textFormat", true],
          ["status", "Authorization Status", "textFormat"],
          ["amount", "Authorized", "currencyFormat"],
          ["uncaptured", "Uncaptured", "currencyFormat"],
          ["ageDays", "Age (days)", "integerFormat"],
          ["ageBucket", "Age Bucket", "textFormat"],
          ["daysToExpiry", "Days To Expiry", "decimalFormat"],
          ["expiresAt", "Expires At", "dateTimeFormat"],
          ["honorEndsAt", "Honor Period Ends", "dateTimeFormat"],
          ["fulfillment", "Fulfilment", "textFormat"],
          ["createdAt", "Authorized At", "dateTimeFormat"],
        ]),
      },
      {
        id: "captures",
        description: "PayPal captures with refunded totals.",
        data: data.captures,
        fields: fields([
          ["id", "Capture ID", "textFormat"],
          ["orderId", "Capture Order ID", "textFormat", true],
          ["status", "Capture Status", "textFormat"],
          ["amount", "Captured", "currencyFormat"],
          ["refunded", "Refunded", "currencyFormat"],
          ["failed", "Failed Capture", "integerFormat", true],
          ["day", "Capture Day", "dateFormat"],
        ]),
      },
      {
        id: "captureOutcomes",
        name: "Capture Outcomes",
        description: "Every capture result: capture objects plus capture calls PayPal rejected outright. failed is 1 for a failure.",
        data: captureOutcomes,
        fields: fields([
          ["id", "Outcome ID", "textFormat", true],
          ["kind", "Outcome", "textFormat"],
          ["failed", "Failures", "integerFormat"],
          ["attempts", "Attempts", "integerFormat"],
          ["amount", "Outcome Amount", "currencyFormat"],
          ["day", "Outcome Day", "dateFormat"],
        ]),
      },
      {
        id: "refunds",
        description: "PayPal refunds.",
        data: data.refunds,
        fields: fields([
          ["id", "Refund ID", "textFormat"],
          ["captureId", "Refunded Capture ID", "textFormat", true],
          ["status", "Refund Status", "textFormat"],
          ["amount", "Refund Amount", "currencyFormat"],
          ["day", "Refund Day", "dateFormat"],
        ]),
      },
      {
        id: "invoices",
        description: "PayPal invoices (wholesale customers).",
        data: data.invoices,
        fields: fields([
          ["id", "Invoice ID", "textFormat", true],
          ["number", "Invoice", "textFormat"],
          ["status", "Invoice Status", "textFormat"],
          ["recipient", "Recipient", "textFormat"],
          ["total", "Invoice Total", "currencyFormat"],
          ["paid", "Invoice Paid", "currencyFormat"],
          ["owed", "Invoice Owed", "currencyFormat"],
          ["dueDate", "Due Date", "dateFormat"],
        ]),
      },
    ],
    relationships: [manyToOne("action-incident", "actions.incidentId", "incidents.id")],
    expressions: [
      ratio("refundRate", "Refund Rate", "Refunded / captured.", "captures.refunded", "captures.amount"),
      ratio("captureFailureRate", "Capture Failure Rate", "Failed capture outcomes / all capture outcomes.", "captureOutcomes.failed", "captureOutcomes.attempts"),
      ratio("protectedShare", "Protected Share", "Money protected / money that was at risk.", "incidents.saved", "incidents.atRisk"),
    ],
  };
}

export const hasAnyData = (data: AnalyticsData) => data.incidents.length + data.authorizations.length + data.captures.length > 0;
