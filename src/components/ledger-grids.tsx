"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { nightGridTheme } from "./grid-theme";
import type { AnalyticsData } from "@/lib/summary";

type Webhook = { id: string; eventType: string; verified: boolean; receivedAt: string };
type Props = { data: AnalyticsData; webhooks: Webhook[] };

const usd = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "");
const when = (v: unknown) => (v ? String(v).replace("T", " ").slice(0, 16) : "");
const money = (field: string, headerName: string): ColDef => ({ field, headerName, type: "rightAligned", width: 120, valueFormatter: (p) => usd(p.value) });
const date = (field: string, headerName: string, width = 160): ColDef => ({ field, headerName, width, valueFormatter: (p) => when(p.value) });
const id = (field: string, headerName: string, width = 190): ColDef => ({ field, headerName, width, cellClass: "mono" });

function Tone({ value }: ICellRendererParams) {
  const v = String(value ?? "");
  const tone = /COMPLETED|CAPTURED|PAID|shipped|true/.test(v)
    ? "green"
    : /DECLINED|FAILED|DENIED|VOIDED|EXPIRED|false|cancelled/.test(v)
      ? "red"
      : /CREATED|PENDING|SENT|PARTIALLY|UNPAID|unfulfilled/.test(v)
        ? "amber"
        : "";
  return <span className={`badge ${tone}`}>{v}</span>;
}

function FulfillmentCell({ data, value }: ICellRendererParams<AnalyticsData["orders"][number]>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const set = async (fulfillment: string) => {
    setBusy(true);
    await fetch(`/api/orders/${data.id}/fulfillment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fulfillment }),
    });
    setBusy(false);
    router.refresh();
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
      <Tone {...({ value } as ICellRendererParams)} />
      {value !== "shipped" ? (
        <button className="btn small ghost" disabled={busy} onClick={() => set("shipped")}>
          Mark shipped
        </button>
      ) : null}
    </span>
  );
}

const TABS = ["Orders", "Authorizations", "Captures", "Failed capture calls", "Refunds", "Invoices", "Webhooks"] as const;

export function LedgerGrids({ data, webhooks }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Orders");

  const config = useMemo((): { rows: unknown[]; cols: ColDef[] } => {
    switch (tab) {
      case "Orders":
        return {
          rows: data.orders,
          cols: [
            id("id", "Order"),
            { field: "intent", width: 110 },
            { field: "status", width: 130, cellRenderer: Tone },
            money("amount", "Amount"),
            { field: "fulfillment", headerName: "Fulfilment", width: 210, cellRenderer: FulfillmentCell },
            { field: "payer", width: 200 },
            { field: "cartRef", headerName: "Cart", width: 120 },
            { field: "description", flex: 1, minWidth: 200 },
            date("createdAt", "Created"),
            { field: "source", width: 100 },
          ],
        };
      case "Authorizations":
        return {
          rows: data.authorizations,
          cols: [
            id("id", "Authorization"),
            id("orderId", "Order"),
            { field: "status", width: 150, cellRenderer: Tone },
            money("amount", "Authorized"),
            money("uncaptured", "Uncaptured"),
            { field: "ageDays", headerName: "Age (days)", width: 110, type: "rightAligned" },
            date("honorEndsAt", "Honor period ends"),
            date("expiresAt", "Expires"),
            { field: "daysToExpiry", headerName: "Days left", width: 105, type: "rightAligned" },
            { field: "fulfillment", headerName: "Fulfilment", width: 130, cellRenderer: Tone },
          ],
        };
      case "Captures":
        return {
          rows: data.captures,
          cols: [
            id("id", "Capture"),
            id("orderId", "Order"),
            id("authorizationId", "Authorization"),
            { field: "status", width: 170, cellRenderer: Tone },
            money("amount", "Amount"),
            money("refunded", "Refunded"),
            date("createdAt", "Created"),
          ],
        };
      case "Failed capture calls":
        return {
          rows: data.captureAttempts,
          cols: [
            { field: "ok", headerName: "Result", width: 100, cellRenderer: Tone },
            id("authorizationId", "Authorization"),
            id("orderId", "Order"),
            { field: "httpStatus", headerName: "HTTP", width: 90 },
            { field: "error", headerName: "PayPal error", flex: 1, minWidth: 200 },
            { field: "source", headerName: "Called by", width: 120 },
            date("at", "When"),
          ],
        };
      case "Refunds":
        return {
          rows: data.refunds,
          cols: [id("id", "Refund"), id("captureId", "Capture"), id("orderId", "Order"), { field: "status", width: 140, cellRenderer: Tone }, money("amount", "Amount"), date("createdAt", "Created")],
        };
      case "Invoices":
        return {
          rows: data.invoices,
          cols: [
            { field: "number", width: 140 },
            id("id", "Invoice id", 230),
            { field: "status", width: 150, cellRenderer: Tone },
            { field: "recipient", width: 210 },
            money("total", "Total"),
            money("paid", "Paid"),
            money("owed", "Owed"),
            { field: "dueDate", headerName: "Due", width: 120 },
            date("lastReminderAt", "Last reminder"),
          ],
        };
      case "Webhooks":
        return {
          rows: webhooks,
          cols: [
            date("receivedAt", "Received"),
            { field: "eventType", headerName: "Event", flex: 1, minWidth: 240 },
            { field: "verified", width: 120, cellRenderer: Tone },
            id("id", "Event id", 280),
          ],
        };
    }
  }, [tab, data, webhooks]);

  const counts: Record<(typeof TABS)[number], number> = {
    Orders: data.orders.length,
    Authorizations: data.authorizations.length,
    Captures: data.captures.length,
    "Failed capture calls": data.captureAttempts.filter((a) => !a.ok).length,
    Refunds: data.refunds.length,
    Invoices: data.invoices.length,
    Webhooks: webhooks.length,
  };

  return (
    <div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t} <span className="faint">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div className="grid-box">
        <AgGridReact
          key={tab}
          theme={nightGridTheme}
          rowData={config.rows}
          columnDefs={config.cols}
          getRowId={(p) => String((p.data as { id: string }).id)}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          overlayNoRowsTemplate="Nothing here yet."
          enableCellTextSelection
        />
      </div>
    </div>
  );
}
