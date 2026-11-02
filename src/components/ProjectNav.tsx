"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, House, ListChecks, MessagesSquare, Milestone, Settings, Users } from "lucide-react";

// 프로젝트 메뉴 (uiux-redesign.md §2). 데스크톱은 왼쪽 세로, 휴대폰은 가로로 밀리는 띠.
// also: 옛 주소도 가장 가까운 메뉴를 켠다
const ITEMS = [
  { key: "", label: "프로젝트 홈", icon: House, exact: true },
  { key: "/sessions", label: "회의", icon: MessagesSquare, also: ["/record", "/ask", "/briefing"] },
  { key: "/decisions", label: "결정 기록", icon: Milestone, also: ["/state", "/history", "/issues", "/n/", "/c/"] },
  { key: "/todos", label: "할 일", icon: ListChecks },
  { key: "/docs", label: "자료", icon: FileText },
  { key: "/members", label: "팀원", icon: Users },
  { key: "/settings", label: "설정", icon: Settings },
] as const;

export function ProjectNav({ spaceId, badges }: { spaceId: string; badges: Partial<Record<string, number>> }) {
  const path = usePathname();
  const base = `/s/${spaceId}`;
  return (
    <nav className="side-nav -mx-4 px-4 lg:mx-0 lg:px-0 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible [scrollbar-width:none]">
      {ITEMS.map((it) => {
        const href = base + it.key;
        const active = "exact" in it ? path === href : path.startsWith(href) || ("also" in it && it.also.some((p) => path.startsWith(base + p)));
        const Icon = it.icon;
        const n = badges[it.key];
        return (
          <Link key={it.key} href={href} aria-current={active ? "page" : undefined} className="shrink-0">
            <Icon strokeWidth={1.9} />
            <span className="lg:flex-1">{it.label}</span>
            {n ? <span className="inline-flex min-w-[18px] justify-center rounded-full bg-orange text-white text-[10.5px] font-semibold px-1.5 py-[1px]">{n}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
