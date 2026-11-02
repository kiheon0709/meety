"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fixAction, tellAction } from "@/lib/actions";
import type { TellResult } from "@/lib/service";
import { AgentMark } from "./Logo";
import { Spinner } from "./SubmitButton";

// "갈피에게 말하기" — 회의 밖에서 정한 걸 한 줄로. 갈피가 읽어서 업데이트로 바꾼다.
export function TellBar({ spaceId, nodeId, commitId, placeholder, compact = false }: { spaceId: string; nodeId?: string; commitId?: string; placeholder?: string; compact?: boolean }) {
  const [res, action, pending] = useActionState<TellResult | null, FormData>(commitId ? fixAction : tellAction, null);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const last = useRef<TellResult | null>(null);
  useEffect(() => {
    if (res && res !== last.current) {
      last.current = res;
      if (res.ok) {
        formRef.current?.reset();
        router.refresh();
      }
    }
  }, [res, router]);
  return (
    <div>
      <form ref={formRef} action={action} className={`composer flex items-center gap-2.5 ${compact ? "pl-3 pr-2 py-1.5" : "pl-4 pr-2.5 py-2"}`}>
        <input type="hidden" name="space_id" value={spaceId} />
        {nodeId && <input type="hidden" name="node_id" value={nodeId} />}
        {commitId && <input type="hidden" name="commit_id" value={commitId} />}
        <AgentMark size={compact ? 24 : 30} />
        <input
          name="text"
          required
          maxLength={300}
          disabled={pending}
          placeholder={placeholder ?? "미티에게 말하기 — 예: 로고는 지호가 맡기로 했어 / 가격 안건은 무료로 가기로 하고 닫자"}
          className={`flex-1 min-w-0 ${compact ? "text-[13.5px] py-1.5" : "text-[15px] py-2"}`}
          autoComplete="off"
        />
        <button className={`btn ${compact ? "btn-sm" : "btn-md"} btn-agent shrink-0`} disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? (commitId ? "다시 정리 중" : "읽는 중") : commitId ? "고쳐주세요" : "말하기"}
        </button>
      </form>
      {res && !pending && (
        <div className={`mt-2.5 text-[13px] leading-relaxed rounded-xl px-3.5 py-2.5 flex gap-2.5 items-start ${res.ok ? "bg-green/10 text-green-ink" : "bg-orange/10 text-amber-ink"}`}>
          <AgentMark size={20} className="mt-px" />
          <div>
          {res.ok ? (
            <>
              <span className="font-semibold">{commitId ? "다시 정리했어요" : res.pending ? "반영하고 팀에 한 번 봐달라고 했어요" : "반영했어요"}</span> · {res.message}
              {commitId && res.pending && <span className="text-ink-3"> · 팀에 한 번 봐달라고 했어요</span>}
              {res.commit_id && (
                <>
                  {" "}
                  <Link href={`/s/${spaceId}/c/${res.commit_id}`} className="underline underline-offset-4">
                    보기
                  </Link>
                </>
              )}
              {res.skipped.length > 0 && <span className="block text-ink-3 mt-0.5">일부는 반영하지 못했어요: {res.skipped.join(" · ")}</span>}
            </>
          ) : (
            <>
              <span className="font-semibold">반영하지 못했어요.</span> {res.understood} 조금 더 구체적으로 말해 주세요.
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
