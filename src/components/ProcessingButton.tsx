"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "./SubmitButton";

const STAGES = [
  { at: 0, label: "받아 적는 중" },
  { at: 4, label: "지난 회의와 견주는 중" },
  { at: 18, label: "달라진 점 고르는 중" },
  { at: 38, label: "한 번 봐야 할 것 표시 중" },
];

// 서버 액션이 도는 동안 단계가 진행되는 것처럼 보여준다 (실제로는 한 번의 호출).
export function ProcessingButton({ children, className = "btn btn-md btn-primary" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const t0 = Date.now();
    const t = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => {
      clearInterval(t);
      setSec(0);
    };
  }, [pending]);
  const stage = [...STAGES].reverse().find((s) => sec >= s.at) ?? STAGES[0];
  return (
    <div className="inline-flex flex-col items-start gap-2">
      <button type="submit" disabled={pending} className={className}>
        {pending && <Spinner />}
        {pending ? `${stage.label}…` : children}
      </button>
      {pending && (
        <div className="flex items-center gap-1.5 pl-1">
          {STAGES.map((s, i) => (
            <span key={i} className={`h-1 rounded-full transition-all duration-700 ${sec >= s.at ? "w-6 bg-blue" : "w-3 bg-black/10"}`} />
          ))}
          <span className="text-[11px] text-ink-3 ml-1 tabular-nums">{sec}s</span>
        </div>
      )}
    </div>
  );
}
