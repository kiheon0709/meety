"use client";

import { useRef } from "react";
import { usePathname } from "next/navigation";
import { switchMemberAction } from "@/lib/actions";
import type { Member } from "@/lib/types";
import { Avatar } from "./ui";

// 데모용 "나는 누구" 전환. 진짜 로그인 대신 쿠키. 바꾸면 같은 페이지로 다시 들어온다.
export function MemberSwitcher({ spaceId, members, me }: { spaceId: string; members: Member[]; me?: Member }) {
  const ref = useRef<HTMLFormElement>(null);
  const path = usePathname();
  if (!members.length) return null;
  return (
    <form ref={ref} action={switchMemberAction} className="relative inline-flex items-center gap-2 rounded-full bg-black/5 pl-1 pr-2 py-1 hover:bg-black/8 transition">
      <input type="hidden" name="space_id" value={spaceId} />
      <input type="hidden" name="next" value={path} />
      {me && <Avatar name={me.name} color={me.color} size={22} />}
      <select
        key={me?.id}
        name="member_id"
        defaultValue={me?.id}
        onChange={() => ref.current?.requestSubmit()}
        className="appearance-none bg-transparent text-[13px] font-medium pr-4 focus:outline-none cursor-pointer"
        aria-label="누구로 볼지"
      >
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute right-2 h-3 w-3 text-ink-3" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </form>
  );
}
