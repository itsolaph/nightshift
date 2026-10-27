"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { nightGridTheme } from "./grid-theme";
import type { AnalyticsData } from "@/lib/summary";

type Row = AnalyticsData["incidents"][number];

const STATUS_TONE: Record<string, string> = {
  open: "firm",
  triaging: "",
  awaiting_approval: "signal",
  resolved: "quiet",
  failed: "firm",
  dismissed: "quiet",
};
const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  triaging: "Agent working",
  awaiting_approval: "Needs you",
  resolved: "Resolved",
  failed: "Failed",
  dismissed: "Closed by owner",
};

const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v.toLocaleString("en-US", { style: "currency", currency: "USD" });

function StatusCell({ value }: ICellRendererParams<Row, string>) {
  return <span className={`word ${STATUS_TONE[value ?? ""] ?? ""}`}>{STATUS_LABEL[value ?? ""] ?? value}</span>;
}

function TitleCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  const triage = data.diagnosisSource === "llm" ? "AI agent" : data.diagnosisSource === "rules" ? "rules" : "triage pending";
  return (
    <div className="cell-two">
      <span>{data.title}</span>
      <span className="sub">
        <span>{data.type}</span>
        <span>{triage}</span>
      </span>
    </div>
  );
}

export function IncidentsGrid({ rows, height = 420 }: { rows: Row[]; height?: number }) {
  const auto = rows.length > 0 && rows.length <= 12;
  const router = useRouter();
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: "status", headerName: "Status", width: 124, cellRenderer: StatusCell, cellClass: "cell-center" },
      { field: "title", headerName: "What happened", flex: 1, minWidth: 200, tooltipField: "title", cellRenderer: TitleCell },
      { field: "atRisk", headerName: "At risk", width: 100, type: "rightAligned", cellClass: ["num", "ag-right-aligned-cell"], valueFormatter: (p) => usd(p.value) },
      { field: "saved", headerName: "Saved", width: 96, type: "rightAligned", cellClass: ["num", "ag-right-aligned-cell"], valueFormatter: (p) => (p.value ? usd(p.value) : "") },
      {
        field: "detectedAt",
        headerName: "Detected",
        headerTooltip: "On Nightshift's detector clock (includes the demo offset)",
        width: 128,
        cellClass: "num",
        valueFormatter: (p) => String(p.value ?? "").replace("T", " ").slice(5, 16),
        sort: "desc",
      },
    ],
    [],
  );
  return (
    <div style={{ height: auto ? undefined : height, width: "100%" }}>
      <AgGridReact<Row>
        theme={nightGridTheme}
        rowData={rows}
        columnDefs={columns}
        getRowId={(p) => p.data.id}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        rowStyle={{ cursor: "pointer" }}
        onRowClicked={(e) => e.data && router.push(`/incidents/${e.data.id}`)}
        overlayNoRowsTemplate="No incidents yet. Run a scenario in the lab, or wait for the next sweep."
        animateRows
        domLayout={auto ? "autoHeight" : "normal"}
        rowHeight={54}
        tooltipShowDelay={400}
      />
    </div>
  );
}
