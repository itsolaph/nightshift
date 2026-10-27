"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/tonight", label: "Tonight" },
  { href: "/approvals", label: "Approvals", badge: true },
  { href: "/ledger", label: "Ledger" },
  { href: "/insights", label: "Insights" },
  { href: "/lab", label: "Scenario lab", short: "Lab" },
  { href: "/settings", label: "Settings" },
];

export function NavLinks({ approvals }: { approvals: number }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(({ href, label, short, badge }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`) || (href === "/tonight" && pathname.startsWith("/incidents"));
        return (
          <Link key={href} href={href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {short ? (
              <>
                <span className="hide-sm">{label}</span>
                <span className="show-sm">{short}</span>
              </>
            ) : (
              label
            )}
            {badge && approvals > 0 ? (
              <span className="count" aria-label={`${approvals} waiting`}>
                {approvals}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
