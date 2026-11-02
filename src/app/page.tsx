import Link from "next/link";
import { listSpaces } from "@/lib/service";
import { Reveal } from "@/components/Reveal";
import { ArrowRight } from "@/components/ui";
import { AgentMark } from "@/components/Logo";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 랜딩 (uiux-redesign.md §7): 첫 줄은 기능이 아니라 가치. 타깃은 결정이 자주 바뀌는 작은 개발·프로젝트 팀
const ROLES = [
  { img: "1-conflict", name: "지난 결정 확인", line: "“10월 1일에 X로 정했는데, 바꾸는 건가요?”" },
  { img: "2-owner-gap", name: "업무 분담 제안", line: "“이 일은 누가 맡나요?”" },
  { img: "3-research", name: "팀 자료 리서치", line: "“그게 얼마였지?” 하면 자료에서 찾아 보여 줘요" },
  { img: "4-feedback", name: "피드백", line: "반론 없이 빨리 정하면 “다른 안은 없었나요?”" },
  { img: "5-structure", name: "갈등 정리", line: "같은 두 안이 맴돌면 기준표로 나눠 봐요" },
  { img: "6-quiet-member", name: "조용한 팀원", line: "오래 말 없는 사람에게 따로 물어요" },
  { img: "7-suggest", name: "제안", line: "막혔을 때 아이디어를 꺼내요" },
];

