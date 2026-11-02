"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { STAGES, type Stage } from "@/lib/types";
import { AgentMark } from "./Logo";
import { Thinking } from "./ui";

type S = { status: string; stage: Stage | null; stage_detail: string | null; error: string | null };

// 백그라운드 파이프라인 진행을 폴링해서 단계별로 보여준다. 끝나면 페이지를 새로 고친다.
export function ProcessingStatus({ sessionId, initial }: { sessionId: string; initial: S }) {
  const [s, setS] = useState<S>(initial);
  const [sec, setSec] = useState(0);
  const router = useRouter();

  useEffect(() => {
    if (s.status === "done" || s.status === "error") return;
    const t0 = Date.now();
    const tick = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 500);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/status`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as S;
        setS(j);
        if (j.status === "done" || j.status === "error") router.refresh();
      } catch {
        /* 다음 폴링 */
      }
    }, 1500);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [sessionId, s.status, router]);

  const idx = STAGES.findIndex((x) => x.key === s.stage);
  const progress = s.status === "done" ? 1 : Math.max(0.04, (idx + 0.5) / STAGES.length);
  return (
    <div className="card-agent p-6">
      <div className="flex items-center gap-3">
        <AgentMark size={32} />
        <div className="min-w-0">
          <div className="font-semibold text-[16px] flex items-center gap-2">
            {s.status === "error" ? "정리하다가 멈췄어요" : "미티가 정리하는 중이에요"}
            {s.status !== "error" && <Thinking className="text-agent" />}
          </div>
          <div className="text-[12.5px] text-ink-3">지난 회의까지의 맥락과 견줘서 바뀐 것만 뽑아요 · {sec}초</div>
        </div>
      </div>
      <div className="mt-4 h-1.5 rounded-full bg-black/6 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progress * 100}%`, background: "var(--agent-grad)" }} />
      </div>
      <ol className="mt-5 space-y-3">
        {STAGES.map((st, i) => {
          const done = idx > i || s.status === "done";
          const active = idx === i && s.status !== "done";
          return (
            <li key={st.key} className="flex items-start gap-3">
              <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold transition ${done ? "bg-ink text-surface" : active ? "bg-agent/15 text-agent" : "bg-black/6 text-ink-3"}`}>
                {done ? "✓" : i + 1}
              </span>
              <div className="min-w-0">
                <div className={`text-[14.5px] ${active ? "font-semibold" : done ? "text-ink-2" : "text-ink-3"}`}>{st.label}</div>
                {active && s.stage_detail && <div className="text-[12.5px] text-agent mt-0.5">{s.stage_detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {s.status === "error" && <p className="mt-4 text-[13px] text-red">{s.error}</p>}
    </div>
  );
}
