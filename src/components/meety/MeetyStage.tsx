"use client";
// 미티 전용 회의 화면 (docs/architecture/live-screen-design.md §1). 가운데 미티 → 캔버스가 오면 미티가 왼쪽으로 물러나 "보여 준다",
// 말하기 전엔 "왜" 카드, 아래 자막, 오른쪽 받아쓰기·손 든 것·못 한 말·사설(호스트만), 호스트 서랍(강도·역할·예산).
// 상태 계산은 live/state.ts 리듀서 그대로, 여기는 보이는 층만.
import dynamic from "next/dynamic";
import { Lock, Settings2, VolumeX, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CanvasSpec, Intensity, RoleKind } from "@/lib/live/contract";
type Roles = Partial<Record<RoleKind, boolean>>;
import { Avatar } from "@/components/ui";
import { EvidenceCard, HandList, IntensityControl, KIND_LABEL, MODE_LABEL, Orb } from "@/components/live/parts";
import { meetyMode, pendingHands, privatesFor, showSpeech, webSearching, type Line, type LiveState, type MeetyMode, type ThinkKind } from "@/components/live/state";
import { ROLES, ROLE_LABEL, allRoles, participationOf } from "@/components/live/start-req";
import { pickCanvas } from "./pick";
import { pagesOf } from "./subtitle";

const Avatar3D = dynamic(() => import("./Avatar3D"), { ssr: false, loading: () => null });

export type StageActions = {
  respond: (id: string, accept: boolean) => void;
  pick: (i: Intensity) => void;
  confirm: () => void;
  cancelConfirm: () => void;
  interrupt: () => void;
  hush: () => void; // 🔇 강도 하 + 지금 말 끊기
  privateTo: (id: string, to: "person" | "all" | "drop") => void;
  privateSeen: (id: string) => void;
  participation: (n: number) => void;
  roles: (r: Roles) => void;
};