export default function Landing() {
  const demo = listSpaces().find((s) => s.is_demo === 1) ?? listSpaces()[0];
  const demoHref = demo ? `/s/${demo.id}` : "/signup";

  return (
    <div>
      {/* ---------- Hero ---------- */}
      <section className="hero-glow overflow-x-clip">
        <div className="mx-auto max-w-6xl px-5 pt-14 pb-14 sm:pt-24 grid gap-10 lg:grid-cols-[1.05fr_1fr] items-center">
          <div>
            <p className="fade-up inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[13px] font-semibold text-agent shadow-[0_0_0_0.5px_var(--line)]" style={S(0)}>
              <AgentMark size={20} /> {BRAND.name} · {BRAND.tagline}
            </p>
            <h1 className="fade-up mt-4 text-[2.5rem] leading-[1.1] sm:text-[3.6rem] font-bold tracking-[-0.035em]" style={S(1)}>
              {BRAND.headline}
            </h1>
            <p className="fade-up mt-5 max-w-xl text-[17px] sm:text-[19px] text-ink-2 leading-relaxed" style={S(2)}>
              {BRAND.description} 결정이 자주 바뀌는 작은 개발·프로젝트 팀을 위해 만들었어요.
            </p>
            <div className="fade-up mt-7 flex flex-wrap gap-3" style={S(3)}>
              <Link href={demoHref} className="btn btn-lg btn-agent group">
                예시 프로젝트 보기 <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link href="/signup" className="btn btn-lg btn-secondary">
                우리 팀으로 시작하기
              </Link>
            </div>
          </div>
          <div className="fade-up" style={S(3)}>
            <PreviewCard />
          </div>
        </div>
      </section>

      {/* ---------- Why ---------- */}
      <section id="why" className="bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <Reveal className="max-w-2xl">
            <h2 className="text-[1.9rem] sm:text-[2.5rem] font-bold tracking-[-0.03em] leading-tight">서기도 PM도 없는 팀은, 정한 걸 자주 놓쳐요</h2>
            <p className="mt-4 text-[17px] text-ink-2 leading-relaxed">매주 회의하는데 지난번에 뭘 정했는지 흐려지고, 맡을 사람 없는 일이 생기고, 조용한 사람은 계속 조용해요.</p>
          </Reveal>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Pain title="바뀐 걸 놓침" body="스펙이 회의마다 조금씩 바뀌어요. 누가 언제 왜 바꿨는지는 아무도 몰라요." fix="바뀐 결정을 카드로" />
            <Pain title="기억 다툼" body="“그때 그렇게 정했잖아” — 서로 다르게 기억해요." fix="결정마다 그때 한 말" />
            <Pain title="담당 없는 일" body="정하긴 했는데 누가 하는지 안 정하고 끝나요." fix="회의 중에 “누가 맡나요?”" />
            <Pain title="조용한 사람" body="말 많은 사람 의견으로 끝나요. 다른 생각은 회의 뒤에 나와요." fix="따로 물어보기" />
          </div>
        </div>
      </section>

      {/* ---------- How: 회의 중 ---------- */}
      <section id="how">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <Reveal className="max-w-2xl">
            <p className="text-[13px] font-semibold text-agent">회의 중</p>
            <h2 className="mt-2 text-[1.9rem] sm:text-[2.5rem] font-bold tracking-[-0.03em] leading-tight">미티는 같이 듣다가, 필요할 때만 말해요</h2>
            <p className="mt-4 text-[17px] text-ink-2 leading-relaxed">얼마나 나설지는 참여도 0~10으로 팀이 정해요. 기본은 손 들기, 말할 땐 근거를 같이 보여 줘요.</p>
          </Reveal>
          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {ROLES.map((r) => (
              <Reveal key={r.img} className="card p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/meety/roles/${r.img}.png`} alt="" width={72} height={72} className="rounded-2xl bg-[var(--agent-soft)]" />
                <div className="mt-2 font-bold text-[15.5px]">{r.name}</div>
                <p className="mt-0.5 text-[13px] text-ink-2 leading-snug">{r.line}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- 회의 뒤 ---------- */}
      <section className="bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20 grid gap-10 lg:grid-cols-[1fr_1.1fr] items-center">
          <Reveal>
            <p className="text-[13px] font-semibold text-agent">회의 뒤</p>
            <h2 className="mt-2 text-[1.9rem] sm:text-[2.5rem] font-bold tracking-[-0.03em] leading-tight">무엇이 무엇으로 바뀌었는지 먼저 보여 줘요</h2>
            <p className="mt-4 text-[17px] text-ink-2 leading-relaxed">왼쪽엔 익숙한 회의록(안건별 요약·할 일·담당), 위엔 이번에 바뀐 결정 카드. 미티가 제안하고, 팀이 확인하면 확정돼요. 누가 확인했는지 남아요.</p>
          </Reveal>
          <Reveal className="card p-6 sm:p-7">
            <div className="text-[12px] font-semibold text-ink-3">녹음 방식 · 결정이 바뀌어 온 길</div>
            <ol className="mt-4 relative">
              <span className="absolute left-[9px] top-4 bottom-4 w-px bg-black/10" />
              <ChainItem date="9월 22일" title="앱에서 직접 녹음 + 음성 전사" why="녹음 버튼 없으면 제품 같지 않다" muted />
              <ChainItem date="10월 1일" title="클로바노트 녹취 붙여넣기만" why="2주 써 봤는데 한국어 전사 품질이 들쭉날쭉" muted />
              <ChainItem date="10월 10일" title="브라우저 녹음 + 붙여넣기" why="브라우저 내장 음성 인식이면 키 없이 바로 됨" current />
            </ol>
          </Reveal>
        </div>
      </section>

      {/* ---------- Steps + CTA ---------- */}
      <section>
        <div className="mx-auto max-w-6xl px-5 py-20">
          <ol className="grid gap-4 md:grid-cols-3">
            <Step n={1} title="회의 준비">안건과 끝날 때 나와야 할 것, 온 사람, 참여도를 정해요. 두 번째부터는 지난 회의 값으로 채워져요.</Step>
            <Step n={2} title="미티와 회의">노트북을 테이블 가운데 두고 평소처럼 얘기해요. “미티야” 하고 부르면 답해요.</Step>
            <Step n={3} title="정리 확인">바뀐 결정을 확인하면 확정. 다음 회의에서 미티가 오늘 정한 걸 기억해요.</Step>
          </ol>
          <Reveal className="mt-14 rounded-[28px] bg-agent text-white p-9 sm:p-12 text-center">
            <AgentMark size={56} className="mx-auto" />
            <div className="mt-3 text-[1.6rem] sm:text-[2.1rem] font-bold tracking-[-0.03em]">미티를 만든 5조의 회의를 보세요</div>
            <p className="mt-2 text-white/80 max-w-xl mx-auto">회의 세 번 동안 주제가 한 번, 녹음 방식이 두 번 바뀌었어요. 그 과정이 그대로 남아 있어요.</p>
            <Link href={demoHref} className="btn btn-lg mt-6 bg-white text-ink hover:bg-white/90 group">
              예시 프로젝트 보기 <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Reveal>
        </div>
      </section>
    </div>
  );
}

// 회의 뒤 정리 화면의 바뀐 결정 카드를 작게 (그림만, 데이터 없음)
function PreviewCard() {
  return (
    <div className="card p-5 sm:p-6 rotate-[0.6deg]">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink-3">회의 2 — 차별점과 방향 수정</span>
        <span className="rounded-full bg-agent text-white text-[11.5px] font-semibold px-2 py-0.5">바뀐 결정 3</span>
      </div>
      <div className="mt-4 text-[12.5px] font-semibold text-agent">• 주제</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_24px_1.3fr] items-center">
        <div className="rounded-2xl bg-black/[0.035] px-3.5 py-2.5">
          <div className="text-[10.5px] font-semibold text-ink-3">전에는</div>
          <div className="text-[13.5px] text-ink-3 line-through">AI 회의록 요약 서비스</div>
        </div>
        <div className="text-center text-agent font-bold">→</div>
        <div className="rounded-2xl bg-[var(--agent-soft)] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--agent-1)_25%,transparent)]">
          <div className="text-[10.5px] font-semibold text-agent">이번 회의에서</div>
          <div className="text-[16px] font-bold">회의 맥락 변화 추적</div>
        </div>
      </div>
      <div className="mt-3 text-[12.5px] text-ink-2 leading-relaxed">
        <b className="text-ink">기헌</b> “회의록 요약은 다른 서비스도 다 해요. 우리는 바뀐 걸 따라가요.”
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className="steps">
          <span data-on="done">제안</span>
          <i />
          <span data-on="now">확인</span>
          <i />
          <span>확정</span>
        </span>
        <span className="ml-auto btn btn-sm btn-agent pointer-events-none">확정하기</span>
      </div>
    </div>
  );
}

function Pain({ title, body, fix }: { title: string; body: string; fix: string }) {
  return (
    <Reveal className="card-flat lift p-6 flex flex-col">
      <h3 className="font-bold text-[18px] tracking-tight">{title}</h3>
      <p className="mt-2 text-[14.5px] text-ink-2 leading-relaxed flex-1">{body}</p>
      <p className="mt-4 text-[13px] font-semibold text-agent">→ {fix}</p>
    </Reveal>
  );
}

function ChainItem({ date, title, why, muted, current }: { date: string; title: string; why: string; muted?: boolean; current?: boolean }) {
  return (
    <li className="relative pl-8 py-3">
      <span className={`absolute left-[4px] top-[18px] h-[11px] w-[11px] rounded-full ring-4 ring-surface ${current ? "bg-agent" : "bg-black/20"}`} />
      <div className="text-[11px] text-ink-3">{date}</div>
      <div className={`font-semibold mt-0.5 ${muted ? "text-ink-3 line-through decoration-black/20" : ""}`}>{title}</div>
      <div className="text-[13.5px] text-ink-2 mt-0.5">이유 · {why}</div>
    </li>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Reveal as="li" className="card-flat p-7">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-agent text-white text-sm font-bold">{n}</span>
      <h3 className="mt-4 font-bold text-[18px] tracking-tight">{title}</h3>
      <p className="mt-1.5 text-[15px] text-ink-2 leading-relaxed">{children}</p>
    </Reveal>
  );
}
