"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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

const NARROW_PX = 640;

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
  // On narrow screens (grid under 640px) lead with what happened and the money at risk,
  // keep status, and hide Saved and Detected (Detected still drives the default sort).
  const wrap = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const check = () => setNarrow(el.clientWidth < NARROW_PX);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = useMemo<ColDef<Row>[]>(() => {
    const status: ColDef<Row> = { field: "status", headerName: "Status", width: narrow ? 108 : 124, cellRenderer: StatusCell, cellClass: "cell-center" };
    const title: ColDef<Row> = {
      field: "title", headerName: narrow ? "Incident" : "What happened", flex: 1, minWidth: narrow ? 130 : 200, tooltipField: "title", cellRenderer: TitleCell,
      // phones: wrap the title instead of cutting it to a few words; the row grows to fit
      ...(narrow ? { autoHeight: true, cellClass: "cell-wrap" } : {}),
    };
    const atRisk: ColDef<Row> = { field: "atRisk", headerName: "At risk", width: narrow ? 84 : 100, type: "rightAligned", cellClass: ["num", "ag-right-aligned-cell"], valueFormatter: (p) => usd(p.value) };
    const rest: ColDef<Row>[] = [
      { field: "saved", headerName: "Saved", width: 96, hide: narrow, type: "rightAligned", cellClass: ["num", "ag-right-aligned-cell"], valueFormatter: (p) => (p.value ? usd(p.value) : "") },
      {
        field: "detectedAt",
        headerName: "Detected",
        headerTooltip: "On Nightshift's detector clock (includes the demo offset)",
        width: 128,
        cellClass: "num",
        valueFormatter: (p) => String(p.value ?? "").replace("T", " ").slice(5, 16),
        sort: "desc",
        hide: narrow,
      },
    ];
    return narrow ? [title, atRisk, status, ...rest] : [status, title, atRisk, ...rest];
  }, [narrow]);
  return (
    <div ref={wrap} style={{ height: auto ? undefined : height, width: "100%" }}>
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
        maintainColumnOrder={false}
        domLayout={auto ? "autoHeight" : "normal"}
        rowHeight={54}
        tooltipShowDelay={400}
      />
    </div>
  );
}