// ── 캐릭터: 3D가 안 되면(WebGL 없음·너무 느림) 2D Orb ───────────────────
const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  const m = window.matchMedia(reducedQuery);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
function useReducedMotion() {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(reducedQuery).matches, () => false);
}
// 한 번만 잰다: 렌더마다 새 WebGL 문맥을 만들면 브라우저 한도(16개 안팎)에 걸려 가장 오래된 문맥 — 미티 캔버스 — 를 잃는다
let webgl: boolean | undefined;
function canWebGL() {
  if (webgl !== undefined) return webgl;
  try {
    const c = document.createElement("canvas");
    const g = c.getContext("webgl2") || c.getContext("webgl");
    webgl = !!g;
    (g as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext(); // 잰 문맥은 바로 돌려준다
  } catch {
    webgl = false;
  }
  return webgl;
}
const noop = () => () => {};
// 사양이 낮은 기기는 처음부터 2D (코어 4개 이하 또는 메모리 4GB 이하 — deviceMemory는 크롬만 알려 준다)
function lowEnd() {
  const n = navigator as Navigator & { deviceMemory?: number };
  return (n.hardwareConcurrency ?? 8) <= 4 || (n.deviceMemory ?? 8) <= 4;
}

function Character({ state, mode, mock, small, searching }: { state: LiveState; mode: MeetyMode; mock?: boolean; small: boolean; searching: boolean }) {
  const reduced = useReducedMotion();
  const gl = useSyncExternalStore(noop, canWebGL, () => false);
  const [slow, setSlow] = useState(false);
  const [lost, setLost] = useState(false);
  const sp = state.speech;
  const sentence = sp && mode === "speaking" ? sp.sentences[sp.index] : undefined;
  const orb = (
    <div className="h-full w-full flex items-center justify-center">
      <Orb mode={mode} talking={state.talking} size={small ? 120 : 176} />
    </div>
  );
  if (!gl || slow || lowEnd()) return orb;
  return (
    <div className="relative h-full w-full">
      {/* 문맥을 잃은 동안에도 캔버스는 남겨 둬야 되찾을 수 있다 */}
      {lost && <div className="absolute inset-0 z-10">{orb}</div>}
      <Avatar3D
      mode={mode}
      talking={state.talking}
      thinking={!!state.draft}
      ideaKey={state.think?.n}
      searching={searching}
      nodKey={state.nods}
      sentence={sentence}
      sentenceKey={sp ? `${sp.actionId}:${sp.index}` : undefined}
      mock={mock}
      reduced={reduced}
      onSlow={(fps) => fps < 24 && setSlow(true)}
      onLost={setLost}
    />
    </div>
  );
}

// ── 왜 카드: 말하기 전에 "왜 지금" + 근거 한 줄 ─────────────────────────
function WhyCard({ state, mode }: { state: LiveState; mode: MeetyMode }) {
  const q = state.queued;
  const sp = state.speech && (state.speech.status === "preparing" || state.speech.status === "speaking") ? state.speech : undefined;
  const kind = q?.kind ?? sp?.kind;
  if (!kind || kind === "ack" || (mode !== "has_something" && mode !== "speaking")) return null;
  const why = q?.why ?? q?.preview ?? sp?.why ?? (sp?.status === "preparing" ? sp.sentences[0] : undefined);
  const ev = q?.evidence?.[0] ?? sp?.evidence[0];
  return (
    <div className="pop card-agent px-4 py-3 max-w-[560px] w-full" role="status">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-agent">
        <span className="h-2 w-2 rounded-full bg-agent" />
        {mode === "has_something" ? "말하려는 이유" : "말하는 이유"} · {KIND_LABEL[kind]}
      </div>
      {why && <div className="mt-1 text-[15px] font-semibold leading-snug">{why}</div>}
      {ev && <div className="mt-1 text-[12.5px] text-ink-2 leading-snug">근거 · {ev.label}</div>}
    </div>
  );
}

// ── 생각 메모: 미티가 떠올린 것(think)을 말하기 전에 구석에 한 줄. 소리 없음. 말하면 왜 카드로 이어진다 ─────
const THINK_MS = 20000;
const RESEARCH_MS = 45000; // 찾아보는 중은 결과 카드가 올 때까지 (오래 안 오면 내린다)
const THINK_LABEL: Record<ThinkKind, string> = { idea: "생각 중", gap: "생각 중", todo: "생각 중", question: "궁금한 것", research: "찾아보는 중" };
function ThinkMemo({ think, below, label }: { think: Pick<NonNullable<LiveState["think"]>, "kind" | "text">; below?: boolean; label?: string }) {
  return (
    <div className={`pop absolute left-3 ${below ? "top-12" : "top-3"} z-10 max-w-[min(440px,80%)] rounded-2xl bg-surface/85 backdrop-blur px-3.5 py-2.5 text-[16px] leading-snug shadow-sm`} role="status">
      <span className={`mr-2 inline-block h-2 w-2 rounded-full bg-agent align-middle ${think.kind === "research" ? "animate-pulse" : ""}`} />
      <span className="font-semibold text-agent">{label ?? THINK_LABEL[think.kind]}</span>
      <span className="text-ink-2"> · {think.text}</span>
    </div>
  );
}

// ── 자막: 문장 단위, 한 줄 16자·2줄, 넘치면 장을 넘김 ────────────────────
const CHAR_S = 0.115;
const SUBTITLE_LINGER_MS = 2000;
const SILENT_LINGER_MS = 6000; // 소리 없이 글자로만 보여 준 말은 읽을 시간을 더 준다
function Subtitle({ state }: { state: LiveState }) {
  const sp = showSpeech(state) ? state.speech : undefined;
  if (!sp || sp.status === "preparing") return null;
  // 문장(또는 상태)이 바뀌면 새로 마운트돼 시계가 0부터
  return <SubtitleBody key={`${sp.actionId}:${sp.index}:${sp.status}`} sp={sp} />;
}
function SubtitleBody({ sp }: { sp: NonNullable<LiveState["speech"]> }) {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => {
    if (sp.status !== "speaking") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [sp.status]);
  // 다 말했거나 끊긴 자막은 2초 뒤 지운다 (다음 사람 말이 올 때까지 남아 있으면 '듣고 있어요'와 겹쳐 보인다)
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (sp.status === "speaking") return;
    const id = setTimeout(() => setGone(true), sp.silent ? SILENT_LINGER_MS : SUBTITLE_LINGER_MS);
    return () => clearTimeout(id);
  }, [sp.status, sp.silent]);
  const cur = sp.sentences[sp.index] ?? "";
  const pages = pagesOf(cur);
  // 문장 소리 길이를 글자 비율로 나눠 장을 넘긴다 (소리 길이를 모르니 글자당 0.115초로 어림)
  const ends = pages.map((_, i) => pages.slice(0, i + 1).reduce((a, p) => a + p.join("").length * CHAR_S, 0));
  const el = (now - t0) / 1000;
  const hit = ends.findIndex((e) => e > el);
  const page = sp.status === "speaking" && hit >= 0 ? hit : pages.length - 1;
  const prev = sp.index > 0 ? sp.sentences[sp.index - 1] : undefined;
  const cut = sp.status === "cut";
  return (
    <div className={`mx-auto max-w-[720px] text-center select-none transition-opacity duration-500 ${gone ? "opacity-0" : ""}`} aria-live="polite">
      {sp.silent && <div className="text-[13px] text-ink-3">말씀 중이라 글로만 보여 드려요</div>}
      {prev && <div className="text-[15px] text-ink-3 opacity-60 truncate">{prev}</div>}
      <div className={`mt-1 text-[24px] lg:text-[28px] font-semibold leading-[1.35] tracking-[-0.02em] ${cut ? "text-ink-3" : ""}`}>
        {(pages[page] ?? [cur]).map((l, i) => (
          <div key={i}>
            {l}
            {cut && i === (pages[page]?.length ?? 1) - 1 ? " —" : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 캔버스: 두뇌 show가 있으면 그것, 없으면 근거·바뀐 것으로 스스로 ────────
function CanvasView({ spec, onClose }: { spec: CanvasSpec; onClose: () => void }) {
  return (
    <div className="pop card relative p-5 w-full max-h-full overflow-y-auto">
      <button type="button" onClick={onClose} className="absolute right-3 top-3 h-7 w-7 rounded-full text-ink-3 hover:bg-black/5 flex items-center justify-center" aria-label="캔버스 닫기">
        <X className="h-4 w-4" />
      </button>
      {spec.kind === "evidence" && (
        <div className="space-y-2.5 pr-6">
          <div className="text-[12px] font-semibold tracking-[0.06em] text-ink-3">근거</div>
          {spec.items.map((e, i) => (
            <EvidenceCard key={i} e={e} i={i} />
          ))}
        </div>
      )}
      {spec.kind === "compare" && (
        <div className="pr-6">
          <div className="text-[16px] font-bold">{spec.title}</div>
          <table className="mt-3 w-full text-[14px] border-separate border-spacing-y-1.5">
            <thead>
              <tr className="text-[12px] text-ink-3 text-left">
                <th className="font-medium" />
                <th className="font-medium px-3">{spec.aLabel}</th>
                <th className="font-medium px-3">{spec.bLabel}</th>
              </tr>
            </thead>
            <tbody>
              {spec.rows.map((r, i) => {
                const diff = String(r.a) !== String(r.b);
                return (
                  <tr key={i}>
                    <td className="text-ink-2 pr-3 align-top">{r.label}</td>
                    <td className="px-3 py-2 rounded-l-xl bg-black/[0.04]">{r.a}</td>
                    <td className={`px-3 py-2 rounded-r-xl ${diff ? "bg-agent/10 font-semibold" : "bg-black/[0.04]"}`}>
                      {diff && <span className="text-agent mr-1">≠</span>}
                      {r.b}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {spec.kind === "timeline" && (
        <div className="pr-6">
          <div className="text-[16px] font-bold">{spec.title}</div>
          <ol className="mt-5 flex items-start">
            {spec.points.map((p, i) => (
              <li key={i} className="flex-1 min-w-0 relative">
                {i > 0 && <span className="absolute left-0 right-1/2 top-[7px] h-[2px] bg-agent/25" />}
                {i < spec.points.length - 1 && <span className="absolute left-1/2 right-0 top-[7px] h-[2px] bg-agent/25" />}
                <span className={`relative mx-auto block h-4 w-4 rounded-full ${p.current ? "bg-agent ring-4 ring-agent/20" : "bg-surface shadow-[0_0_0_2px_var(--agent-1)]"}`} />
                <div className={`mt-2 text-center text-[13px] font-semibold ${p.current ? "text-agent" : ""}`}>{p.date}</div>
                <div className="mt-0.5 text-center text-[12.5px] text-ink-2 leading-snug px-1">{p.label}</div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {spec.kind === "text" && (
        <div className="pr-6">
          <div className="text-[16px] font-bold">{spec.title}</div>
          <ul className="mt-2 space-y-1 text-[14px] text-ink-2">
            {spec.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const SHOW_TTL_MS = 30_000; // 두뇌가 ttlMs를 안 주면 혼자 온 show를 이만큼 띄운다
const CARD_MS = 8000; // 새 "바뀐 것" 카드를 캔버스에 띄우는 시간

// id가 바뀌면 ms 동안만 살아 있는 값 (그 뒤 null)
function useFresh(id: string | undefined, ms: number) {
  const [stale, setStale] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => setStale(id), ms);
    return () => clearTimeout(t);
  }, [id, ms]);
  return id && stale !== id ? id : null;
}

function useActiveCanvas(state: LiveState, pinned: string | null, closed: string | null) {
  const liveShow = useFresh(state.canvas?.actionId, state.canvas?.ttlMs ?? SHOW_TTL_MS);
  const cardFresh = useFresh(state.cards.at(-1)?.cardId, CARD_MS);
  return pickCanvas(state, { pinned, closed, liveShow, cardFresh });
}

// ── 오른쪽: 받아쓰기 (같은 사람이 이어 말하면 이름 반복 안 함) ───────────────
function Rail({ lines, colors }: { lines: Line[]; colors: Record<string, string> }) {
  return (
    <div className="space-y-1.5">
      {lines.length === 0 && <p className="text-[12.5px] text-ink-3">말이 들리면 여기에 적혀요</p>}
      {lines.map((l, i) => {
        const prev = lines[i - 1];
        const same = !!l.speaker && prev?.speaker === l.speaker && prev.final;
        return (
          <div key={l.id} className={`flex gap-2 text-[13px] leading-relaxed ${l.echo || (!l.final && !l.stable) ? "opacity-55" : ""}`} title={l.echo ? "미티가 말하던 중에 들어온 말이에요" : undefined}>
            {same ? <span className="w-[18px] shrink-0" /> : l.speaker ? <Avatar name={l.speaker} color={colors[l.speaker]} size={18} /> : <span className="h-[18px] w-[18px] shrink-0 rounded-full bg-black/6" />}
            <p className="min-w-0">
              {l.speaker && !same && <span className="font-semibold mr-1">{l.speaker}</span>}
              {/* 받아쓰는 중: 안정된 앞부분은 진하게, 아직 바뀔 수 있는 뒷부분은 흐리게 */}
              {!l.final && l.stable ? (
                <>
                  <span className="text-ink-2">{l.text.slice(0, l.stable)}</span>
                  <span className="text-ink-3 opacity-60">{l.text.slice(l.stable)}</span>
                </>
              ) : (
                <span className="text-ink-2">{l.text}</span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ── 호스트 서랍 ─────────────────────────────────────────────────
function HostPanel({ state, actions, flashKey, dial, roles, onClose }: { state: LiveState; actions: StageActions; flashKey: number; dial: number; roles: Roles; onClose: () => void }) {
  const [v, setV] = useState(dial); // 끄는 동안은 화면에만, 놓을 때 두뇌로
  return (
    <div className="pop card absolute right-3 top-14 z-30 w-[320px] max-w-[calc(100%-24px)] p-4 space-y-4 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-semibold">호스트 설정</div>
        <button type="button" onClick={onClose} className="h-7 w-7 rounded-full text-ink-3 hover:bg-black/5 flex items-center justify-center" aria-label="닫기">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="meety-dial" className="text-[13px] font-semibold">
            참여도
          </label>
          <span className="text-[20px] font-bold text-agent tabular-nums">{v}</span>
        </div>
        <input
          id="meety-dial"
          type="range"
          min={0}
          max={10}
          step={1}
          value={v}
          onChange={(e) => setV(Number(e.target.value))}
          onPointerUp={() => v !== dial && actions.participation(v)}
          onKeyUp={() => v !== dial && actions.participation(v)}
          aria-valuetext={`참여도 ${v}`}
          className="mt-1 w-full accent-[var(--agent-1)]"
        />
        <div className="flex justify-between text-[11.5px] text-ink-3">
          <span>조용히</span>
          <span>적극적으로</span>
        </div>
      </div>
      <details className="group">
        <summary className="cursor-pointer select-none text-[12px] font-semibold text-ink-3">세부 — 역할·강도</summary>
        <div className="mt-3 space-y-4">
      <div>
        <div className="text-[12px] font-semibold text-ink-3 mb-2">끼어들기 강도</div>
        <IntensityControl value={state.intensity} pending={state.pendingConfirm} flashKey={flashKey} onPick={actions.pick} onConfirm={actions.confirm} onCancel={actions.cancelConfirm} />
      </div>
      <div>
        <div className="text-[12px] font-semibold text-ink-3 mb-2">미티가 맡을 역할</div>
        <div className="grid grid-cols-2 gap-1.5">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] bg-black/[0.035] cursor-pointer">
              <input type="checkbox" checked={roles[r] ?? true} onChange={(e) => actions.roles({ ...allRoles(), ...roles, [r]: e.target.checked })} className="accent-[var(--agent-1)]" />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
      </div>
      {/* 자발 음성 상한은 기본 없음. 팀이 켜서 두뇌가 budget을 보낼 때만 */}
      {state.budget && (
        <div className="text-[12.5px] text-ink-2">
          먼저 말하기 상한 {state.budget.used}/{state.budget.limit} ({state.budget.windowMin}분)
        </div>
      )}
        </div>
      </details>
    </div>
  );
}

export function MeetyStage({
  state,
  actions,
  colors,
  mock,
  flashKey,
  startParticipation,
  startRoles,
  me,
  isHost = true,
}: {
  state: LiveState;
  actions: StageActions;
  colors: Record<string, string>;
  mock?: boolean;
  flashKey: number;
  startParticipation?: number;
  startRoles?: Roles;
  me?: string; // 멤버 기기 (?me=)
  isHost?: boolean; // 회의를 연 기기(회의실 큰 화면)
}) {
  const mode = meetyMode(state);
  // 참여도: 두뇌·슬라이더가 정한 값 > 회의를 만들 때 고른 값 > 강도로 어림
  const dial = state.participation ?? participationOf({ intensity: state.intensity, participation: startParticipation });
  const [pinned, setPinned] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [host, setHost] = useState(false);
  const canvas = useActiveCanvas(state, pinned, closed);
  // 생각 메모는 떠올린 지 잠깐만 (찾아보는 중은 더 길게). 말하거나 손들면 리듀서가 지운다
  const thinkFresh = useFresh(state.think ? String(state.think.n) : undefined, state.think?.kind === "research" ? RESEARCH_MS : THINK_MS);
  const think = thinkFresh && mode === "listening" ? state.think : undefined;
  // 두뇌가 스스로 웹에서 찾기 시작하면 몸짓만이 아니라 메모로도 보여 준다
  const web = webSearching(state);
  const webMemo = !think && web && mode === "listening" ? { kind: "research" as const, text: web } : undefined;
  const hands = pendingHands(state);
  // 호스트 화면엔 "host" 몫(공개로 올릴지 승인)만, 멤버 화면엔 그 사람 몫만 — 남의 사설은 받았어도 안 보인다
  const hostPrivates = privatesFor(state, { host: isHost });
  const minePrivates = me ? privatesFor(state, { me, host: false }) : [];
  const lastCut = [...state.said].reverse().find((s) => s.status === "cut" && s.rest?.length);
  const label = MODE_LABEL[mode];
  const sub = state.quiet ? state.quiet.message : mode === "listening" ? `${label.sub} · 참여도 ${dial}` : label.sub;

  return (
    <main className="mx-auto max-w-[1600px] px-4 pb-6 lg:p-5 lg:h-[calc(100dvh-56px)] lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
      <section className="card-agent relative min-h-[calc(100svh-80px)] lg:min-h-0 flex flex-col overflow-hidden">
        {/* 조용히·호스트 설정은 회의를 연 기기(호스트)에만 — 멤버·다른 기기에선 설정을 못 바꾼다 */}
        {isHost && (
        <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
          <button type="button" onClick={actions.hush} className="btn btn-sm btn-secondary" title="강도를 하로 낮추고 지금 말을 끊어요">
            <VolumeX className="h-4 w-4" /> 조용히
          </button>
          <button type="button" onClick={() => setHost((h) => !h)} className="btn btn-sm btn-ghost" aria-expanded={host} aria-label="호스트 설정">
            <Settings2 className="h-4 w-4" />
          </button>
        </div>
        )}
        {me && (
          <div className="absolute left-3 top-3 z-20 rounded-full bg-surface/85 px-3 py-1 text-[12.5px] font-medium text-ink-2 shadow-sm">
            {me} 님 화면
          </div>
        )}
        {minePrivates.length > 0 && (
          <div className="absolute inset-x-3 top-14 z-20 flex justify-center">
            <div className="pop card max-w-[520px] w-full p-4 shadow-xl" role="status">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-agent">
                <Lock className="h-3.5 w-3.5" /> {me} 님에게만 보여요
              </div>
              <p className="mt-1.5 text-[16px] font-semibold leading-snug">{minePrivates[0].text}</p>
              <div className="mt-3 flex justify-end">
                <button type="button" className="btn btn-sm btn-agent" onClick={() => actions.privateSeen(minePrivates[0].actionId)}>
                  알겠어요
                </button>
              </div>
            </div>
          </div>
        )}
        {host && isHost && <HostPanel key={dial} state={state} actions={actions} flashKey={flashKey} dial={dial} roles={state.roles ?? startRoles ?? allRoles()} onClose={() => setHost(false)} />}

        <div className={`flex-1 min-h-0 grid transition-[grid-template-columns] duration-[400ms] ${canvas ? "grid-cols-1 lg:grid-cols-[34%_minmax(0,1fr)]" : "grid-cols-1"}`}>
          <div className={`relative flex flex-col items-center justify-center min-h-0 ${canvas ? "pt-12 lg:pt-0" : ""}`}>
            {think && <ThinkMemo key={think.n} think={think} below={!!me} />}
            {webMemo && <ThinkMemo key={`web-${state.draft?.uttId}`} think={webMemo} label="웹에서 찾는 중" below={!!me} />}
            <div className={`w-full ${canvas ? "h-[220px] lg:h-[46%]" : "h-[300px] lg:h-[58%]"}`}>
              <Character state={state} mode={mode} mock={mock} small={!!canvas} searching={think?.kind === "research" || !!webMemo} />
            </div>
            <div className="mt-2 text-center px-4" aria-live="polite">
              <div className={`${canvas ? "text-[20px]" : "text-[28px] lg:text-[32px]"} font-bold tracking-[-0.03em]`}>{state.quiet ? "조용히 있을게요" : label.title}</div>
              <div className="mt-0.5 text-[14px] text-ink-2">{sub}</div>
            </div>
            {!canvas && (
              <div className="mt-4 w-full flex justify-center px-4">
                <WhyCard state={state} mode={mode} />
              </div>
            )}
          </div>
          {canvas && (
            <div className="min-h-0 flex flex-col gap-3 p-4 lg:p-6 lg:pl-0 justify-center">
              <WhyCard state={state} mode={mode} />
              <div className="min-h-0 flex">
                <CanvasView
                  spec={canvas.spec}
                  onClose={() => {
                    setPinned(null);
                    setClosed(canvas.actionId);
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-4 pb-5 pt-2 min-h-[96px]">
          <Subtitle state={state} />
        </div>
      </section>

      <aside className="min-h-0 flex flex-col gap-4 mt-4 lg:mt-0">
        {hostPrivates.length > 0 && (
          <div className="card p-4 space-y-3">
            <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" /> 호스트에게만
            </h2>
            {hostPrivates.map((p) => (
              <div key={p.actionId} className="space-y-2">
                <div className="text-[13.5px] leading-snug">
                  <span className="font-semibold">{p.to}</span> · {p.text}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className="btn btn-sm btn-agent" onClick={() => actions.privateTo(p.actionId, "person")}>
                    그 사람에게만
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => actions.privateTo(p.actionId, "all")}>
                    전체에 말하기
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => actions.privateTo(p.actionId, "drop")}>
                    버리기
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {hands.length > 0 && <HandList hands={hands} onRespond={actions.respond} compact />}
        {lastCut && (
          <div className="card p-4">
            <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 mb-1.5">끊겨서 못 한 말</h2>
            <p className="text-[13px] text-ink-2 leading-relaxed">{lastCut.rest!.join(" ")}</p>
          </div>
        )}
        <div className="card p-4 flex-1 min-h-[240px] flex flex-col">
          <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 mb-2.5 flex items-center gap-1.5">
            받아쓰기
            {state.talking && <span className="h-1.5 w-1.5 rounded-full bg-red lv-rec" />}
          </h2>
          <div className="flex-1 min-h-0 overflow-y-auto max-h-[40vh] lg:max-h-none">
            <Rail lines={state.lines} colors={colors} />
          </div>
        </div>
        {state.shown.length > 0 && (
          <div className="card p-3">
            <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 mb-2">미티가 보여 준 것</h2>
            <div className="flex flex-wrap gap-1.5">
              {state.shown.map((c) => (
                <button
                  key={c.actionId}
                  type="button"
                  onClick={() => {
                    setClosed(null);
                    setPinned(pinned === c.actionId ? null : c.actionId);
                  }}
                  className={`rounded-full px-3 py-1 text-[12.5px] ${pinned === c.actionId ? "bg-agent/15 text-agent" : "bg-black/5 text-ink-2"}`}
                >
                  {"title" in c.spec ? c.spec.title : "근거"}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </main>
  );
}
