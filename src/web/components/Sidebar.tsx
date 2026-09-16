"use client";

/**
 * Navigation.
 *
 * Ten destinations, grouped by what the operator is doing: watching the bot
 * work, checking whether it works, or changing how it works. A flat list of
 * ten would make the two that matter daily as hard to find as the eight that
 * do not.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

interface Item {
  href: string;
  label: string;
}

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "المباشر",
    items: [
      { href: "/", label: "لوحة القيادة" },
      { href: "/recommendations", label: "التوصيات" },
      { href: "/scanner", label: "الماسح" },
    ],
  },
  {
    title: "المراجعة",
    items: [
      { href: "/rejected", label: "التحليلات المرفوضة" },
      { href: "/performance", label: "الأداء" },
      { href: "/history", label: "السجل" },
    ],
  },
  {
    title: "التشغيل",
    items: [
      { href: "/health", label: "الصحة" },
      { href: "/settings", label: "الإعدادات" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  const isCurrent = (href: string): boolean =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className="sidebar" aria-label="التنقّل الرئيسي">
      <div className="brand">
        <div className="name">طاولة السلماني</div>
        <div className="role">ثماني مراحل · تنفيذ ورقي</div>
      </div>

      <div className="nav">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <div className="nav-group section-label">{group.title}</div>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="nav-item"
                aria-current={isCurrent(item.href) ? "page" : undefined}
              >
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        التنفيذ ورقي بالكامل. التداول الحقيقي معطّل.
      </div>
    </nav>
  );
}
