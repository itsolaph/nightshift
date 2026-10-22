"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { nightGridTheme } from "./grid-theme";
import type { AnalyticsData } from "@/lib/summary";

type Row = AnalyticsData["incidents"][number];

const STATUS_TONE: Record<string, string> = {
  open: "red",
  triaging: "violet",
  awaiting_approval: "amber",
  resolved: "green",
  failed: "red",
  dismissed: "",
};
const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  triaging: "Agent working",
  awaiting_approval: "Needs you",
  resolved: "Resolved",
  failed: "Failed",
  dismissed: "Dismissed",
};

const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v.toLocaleString("en-US", { style: "currency", currency: "USD" });

function StatusCell({ value }: ICellRendererParams<Row, string>) {
  return <span className={`badge ${STATUS_TONE[value ?? ""] ?? ""}`}>{STATUS_LABEL[value ?? ""] ?? value}</span>;
}

export function IncidentsGrid({ rows, height = 420 }: { rows: Row[]; height?: number }) {
  const router = useRouter();
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: "status", headerName: "Status", width: 140, cellRenderer: StatusCell },
      { field: "type", headerName: "Type", width: 170 },
      { field: "title", headerName: "What happened", flex: 1, minWidth: 260, tooltipField: "title" },
      { field: "atRisk", headerName: "At risk", width: 115, type: "rightAligned", valueFormatter: (p) => usd(p.value), sort: undefined },
      { field: "saved", headerName: "Protected", width: 115, type: "rightAligned", valueFormatter: (p) => (p.value ? usd(p.value) : "") },
      {
        field: "deadline",
        headerName: "Deadline",
        width: 130,
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : ""),
      },
      {
        field: "diagnosisSource",
        headerName: "Triage",
        width: 110,
        valueFormatter: (p) => (p.value === "llm" ? "AI agent" : p.value === "rules" ? "Rules" : "Pending"),
      },
      { field: "detectedAt", headerName: "Detected (detector clock)", width: 200, valueFormatter: (p) => String(p.value ?? "").replace("T", " ").slice(0, 16), sort: "desc" },
    ],
    [],
  );
  return (
    <div style={{ height, width: "100%" }}>
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
        tooltipShowDelay={400}
      />
    </div>
  );
}
