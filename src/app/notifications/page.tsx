import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { listMembersForUser, listSpacesForUser } from "@/lib/service";
import { listNotifications, markAllRead } from "@/lib/events";
import { hrefOf, fmtRelative } from "@/components/Feed";
import { AgentMark } from "@/components/Logo";
import { Avatar, Empty, fmtDateShort } from "@/components/ui";
import { plain } from "@/lib/plain";

export const dynamic = "force-dynamic";

// 갈피가 나에게 한 말. 열면 읽음 처리.
export default async function NotificationsPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/notifications");
  const memberIds = listMembersForUser(user.id).map((m) => m.id);
  const items = listNotifications(memberIds, 60);
  const spaceNames = new Map(listSpacesForUser(user.id).map((s) => [s.id, s.name]));
  const unreadIds = new Set(items.filter((n) => !n.read_at).map((n) => n.id));
  markAllRead(memberIds);

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 space-y-6">
      <div className="fade-up">
        <h1 className="text-[2rem] font-bold tracking-[-0.03em]">알림</h1>
        <p className="text-[15px] text-ink-2 mt-1">미티가 {user.name} 님에게 한 말이에요. 내 담당 할 일, 결론이 필요한 것, 반대가 들어온 것.</p>
      </div>
      {items.length === 0 ? (
        <Empty>아직 알림이 없어요. 내 담당 할 일이 생기거나 결론이 필요해지면 여기로 와요.</Empty>
      ) : (
        <ul className="fade-up card divide-hair overflow-hidden" style={{ "--i": 1 } as React.CSSProperties}>
          {items.map((n) => {
            const e = n.event;
            const href = hrefOf(e);
            const isAgent = e.actor === "agent";
            const fresh = unreadIds.has(n.id);
            const body = (
              <>
                <div className="relative shrink-0 mt-0.5">
                  {isAgent ? <AgentMark size={28} /> : <Avatar name={e.actor_member?.name ?? "?"} color={e.actor_member?.color} size={28} />}
                  {fresh && <span className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-orange ring-2 ring-surface" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-[14.5px] leading-snug ${fresh ? "font-semibold" : "font-medium"}`}>{plain(e.title)}</div>
                  <div className="text-[12px] text-ink-3 mt-0.5">
                    {spaceNames.get(e.space_id) ?? "예시"} · {fmtDateShort(e.created_at)} {fmtRelative(e.created_at)}
                  </div>
                  {e.detail && <p className="text-[13px] text-ink-2 mt-1 line-clamp-2">{plain(e.detail).split("\n")[0]}</p>}
                </div>
              </>
            );
            return (
              <li key={n.id} className={fresh ? "bg-orange/4" : ""}>
                {href ? (
                  <Link href={href} className="p-4 sm:px-5 flex gap-3.5 hover:bg-black/2 transition">
                    {body}
                  </Link>
                ) : (
                  <div className="p-4 sm:px-5 flex gap-3.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
