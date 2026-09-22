"use client";

import { usePathname } from "next/navigation";
import {
  NavCalendar,
  NavCustomers,
  NavRevenue,
  NavSettings,
  NavToday,
  StarMark,
} from "@/lib/icons";

const TABS = [
  { href: "/admin/bookings", label: "Today", Icon: NavToday },
  { href: "/admin/calendar", label: "Calendar", Icon: NavCalendar },
  { href: "/admin/customers", label: "Customers", Icon: NavCustomers },
  { href: "/admin/revenue", label: "Revenue", Icon: NavRevenue },
  { href: "/admin/settings", label: "Settings", Icon: NavSettings },
];

export default function BackstageNav() {
  const pathname = usePathname();

  return (
    <nav className="bs-nav" aria-label="Backstage">
      <span className="bs-nav-brand">
        <StarMark />
        <span>BACKSTAGE</span>
      </span>
      {TABS.map(({ href, label, Icon }) => {
        const current = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <a key={href} href={href} aria-current={current ? "page" : undefined}>
            <Icon />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
