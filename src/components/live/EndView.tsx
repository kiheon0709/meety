"use client";

import Link from "next/link";
import { ArrowRight, Hand } from "lucide-react";
import type { ChecklistItem } from "@/lib/live/contract";
import { AgentMark } from "@/components/Logo";
import { StatusIcon } from "./parts";
import type { LiveState, MeetingSetup } from "./state";

const S = (i: number) => ({ "--i": i }) as React.CSSProperties;
const GROUPS: { status: ChecklistItem["status"]; title: string; tone: string }[] = [
  { status: "done", title: "정해짐", tone: "text-green-ink" },
  { status: "open", title: "아직", tone: "text-ink-2" },
  { status: "no_owner", title: "담당 없음", tone: "text-amber-ink" },
];

// 회의 끝: 안건별 기대 산출물 체크리스트 + 처리 안 된 손든 항목 + 회의록으로
export function EndView({ state, setup, spaceId }: { state: LiveState; setup: MeetingSetup | null; spaceId?: string }) {
  const items = state.checklist;
  const leftover = state.hands.filter((h) => h.status === "pending");
  const href = spaceId ? (state.sessionId ? `/s/${spaceId}/sessions/${state.sessionId}` : `/s/${spaceId}/sessions`) : "/home";
  const count = (st: ChecklistItem["status"]) => items.filter((i) => i.status === st).length;
  // 안건(나와야 할 것)을 안 적은 회의(1:1 대화 등)는 체크리스트 대신 오늘 얘기한 것 요약
  const noAgenda = isNoAgenda(setup, items);
  const talked = state.lines.filter((l) => l.final && !l.echo && l.text.trim()).length;
  const answers = state.said.map((x) => x.sentences[0]).filter(Boolean);
  const headline = noAgenda || items.length === 0 ? "회의가 끝났어요" : count("done") === items.length ? "나와야 할 게 다 나왔어요" : `${items.length - count("done")}개가 아직 비어 있어요`;

  return (
    <main className="mx-auto max-w-[1120px] px-5 py-10 lg:py-12 lg:h-[calc(100dvh-56px)] lg:overflow-y-auto">
      <div className="fade-up flex items-center gap-2 text-[13px] font-semibold text-agent">
        <AgentMark size={22} /> 미티가 회의 끝에 확인했어요
      </div>
      <h1 className="fade-up mt-3 text-[30px] lg:text-[34px] font-bold tracking-[-0.03em]" style={S(1)}>
        {headline}
      </h1>
      <p className="fade-up mt-1 text-[15px] text-ink-2" style={S(2)}>
        {setup?.title ?? "회의"} · {noAgenda ? "오늘 얘기한 것을 모았어요" : "안건마다 끝날 때 나와야 할 것을 봤어요"}
      </p>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8 lg:items-start">
        <div>
          {noAgenda && (
            <section className="fade-up mt-6" style={S(3)}>
              <h2 className="text-[12px] font-semibold tracking-[0.06em] mb-2 text-ink-3">오늘 얘기한 것 {talked}마디</h2>
              <div className="card divide-hair">
                <div className="px-4 py-3 text-[14px] text-ink-2">
                  사람이 {talked}마디 · 미티가 {answers.length}번 답함{state.cards.length > 0 ? ` · 바뀐 것 ${state.cards.length}개` : ""}
                </div>
                {answers.slice(-5).map((t, i) => (
                  <div key={i} className="flex items-start gap-2.5 px-4 py-3 text-[14.5px]">
                    <AgentMark size={18} />
                    <span className="min-w-0">{t}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {!noAgenda && items.length > 0 && (
            <div className="fade-up mt-6 grid grid-cols-3 gap-3" style={S(3)}>
              {GROUPS.map((g) => (
                <div key={g.status} className="card px-4 py-3">
                  <div className={`text-[12px] font-semibold ${g.tone}`}>{g.title}</div>
                  <div className="text-[28px] font-bold tabular-nums tracking-[-0.03em]">{count(g.status)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 space-y-5">
            {GROUPS.map((g, gi) => {
              const rows = noAgenda ? [] : items.filter((i) => i.status === g.status);
              if (!rows.length) return null;
              return (
                <section key={g.status} className="fade-up" style={S(4 + gi)}>
                  <h2 className={`text-[12px] font-semibold tracking-[0.06em] mb-2 ${g.tone}`}>{g.title}</h2>
                  <div className="card divide-hair">
                    {rows.map((it) => (
                      <div key={`${it.agenda}/${it.expected}`} className="flex items-start gap-3 px-4 py-3.5">
                        <span className="mt-0.5">
                          <StatusIcon status={it.status} size={20} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[15px]">
                            <span className="text-ink-3">{it.agenda} · </span>
                            <span className="font-semibold">{it.expected}</span>
                          </div>
                          {it.note && <div className="text-[13.5px] text-ink-2 mt-0.5">{it.note}</div>}
                          {it.evidence[0]?.quote && <div className="text-[12px] text-ink-3 mt-1">“{it.evidence[0].quote}”</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        <div className="lg:sticky lg:top-0">
          {leftover.length > 0 && (
            <section className="fade-up mt-6" style={S(8)}>
              <h2 className="text-[12px] font-semibold tracking-[0.06em] mb-2 text-amber-ink">미티가 손 들었는데 못 다룬 것</h2>
              <div className="space-y-2">
                {leftover.map((h) => (
                  <div key={h.actionId} className="flex items-start gap-3 rounded-2xl bg-orange/10 px-4 py-3.5">
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange text-white">
                      <Hand className="h-3.5 w-3.5" strokeWidth={2.2} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium">{h.preview}</div>
                      {h.evidence[0] && <div className="text-[12.5px] text-ink-3 mt-0.5">근거 · {h.evidence[0].label}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {state.cards.length > 0 && (
            <section className="fade-up mt-6" style={S(9)}>
              <h2 className="text-[12px] font-semibold tracking-[0.06em] mb-2 text-ink-3">오늘 바뀐 것 {state.cards.length}개</h2>
              <div className="card divide-hair">
                {state.cards.map((c) => (
                  <div key={c.cardId} className="px-4 py-3 text-[14px]">
                    <span className="text-ink-3">{c.title} · </span>
                    <span className="font-semibold">{c.to}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="fade-up mt-6 card-agent p-5 flex flex-wrap items-center gap-4" style={S(10)}>
            <span className="think text-agent flex gap-1">
              <span />
              <span />
              <span />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">회의록 정리 중</div>
              <div className="text-[13px] text-ink-2">받아 적은 말을 평소처럼 정리해서 회의 화면에 올려요</div>
            </div>
            <Link href={href} className="btn btn-md btn-dark">
              회의 화면으로 <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          {/* 같은 날 이어서 다음 회의 — 미티는 방금 정한 것을 기억하고 시작한다 */}
          <div className="mt-3 flex justify-end gap-2">
            {spaceId && (
              <Link href={`/s/${spaceId}`} className="btn btn-md btn-ghost">
                프로젝트 홈
              </Link>
            )}
            <Link href={spaceId ? `/live/new?space=${encodeURIComponent(spaceId)}` : "/live/new"} className="btn btn-md btn-secondary">
              다음 회의 시작
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

// 안건마다 나와야 할 것을 하나도 안 적었으면 체크리스트를 안 보인다. 설정을 모르는 기기(보기 전용)는 받은 체크리스트로 판단
export function isNoAgenda(setup: MeetingSetup | null, items: ChecklistItem[]): boolean {
  return setup ? !setup.agenda.some((a) => a.expected.length > 0) : items.length === 0;
}
