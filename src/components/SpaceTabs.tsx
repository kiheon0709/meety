"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SpaceTabs({ tabs }: { tabs: { href: string; label: string; badge?: number; exact?: boolean; alsoPrefix?: string[] }[] }) {
  const path = usePathname();
  return (
    <nav className="seg overflow-x-auto max-w-full">
      {tabs.map((t) => {
        const active = t.exact ? path === t.href : path.startsWith(t.href) || (t.alsoPrefix ?? []).some((p) => path.startsWith(p));
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}>
            {t.label}
            {t.badge ? <span className="ml-1.5 inline-flex min-w-[18px] justify-center rounded-full bg-orange text-white text-[10px] font-semibold px-1.5 py-[1px] align-middle">{t.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
