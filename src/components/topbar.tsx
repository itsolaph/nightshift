import Link from "next/link";
import { connection } from "next/server";
import { store } from "@/lib/db";
import { summary } from "@/lib/summary";
import { BrandMark } from "./icons";
import { LiveRefresh } from "./live";
import { NavLinks } from "./nav-links";

export async function Topbar() {
  await connection();
  const s = summary(store());
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          <BrandMark />
          <span>Nightshift</span>
        </Link>
        <NavLinks approvals={s.awaitingApproval} />
        <div className="topbar-right">
          <Link
            href="/settings#clock"
            className={`clock-chip ${s.clockOffsetDays ? "" : "idle"}`}
            title="The demo clock only moves Nightshift's detector clock. PayPal always sees real time."
          >
            <span className="hide-sm">Demo clock: </span>+{s.clockOffsetDays} {s.clockOffsetDays === 1 ? "day" : "days"}
          </Link>
          <LiveRefresh />
        </div>
      </div>
    </header>
  );
}
