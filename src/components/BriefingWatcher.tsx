"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Thinking } from "./ui";

// 브리핑이 "쓰는 중"이면 3초마다 확인하고, 새로 써지면 화면을 새로 고친다.
export function BriefingWatcher({ spaceId, createdAt, compact = false }: { spaceId: string; createdAt: string | null; compact?: boolean }) {
  const router = useRouter();
  const seen = useRef(createdAt);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/spaces/${spaceId}/briefing`, { cache: "no-store" });
        if (!r.ok || !alive) return;
        const j = (await r.json()) as { state: string; created_at: string | null };
        if (j.state === "fresh" && j.created_at !== seen.current) {
          seen.current = j.created_at;
          router.refresh();
        }
      } catch {
        /* 다음 폴링 */
      }
    };
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [spaceId, router]);
  return (
    <span className={`inline-flex items-center gap-1.5 text-agent ${compact ? "text-[12px]" : "text-[13px]"}`}>
      <Thinking /> 미티가 다시 쓰는 중
    </span>
  );
}
