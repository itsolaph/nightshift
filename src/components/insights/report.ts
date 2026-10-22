// The default "Last night" report. Field ids refer to the data sources in ./data.ts; the canvas is
// 24 tracks wide.

import type { AgReportState, AgWidgetLayoutState } from "ag-studio";
import type { NightshiftRegistry } from "./countdown-widget";

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: "sum" as const });
const countd = (id: string) => ({ id, aggregation: "countd" as const });

const kpi = (text: string, value: { id: string; aggregation?: "sum" | "countd" }) => ({
  type: "value" as const,
  dataMapping: { value: [value] },
  format: title(text),
});

export const initialReport: AgReportState<NightshiftRegistry> = {
  selectedPageId: "overview",
  panels: { filters: { collapsed: true } },
  pages: [
    {
      id: "overview",
      widgets: {
        "kpi-protected": kpi("Money protected", sum("incidents.saved")),
        "kpi-at-risk": kpi("Still at risk", sum("incidents.openAtRisk")),
        "kpi-refund-rate": kpi("Refund rate", { id: "refundRate" }),
        "kpi-capture-failure": kpi("Capture failure rate", { id: "captureFailureRate" }),
        "risk-by-type": {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "incidents.type" }], valueKey: [sum("incidents.atRisk"), sum("incidents.saved")] },
          format: title("Money at risk and protected, by incident type"),
        },
        countdown: {
          type: "auth-countdown",
          dataMapping: {},
          format: { ...title("Authorization countdown"), style: { mode: "expiry", limit: 5 } },
        },
        "auth-aging": {
          type: "column-chart-grouped",
          dataMapping: { categoryKey: [{ id: "authorizations.ageBucket" }], valueKey: [sum("authorizations.uncaptured")] },
          format: title("Authorization aging: uncaptured money by age (detector clock)"),
        },
        decisions: {
          type: "donut-chart",
          dataMapping: { categoryKey: [{ id: "actions.decision" }], valueKey: [countd("actions.id")] },
          format: title("Policy decisions"),
        },
        "incidents-over-time": {
          type: "column-chart-stacked",
          dataMapping: { categoryKey: [{ id: "incidents.detectedDay" }], valueKey: [countd("incidents.id")], legendKey: [{ id: "incidents.type" }] },
          format: title("Incidents over time (detector clock)"),
        },
        "capture-outcomes": {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "captureOutcomes.kind" }], valueKey: [sum("captureOutcomes.attempts")] },
          format: title("Capture outcomes"),
        },
        "incident-list": {
          type: "grid",
          dataMapping: {
            cols: [{ id: "incidents.type" }, { id: "incidents.title" }, { id: "incidents.status" }, sum("incidents.atRisk"), sum("incidents.saved")],
          },
          format: title("Incidents"),
        },
      },
      widgetLayout: {
        "kpi-protected": at(0, 0, 6, 7),
        "kpi-at-risk": at(6, 0, 6, 7),
        "kpi-refund-rate": at(12, 0, 6, 7),
        "kpi-capture-failure": at(18, 0, 6, 7),
        "risk-by-type": at(0, 7, 15, 17),
        countdown: at(15, 7, 9, 17),
        "auth-aging": at(0, 24, 12, 16),
        decisions: at(12, 24, 12, 16),
        "incidents-over-time": at(0, 40, 12, 16),
        "capture-outcomes": at(12, 40, 12, 16),
        "incident-list": at(0, 56, 24, 18),
      },
    },
  ],
};
