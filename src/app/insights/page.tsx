import Link from "next/link";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { config } from "@/lib/config";
import { analyticsData } from "@/lib/summary";
import { DAY_MS } from "@/lib/clock";
import { InsightsLoader } from "@/components/insights/loader";
import { hasAnyData } from "@/components/insights/data";

export const metadata = { title: "Insights" };

export default async function InsightsPage() {
  await connection();
  const s = store();
  const cfg = config();
  const data = analyticsData(s);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>What the night cost, and what it saved</h1>
          <p>
            Money protected and at risk by incident type, authorization aging, refund and capture failure rates. Built with AG Studio; ask the assistant &ldquo;which incidents cost the most this week?&rdquo; and it builds the widget.
          </p>
        </div>
      </div>
      {hasAnyData(data) ? (
        <InsightsLoader
          data={data}
          licenseKey={cfg.agStudioLicense || undefined}
          aiModel={cfg.llm.configured ? cfg.llm.model : undefined}
          clockOffsetMs={s.settings().demoClockOffsetDays * DAY_MS}
        />
      ) : (
        <div className="sheet empty">
          <h3>No data yet</h3>
          <p>
            Run the night in the <Link href="/lab">scenario lab</Link> first; the dashboard reads Nightshift&apos;s ledger and incident log.
          </p>
        </div>
      )}
    </>
  );
}
