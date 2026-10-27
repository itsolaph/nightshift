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
          <h1>Every order and its money state</h1>
          <p>
            Nightshift&apos;s local copy of PayPal, refreshed by webhooks and a sweep every few minutes. Fulfilment comes from the shop: PayPal does not know whether a parcel left.
          </p>
        </div>
        <div className="head-aside">
          <dl className="head-figures">
            {balances.map((b) => (
              <div key={b.currency} title="GET /v1/reporting/balances (can lag up to 3 hours)">
                <dt>Sandbox balance</dt>
                <dd className="num">
                  {b.total ?? "?"} {b.currency}
                </dd>
              </div>
            ))}
            {sweep ? (
              <div>
                <dt>Last sweep</dt>
                <dd>
                  <span className="num">{sweep.at.slice(11, 16)}</span> UTC{sweep.errors.length ? `, ${sweep.errors.length} warning(s)` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          <SweepButton disabled={!config().paypal.configured} />
        </div>
      </div>
      {sweep?.errors.length ? (
        <details className="banner">
          <summary>Sweep warnings</summary>
          <ul className="small">
            {sweep.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <section className="sheet">
        <LedgerGrids data={data} webhooks={s.listWebhooks(200)} />
      </section>
    </>
  );
}
