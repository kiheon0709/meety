"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { askAction } from "@/lib/actions";
import type { AskResult } from "@/lib/service";
import { AgentMark } from "./Logo";
import { Spinner } from "./SubmitButton";

const EXAMPLES = ["녹음 방식 왜 바뀌었어?", "이름 후보 뭐 있었어?", "지호가 반대한 거 뭐야?", "지금 열린 할 일 누가 뭐 맡고 있어?"];

export function AskBox({ spaceId }: { spaceId: string }) {
  const [res, action, pending] = useActionState<AskResult | null, FormData>(askAction, null);
  const [log, setLog] = useState<{ q: string; a: AskResult }[]>([]);
  const [q, setQ] = useState("");
  const lastQ = useRef("");
  const seen = useRef<AskResult | null>(null);
  useEffect(() => {
    if (res && res !== seen.current) {
      seen.current = res;
      setLog((l) => [{ q: lastQ.current, a: res }, ...l]);
      setQ("");
    }
  }, [res]);
  return (
    <div className="space-y-4">
      <form
        action={(fd) => {
          lastQ.current = String(fd.get("question") ?? "");
          action(fd);
        }}
        className="composer pl-4 pr-2.5 py-2 flex items-center gap-2.5"
      >
        <input type="hidden" name="space_id" value={spaceId} />
        <AgentMark size={30} />
        <input name="question" value={q} onChange={(e) => setQ(e.target.value)} required maxLength={300} disabled={pending} placeholder="예: 녹음 방식 왜 바뀌었어?" className="flex-1 min-w-0 text-[15px] py-2" autoComplete="off" />
        <button className="btn btn-md btn-agent shrink-0" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "찾는 중" : "물어보기"}
        </button>
      </form>
      {log.length === 0 && !pending && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setQ(e)} className="btn btn-sm btn-secondary">
              {e}
            </button>
          ))}
        </div>
      )}
      <ul className="space-y-3">
        {log.map((it, i) => (
          <li key={i} className="card p-5 pop">
            <div className="text-[13px] text-ink-3">{it.q}</div>
            <div className="mt-2 flex gap-3">
              <AgentMark size={24} className="mt-0.5" />
              <p className={`text-[15px] leading-relaxed ${it.a.confident ? "" : "text-ink-2"}`}>{it.a.answer}</p>
            </div>
            {it.a.refs.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {it.a.refs.map((r, j) => (
                  <li key={j}>
                    <Link href={r.href} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] ${r.kind === "node" ? "bg-blue/10 text-blue" : "bg-black/5 text-ink-2"} hover:underline underline-offset-4`}>
                      {r.kind === "node" ? "항목" : "그때 한 말"} · {r.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 text-[11px] text-ink-3 font-mono">${it.a.cost_usd}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
