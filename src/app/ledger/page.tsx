import { connection } from "next/server";
import { store } from "@/lib/db";
import { analyticsData } from "@/lib/summary";
import { LedgerGrids } from "@/components/ledger-grids";
import { SweepButton } from "@/components/sweep-button";
import { config } from "@/lib/config";

export const metadata = { title: "Ledger" };

export default async function LedgerPage() {
  await connection();
  const s = store();
  const data = analyticsData(s);
  const sweep = s.getKv<{ at: string; errors: string[] }>("sweep:last");
  const balances = s.getKv<{ currency: string; total: string | null; available: string | null }[]>("balances") ?? [];
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Ledger</div>
          <h1>Every order and its money state</h1>
          <p>
            Nightshift&apos;s local copy of PayPal: orders, authorizations, captures, refunds and invoices, refreshed by webhooks and a sweep every few minutes. Fulfilment comes from the shop, because PayPal does not know whether a parcel left.
          </p>
        </div>
        <div className="row">
          {balances.map((b) => (
            <span key={b.currency} className="badge" title="GET /v1/reporting/balances (can lag up to 3 hours)">
              Sandbox balance {b.total ?? "?"} {b.currency}
            </span>
          ))}
          {sweep ? (
            <span className="small muted">
              Last sweep {sweep.at.slice(11, 16)} UTC{sweep.errors.length ? `, ${sweep.errors.length} warning(s)` : ""}
            </span>
          ) : null}
          <SweepButton disabled={!config().paypal.configured} />
        </div>
      </div>
      {sweep?.errors.length ? (
        <details className="banner" style={{ marginBottom: 14 }}>
          <summary>Sweep warnings</summary>
          <ul className="small">
            {sweep.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="card">
        <LedgerGrids data={data} webhooks={s.listWebhooks(200)} />
      </div>
    </>
  );
}
