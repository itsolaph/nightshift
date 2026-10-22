"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconChart, IconFeed, IconFlask, IconGear, IconInbox, IconLedger } from "./icons";

const LINKS = [
  { href: "/tonight", label: "Tonight", icon: IconFeed },
  { href: "/approvals", label: "Approvals", icon: IconInbox, badge: true },
  { href: "/ledger", label: "Ledger", icon: IconLedger },
  { href: "/insights", label: "Insights", icon: IconChart },
  { href: "/lab", label: "Scenario lab", short: "Lab", icon: IconFlask },
  { href: "/settings", label: "Settings", icon: IconGear },
];

export function NavLinks({ approvals }: { approvals: number }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(({ href, label, short, icon: Icon, badge }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`) || (href === "/tonight" && pathname.startsWith("/incidents"));
        return (
          <Link key={href} href={href} className={active ? "active" : undefined}>
            <Icon size={17} />
            <span>
              {short ? (
                <>
                  <span className="hide-sm">{label}</span>
                  <span className="show-sm">{short}</span>
                </>
              ) : (
                label
              )}
            </span>
            {badge && approvals > 0 ? <span className="count">{approvals}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
