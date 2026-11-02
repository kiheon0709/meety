"use client";

import Link from "next/link";
import { Mic, Pause, Play, RotateCcw, Smartphone, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { Intensity, MeetingInfo, RoleKind } from "@/lib/live/contract";
import { AgentMark, LogoMark } from "@/components/Logo";
import { Avatar } from "@/components/ui";
import { scenarioOf } from "./mock";
import { AgendaProgress, ChangeCards, EvidenceCard, HandList, IntensityControl, MODE_LABEL, Orb, Transcript } from "./parts";
import { EndView, isNoAgenda } from "./EndView";
import type { ConnStatus, LiveState, MeetingSetup, MeetyMode, Speech } from "./state";
import { INTENSITY, agendaProgress, initState, isRaise, meetyMode, pendingHands, reduce, showSpeech } from "./state";
import { MockTransport, RealTransport, voiceUrl, type Transport } from "./transport";
import { httpOf } from "./client";
import { MeetyStage } from "@/components/meety/MeetyStage";
import { unlock } from "@/components/meety/levels";

export interface LiveProps {
  meetingId: string;
  mock?: "A" | "B";
  speed: number;
  present: boolean;
  barge: boolean;
  clean: boolean;
  debug: boolean;
  space?: { id: string; name: string };
  colors: Record<string, string>;
  classic?: boolean; // ?ui=classic: 미티 전용 화면 전의 회의 화면 (11/2 시연 직전까지 되돌릴 길)
}

export const setupKey = (id: string) => `meety:setup:${id}`;
const noop = () => () => {};
function readSetup(id: string): string | null {
  try {
    return localStorage.getItem(setupKey(id));
  } catch {
    return null;
  }
}

// 시험용: ?brain=두뇌 주소, ?feed=음성 서버의 시험 녹음 이름 (마이크 대신)
// ?me=지호: 멤버 기기 — 그 사람 몫 사설만 보인다 (회의실 큰 화면은 me 없이)
function testOpts(): { brain?: string; feed?: string; token?: string; me?: string } {
  const q = new URLSearchParams(location.search);
  return { brain: q.get("brain") ?? undefined, feed: q.get("feed") ?? undefined, token: q.get("token") ?? undefined, me: q.get("me") ?? undefined };
}
const meOf = () => (typeof location === "undefined" ? undefined : (new URLSearchParams(location.search).get("me") ?? undefined));

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function LiveMeeting(props: LiveProps) {
  const { meetingId, mock, speed, present, barge, clean, debug, space, colors, classic } = props;
  const sc = scenarioOf(mock);
  const [remote, setRemote] = useState<MeetingSetup | null>(null);
  const raw = useSyncExternalStore(noop, () => (sc ? null : readSetup(meetingId)), () => null);
  const setup: MeetingSetup | null = useMemo(() => {
    if (sc) return { ...sc.setup, spaceId: space?.id ?? "", spaceName: space?.name ?? sc.setup.spaceName };
    try {
      if (raw) return JSON.parse(raw) as MeetingSetup;
    } catch {
      /* 깨진 저장값 */
    }
    return remote;
  }, [sc, raw, space, remote]);

  const [state, dispatch] = useReducer(reduce, sc?.setup.intensity ?? "mid", initState);
  const tRef = useRef<Transport | null>(null);
  const [started, setStarted] = useState(!!sc);
  // 실제 모드 시작 단계: mic(마이크 켜기) → setup(화자 등록·녹음 동의) → 회의
  const [gate, setGate] = useState<"mic" | "setup" | null>(sc ? null : "mic");
  const [viewer, setViewer] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // 목업은 바로 재생. 실제는 [마이크 켜고 시작]을 눌러야 (소리 재생·마이크는 사용자 동작이 필요)
  useEffect(() => {
    if (!started) return;
    const t: Transport = sc ? new MockTransport(sc, dispatch, { speed, barge }) : new RealTransport(meetingId, setup, dispatch, viewer, testOpts());
    tRef.current = t;
    void t.start();
    return () => {
      t.stop();
      tRef.current = null;
    };
    // setup은 시작할 때 한 번만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, sc, meetingId, speed, barge, viewer]);

  // 이 브라우저에서 시작한 회의가 아니면(휴대폰 등) 두뇌에 회의 설정을 물어본다 (GET /api/live/{id} → MeetingInfo)
  useEffect(() => {
    if (sc || raw) return;
    let off = false;
    // 다른 기기는 링크의 ?token=(회의 열쇠)으로 연다. 이 브라우저에서 시작한 회의면 저장해 둔 열쇠로
    let saved: MeetingSetup | null = null;
    try {
      saved = JSON.parse(readSetup(meetingId) ?? "null");
    } catch {
      /* 깨진 저장값 */
    }
    if (saved) return;
    const token = new URLSearchParams(location.search).get("token");
    fetch(`/api/live/${encodeURIComponent(meetingId)}`, { headers: token ? { "x-live-token": token } : {} })
      .then((r) => (r.ok ? (r.json() as Promise<MeetingInfo>) : null))
      .then((m) => {
        if (off || !m) return;
        setRemote({ ...m, spaceName: space?.name, controlToken: token ?? undefined });
        dispatch({ src: "ui", type: "intensity", intensity: m.intensity, quiet: true });
        if (m.ended) dispatch({ src: "ui", type: "ended" });
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [sc, raw, meetingId, space?.name]);

  useEffect(() => {
    if (!started || state.phase !== "live" || paused) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000 / (sc ? speed : 1));
    return () => clearInterval(t);
  }, [started, state.phase, paused, sc, speed]);

  useEffect(() => {
    const id = state.toast?.id;
    if (!id) return;
    const t = setTimeout(() => dispatch({ src: "ui", type: "clear_toast", id }), 4200);
    return () => clearTimeout(t);
  }, [state.toast?.id]);

  const start = (asViewer = false) => {
    unlock(); // 미티 입 움직임용 소리 크기 재기 (사용자 동작 안에서 열어야 한다)
    // 실제 모드: 회의 시작 화면에서 고른 강도로 시작
    if (setup && !remote) dispatch({ src: "ui", type: "intensity", intensity: setup.intensity, quiet: true });
    setViewer(asViewer);
    setStarted(true);
    setGate(asViewer ? null : "setup");
  };
  const begin = (save: boolean) => {
    tRef.current?.begin?.({ save, announce: MEETY_HELLO });
    setGate(null);
  };

  const togglePause = useCallback(() => {
    const p = tRef.current?.togglePause?.();
    if (p !== undefined) setPaused(p);
  }, []);
  useEffect(() => {
    if (!sc) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === " " && (e.target as HTMLElement)?.tagName !== "INPUT") {
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [sc, togglePause]);

  const mode = meetyMode(state);
  const me = useSyncExternalStore(noop, meOf, () => undefined);
  const actions = {
    respond: (id: string, accept: boolean) => tRef.current?.respond(id, accept),
    pick: (i: Intensity) => (isRaise(state.intensity, i) ? dispatch({ src: "ui", type: "ask_confirm", intensity: i }) : tRef.current?.settings(i, false)),
    confirm: () => state.pendingConfirm && tRef.current?.settings(state.pendingConfirm, true),
    cancelConfirm: () => dispatch({ src: "ui", type: "ask_confirm", intensity: undefined }),
    interrupt: () => tRef.current?.interrupt(),
    end: () => void tRef.current?.end(),
    hush: () => {
      tRef.current?.interrupt();
      if (state.intensity !== "low") tRef.current?.settings("low", false);
    },
    privateTo: (id: string, to: "person" | "all" | "drop") => tRef.current?.privateTo?.(id, to),
    privateSeen: (id: string) => dispatch({ src: "ui", type: "private_done", actionId: id, to: "person" }), // 받은 사람이 읽음 (두뇌로 안 보냄)
    participation: (n: number) => tRef.current?.participation?.(n, state.intensity),
    roles: (r: Partial<Record<RoleKind, boolean>>) => tRef.current?.roles?.(r, state.intensity),
  };
  const flashKey = state.toast?.tone === "agent" ? state.toast.id : 0;
  const title = setup?.title ?? "회의";

  if (present)
    return (
      <div className="fixed inset-0 z-50 overflow-hidden bg-bg" data-lv-clean={clean ? "" : undefined}>
        <PresentView state={state} mode={mode} onRespond={actions.respond} />
        <ToastView state={state} />
        {sc && !clean && <MockBar mock={sc.key} speed={speed} paused={paused} onPause={togglePause} />}
        {gate && (
          <StartGate
            step={gate}
            title={title}
            participants={setup?.participants ?? []}
            colors={colors}
            state={state}
            onMic={() => start(false)}
            onViewer={() => start(true)}
            onEnroll={(n, replace) => tRef.current?.enroll?.(n, replace)}
            onBegin={begin}
          />
        )}
      </div>
    );

  return (
    <div className={`fixed inset-0 z-50 overflow-y-auto bg-bg lg:overflow-hidden ${classic ? "" : "meety-teal"}`} data-lv-clean={clean ? "" : undefined}>
      <TopBar
        title={title}
        spaceName={setup?.spaceName ?? space?.name}
        participants={setup?.participants ?? []}
        colors={colors}
        elapsed={elapsed}
        phase={state.phase}
        conn={sc ? null : state.conn}
        onShare={
          sc || !setup?.controlToken
            ? undefined
            : () => {
                const q = new URLSearchParams({ ...(setup.spaceId ? { space: setup.spaceId } : {}), token: setup.controlToken! });
                const url = `${location.origin}/live/${encodeURIComponent(meetingId)}?${q}`;
                navigator.clipboard?.writeText(url).catch(() => {});
                dispatch({ src: "ui", type: "toast", text: "다른 기기용 링크를 복사했어요. 휴대폰에선 localhost 대신 노트북 주소로 여세요" });
              }
        }
        latency={debug ? state.latency : null}
        onEnd={actions.end}
      />

      {state.phase === "ended" ? (
        <EndView state={state} setup={setup} spaceId={setup?.spaceId || space?.id} />
      ) : !classic ? (
        <MeetyStage state={state} actions={actions} colors={colors} mock={!!sc} flashKey={flashKey} startParticipation={setup?.participation} startRoles={setup?.roles} me={me} isHost={!viewer && !me} />
      ) : (
        <main className="mx-auto max-w-[1480px] px-4 pb-6 lg:p-5 lg:h-[calc(100dvh-56px)] lg:grid lg:grid-cols-[264px_minmax(0,1fr)_340px] lg:gap-5">
          {/* 가운데: 미티 */}
          <section className="lg:order-2 min-h-0 flex flex-col gap-4 min-h-[calc(100svh-64px)] lg:min-h-0">
            <Stage state={state} mode={mode} actions={actions} flashKey={flashKey} />
          </section>

          {/* 왼쪽: 안건 + 받아쓰기 */}
          <aside className="lg:order-1 min-h-0 flex flex-col gap-4 mt-4 lg:mt-0">
            <div className="card p-4">
              <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 mb-3">안건</h2>
              <AgendaProgress agenda={agendaProgress(setup?.agenda ?? [], state.checklist)} />
            </div>
            <div className="card p-4 flex-1 min-h-[220px] flex flex-col">
              <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 mb-2.5 flex items-center gap-1.5">
                받아쓰기
                {state.talking && <span className="h-1.5 w-1.5 rounded-full bg-red lv-rec" />}
              </h2>
              <Transcript lines={state.lines} colors={colors} className="flex-1 min-h-0 max-h-[40vh] lg:max-h-none" />
            </div>
          </aside>

          {/* 오른쪽: 방금 바뀐 것 */}
          <aside className="lg:order-3 min-h-0 flex flex-col mt-4 lg:mt-0">
            <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 mb-3 flex items-center justify-between">
              방금 바뀐 것<span className="font-medium normal-case tracking-normal">{state.cards.length > 0 && `${state.cards.length}개`}</span>
            </h2>
            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 pb-2">
              <ChangeCards cards={state.cards} />
            </div>
          </aside>
        </main>
      )}

      {state.phase === "ending" && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
          <div className="pop card px-7 py-6 flex items-center gap-4">
            <span className="think text-agent flex gap-1">
              <span />
              <span />
              <span />
            </span>
            <div>
              {isNoAgenda(setup, state.checklist) ? (
                <div className="text-[16px] font-semibold">미티가 오늘 얘기를 모으고 있어요</div>
              ) : (
                <>
                  <div className="text-[16px] font-semibold">미티가 안건별로 확인하고 있어요</div>
                  <div className="text-[13px] text-ink-3">정해진 것, 아직인 것, 담당이 없는 것</div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <ToastView state={state} inline />
      {sc && !clean && state.phase !== "ended" && <MockBar mock={sc.key} speed={speed} paused={paused} onPause={togglePause} />}
      {gate && (
          <StartGate
            step={gate}
            title={title}
            participants={setup?.participants ?? []}
            colors={colors}
            state={state}
            onMic={() => start(false)}
            onViewer={() => start(true)}
            onEnroll={(n, replace) => tRef.current?.enroll?.(n, replace)}
            onBegin={begin}
          />
        )}
    </div>
  );
}

// ── 위 막대 ──────────────────────────────────────────────────
function TopBar({
  title,
  spaceName,
  participants,
  colors,
  elapsed,
  phase,
  conn,
  latency,
  onEnd,
  onShare,
}: {
  onShare?: () => void;
  title: string;
  spaceName?: string;
  participants: string[];
  colors: Record<string, string>;
  elapsed: number;
  phase: LiveState["phase"];
  conn: LiveState["conn"] | null;
  latency: LiveState["latency"] | null;
  onEnd: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 glass hairline-b lg:static">
      <div className="mx-auto max-w-[1480px] h-14 px-4 lg:px-5 flex items-center gap-3">
        <Link href="/home" className="hidden sm:flex items-center gap-2 font-semibold shrink-0" aria-label="미티 홈">
          <LogoMark className="h-6 w-6" />
          <span className="text-[15px]">미티</span>
        </Link>
        <span className="hidden sm:block h-5 w-px bg-black/10" />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold leading-tight truncate">{title}</div>
          {spaceName && <div className="text-[11.5px] text-ink-3 truncate">{spaceName}</div>}
        </div>
        <span
          className={`ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold tabular-nums ${phase === "live" ? "bg-red/10 text-red" : "bg-black/6 text-ink-2"}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${phase === "live" ? "bg-red lv-rec" : "bg-ink-3"}`} />
          {phase === "live" ? "회의 중" : "끝"} {fmt(elapsed)}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {latency && Object.keys(latency).length > 0 && (
            <span className="hidden md:inline text-[11px] text-ink-3 tabular-nums">
              {Object.entries(latency)
                .map(([k, v]) => `${k} ${v}ms`)
                .join(" · ")}
            </span>
          )}
          {conn && <DbBadge />}
          {conn && <ConnChips conn={conn} />}
          {onShare && (
            <button type="button" onClick={onShare} className="hidden md:inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-ink-2 hover:bg-black/5" title="회의 열쇠가 든 링크 복사">
              <Smartphone className="h-3.5 w-3.5" /> 다른 기기
            </button>
          )}
          {participants.length > 0 && (
            <span className="hidden md:inline-flex items-center -space-x-1.5">
              {participants.map((p) => (
                <Avatar key={p} name={p} color={colors[p]} size={26} />
              ))}
              <span className="ring-2 ring-surface rounded-[30%]">
                <AgentMark size={26} />
              </span>
            </span>
          )}
          {phase === "live" && (
            <span className="hidden lg:block">
              <button type="button" onClick={onEnd} className="btn btn-md btn-dark">
                회의 끝
              </button>
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

// npm run meeting이 어느 DB로 켰는지 (MEETING_LIVE=1이면 원본, 아니면 복사본)
function DbBadge() {
  const mode = process.env.NEXT_PUBLIC_MEETING_DB;
  if (mode === "live")
    return (
      <span className="hidden md:inline-flex items-center rounded-full bg-orange/15 px-2.5 py-1 text-[11.5px] font-semibold text-amber-ink" title="회의 결과가 팀 기록(원본)에 바로 남아요. 켜기 전에 백업을 떠 뒀어요">
        원본 기록에 바로 남아요
      </span>
    );
  if (mode === "copy")
    return (
      <span className="hidden md:inline-flex items-center rounded-full bg-black/5 px-2.5 py-1 text-[11.5px] text-ink-3" title="팀 기록(원본)은 그대로고, 오늘 복사본에만 남아요">
        복사본에 기록 중
      </span>
    );
  return null;
}

const CONN_TONE: Record<ConnStatus, string> = { off: "bg-ink-3", connecting: "bg-orange lv-rec", on: "bg-green", error: "bg-red" };
function ConnChips({ conn }: { conn: LiveState["conn"] }) {
  const items: [keyof LiveState["conn"], string][] = [
    ["mic", "마이크"],
    ["voice", "받아쓰기"],
    ["brain", "미티"],
  ];
  return (
    <span className="hidden md:inline-flex items-center gap-2.5 text-[11.5px] text-ink-3">
      {items.map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1" title={conn[k]}>
          <span className={`h-1.5 w-1.5 rounded-full ${CONN_TONE[conn[k]]}`} />
          {label}
        </span>
      ))}
    </span>
  );
}

// ── 무대: 미티 ───────────────────────────────────────────────
type Actions = {
  respond: (id: string, accept: boolean) => void;
  pick: (i: Intensity) => void;
  confirm: () => void;
  cancelConfirm: () => void;
  interrupt: () => void;
  end: () => void;
};

function Stage({ state, mode, actions, flashKey }: { state: LiveState; mode: MeetyMode; actions: Actions; flashKey: number }) {
  const speech = showSpeech(state) ? state.speech : undefined;
  const hands = pendingHands(state);
  const label = MODE_LABEL[mode];
  return (
    <div className="card-agent relative flex-1 min-h-0 flex flex-col p-5 pb-0 lg:p-7 lg:overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <AgentMark size={24} />
          <span className="text-[15px] font-semibold">미티</span>
          <span className="text-[12px] text-ink-3">회의에 같이 있는 AI 팀원</span>
        </div>
        <div className="hidden lg:block">
          <IntensityControl
            value={state.intensity}
            pending={state.pendingConfirm}
            flashKey={flashKey}
            note={state.toast?.tone === "agent" ? state.toast.text : undefined}
            onPick={actions.pick}
            onConfirm={actions.confirm}
            onCancel={actions.cancelConfirm}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center py-6">
        {speech ? (
          <SpeechView speech={speech} mode={mode} talking={state.talking} />
        ) : (
          <div className="flex flex-col items-center text-center">
            <Orb mode={mode} talking={state.talking} size={176} />
            <div className="mt-14 text-[30px] lg:text-[34px] font-bold tracking-[-0.03em]">{label.title}</div>
            <div className="mt-1 text-[15px] text-ink-2">{mode === "listening" ? `${label.sub} · 지금 강도 ${INTENSITY[state.intensity].label}` : label.sub}</div>
            {state.queued && mode === "has_something" && (
              <div className="pop mt-4 inline-flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-[14px] shadow-[var(--shadow-card)]">
                <span className="h-2 w-2 rounded-full bg-agent" />
                {state.queued.preview}
              </div>
            )}
          </div>
        )}
      </div>

      <HandList hands={hands} onRespond={actions.respond} />

      {/* 휴대폰: 통화 화면처럼 강도 + 큰 버튼 */}
      <div className="lg:hidden sticky bottom-0 z-10 -mx-5 mt-5 px-5 pt-3 pb-4 glass rounded-b-[var(--radius-card)] flex items-center justify-between gap-3">
        <IntensityControl compact value={state.intensity} pending={state.pendingConfirm} flashKey={flashKey} onPick={actions.pick} onConfirm={actions.confirm} onCancel={actions.cancelConfirm} />
        {mode === "speaking" || mode === "has_something" ? (
          <CallButton onClick={actions.interrupt} label="말 끊기" icon={<VolumeX className="h-6 w-6" />} />
        ) : (
          <CallButton onClick={actions.end} label="회의 끝" icon={<span className="h-5 w-5 rounded-[4px] bg-white" />} />
        )}
      </div>
    </div>
  );
}

function CallButton({ onClick, label, icon }: { onClick: () => void; label: string; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-1 group shrink-0">
      <span className="h-14 w-14 rounded-full bg-red text-white flex items-center justify-center shadow-[0_12px_30px_-12px_var(--red)] transition group-active:scale-95">{icon}</span>
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
    </button>
  );
}

const KIND_HEAD: Record<Speech["kind"], string> = {
  conflict: "정해 둔 것과 달라요",
  open_item: "아직 안 정해진 게 있어요",
  owner_gap: "누가 맡을지 안 정해졌어요",
  structure: "정리해 볼 방법이 있어요",
  quiet_member: "아직 말 안 한 분이 있어요",
  research: "찾아본 게 있어요",
  feedback: "하나만 되물어요",
  suggest: "제안이 있어요",
  answer: "물어본 것에 답해요",
  ack: "알겠어요",
};

function SpeechView({ speech, mode, talking }: { speech: Speech; mode: MeetyMode; talking: boolean }) {
  const done = speech.status === "done";
  const cut = speech.status === "cut";
  const shown = speech.status === "preparing" ? [] : cut ? speech.sentences.slice(0, speech.index + 1) : done ? speech.sentences : speech.sentences.slice(0, speech.index + 1);
  const orbMode: MeetyMode = speech.status === "speaking" ? "speaking" : speech.status === "preparing" ? "has_something" : mode === "hand_raised" ? "hand_raised" : cut && talking ? "cut" : "listening";
  return (
    <div className={`w-full grid grid-cols-1 gap-6 items-center ${speech.evidence.length ? "lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]" : ""}`}>
      <div className="min-w-0 flex flex-col items-center text-center lg:items-start lg:text-left">
        <div className="flex flex-col items-center gap-4 lg:flex-row lg:gap-5">
          <Orb mode={orbMode} talking={talking} size={104} bars={false} />
          <div className="lg:mt-0 mt-1">
            <div className="flex items-center justify-center lg:justify-start gap-2">
              {cut ? (
                <span className="pop inline-flex items-center gap-1 rounded-full bg-red/10 px-2.5 py-1 text-[12px] font-semibold text-red">
                  <VolumeX className="h-3.5 w-3.5" /> 말 끊김
                </span>
              ) : done ? (
                <span className="rounded-full bg-black/6 px-2.5 py-1 text-[12px] font-semibold text-ink-2">방금 한 말</span>
              ) : (
                <span className="rounded-full bg-agent/12 px-2.5 py-1 text-[12px] font-semibold text-agent">{speech.status === "preparing" ? "할 말이 있어요" : "말하는 중"}</span>
              )}
              <span className="text-[13px] text-ink-3">{speech.status === "preparing" ? "말이 끊기면 말할게요" : KIND_HEAD[speech.kind]}</span>
            </div>
          </div>
        </div>
        <div className={`mt-6 space-y-2 transition-opacity duration-500 ${done || cut ? "opacity-60" : ""}`} aria-live="polite">
          {shown.map((s, i) => (
            <p
              key={i}
              className={`pop text-[22px] lg:text-[27px] font-semibold leading-[1.45] tracking-[-0.025em] ${i === speech.index && speech.status === "speaking" ? "text-ink" : "text-ink-2"}`}
            >
              <span className={i === speech.index && speech.status === "speaking" ? "lv-sub-cur" : ""}>{s}</span>
              {cut && i === shown.length - 1 && <span className="text-ink-3">…</span>}
            </p>
          ))}
        </div>
      </div>
      {speech.evidence.length > 0 && (
        <div className="space-y-2.5 text-left">
          <div className="text-[11.5px] font-semibold tracking-[0.06em] text-ink-3">근거 {speech.evidence.length}개</div>
          {speech.evidence.map((e, i) => (
            <EvidenceCard key={i} e={e} i={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 발표 모드: 슬라이드 옆 작은 창 ────────────────────────────
function PresentView({ state, mode, onRespond }: { state: LiveState; mode: MeetyMode; onRespond: (id: string, accept: boolean) => void }) {
  const speech = showSpeech(state) ? state.speech : undefined;
  const live = speech && (speech.status === "speaking" || speech.status === "preparing");
  const label = MODE_LABEL[mode];
  const hands = pendingHands(state);
  return (
    <div className="h-full flex flex-col gap-3 p-4">
      <div className="flex items-center gap-4">
        <Orb mode={mode} talking={state.talking} size={64} bars={false} />
        <div className="min-w-0">
          <div className="text-[20px] font-bold tracking-[-0.02em]">{label.title}</div>
          <div className="text-[12.5px] text-ink-3">
            미티 · 강도 {INTENSITY[state.intensity].label}
            {speech?.status === "cut" && <span className="ml-1.5 font-semibold text-red">말 끊김</span>}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {speech && speech.status !== "preparing" && (
          <p className={`text-[19px] font-semibold leading-[1.45] tracking-[-0.02em] ${live ? "" : "text-ink-2 opacity-70"}`}>
            {(speech.status === "done" ? speech.sentences : speech.sentences.slice(0, speech.index + 1)).join(" ")}
          </p>
        )}
        {speech?.evidence[0] && <p className="mt-2 text-[12px] text-ink-3">근거 · {speech.evidence[0].label}</p>}
      </div>
      <HandList hands={hands} onRespond={onRespond} compact />
    </div>
  );
}

// ── 알림 ─────────────────────────────────────────────────────
function ToastView({ state, inline }: { state: LiveState; inline?: boolean }) {
  const t = state.toast;
  if (!t) return null;
  // 강도 바뀜은 노트북 화면에선 강도 조절 바로 아래에 나온다
  const hideWide = inline && t.tone === "agent";
  return (
    <div
      key={t.id}
      role="status"
      className={`lv-toast fixed left-1/2 top-[68px] z-[70] ${hideWide ? "lg:hidden" : ""} flex items-center gap-2 rounded-full px-4 py-2.5 text-[14px] font-medium shadow-[0_12px_30px_-12px_rgba(0,0,0,.35)] ${t.tone === "warn" ? "bg-orange text-white" : "bg-ink text-surface"}`}
    >
      {t.tone === "agent" && <AgentMark size={20} />}
      {t.text}
    </div>
  );
}

// ── 목업 조작 막대 (영상 찍을 땐 &clean=1) ─────────────────────
function MockBar({ mock, speed, paused, onPause }: { mock: string; speed: number; paused: boolean; onPause: () => void }) {
  return (
    <div className="fixed bottom-3 left-3 z-[65] flex items-center gap-1 rounded-full bg-surface/90 px-2 py-1 text-[11.5px] text-ink-3 shadow-[var(--shadow-card)] opacity-60 hover:opacity-100 transition">
      <span className="px-1.5">
        목업 {mock}
        {speed !== 1 && ` · ${speed}배`}
      </span>
      <button type="button" onClick={onPause} className="h-6 w-6 rounded-full hover:bg-black/5 flex items-center justify-center" aria-label={paused ? "재생" : "일시정지"}>
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
      </button>
      <button type="button" onClick={() => location.reload()} className="h-6 w-6 rounded-full hover:bg-black/5 flex items-center justify-center" aria-label="처음부터">
        <RotateCcw className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── 실제 모드 시작 ───────────────────────────────────────────
// 미티가 회의 시작 때 하는 말 (녹음 안내)
export const MEETY_HELLO = "안녕하세요, 미티예요. 지금부터 회의 녹음과 기록을 시작할게요.";
const ENROLL_LINE = "안녕하세요, 저는 오늘 회의에 참석하는 팀원이에요. 미티야, 잘 부탁해.";
const ENROLL_SECONDS = 6;

function StartGate({
  step,
  title,
  participants,
  colors,
  state,
  onMic,
  onViewer,
  onEnroll,
  onBegin,
}: {
  step: "mic" | "setup";
  title: string;
  participants: string[];
  colors: Record<string, string>;
  state: LiveState;
  onMic: () => void;
  onViewer: () => void;
  onEnroll: (name: string | null, replace?: boolean) => void;
  onBegin: (save: boolean) => void;
}) {
  const [save, setSave] = useState(false);
  // 이미 등록된 목소리 (음성 서버 GET /speakers). 다시 등록은 확인을 받고 replace로
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    if (step !== "setup") return;
    fetch(`${httpOf(voiceUrl())}/speakers`)
      .then((r) => r.json())
      .then((j: { speakers?: string[] }) => setKnown(j.speakers ?? []))
      .catch(() => {});
  }, [step]);
  const [who, setWho] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const talkingRef = useRef(state.talking);
  useEffect(() => {
    talkingRef.current = state.talking;
  }, [state.talking]);

  // 등록: 이름을 보내고 6초 말하기 → 말이 멎은 뒤 끝 메시지 (음성 서버는 끝난 말만 모은다)
  const enroll = (name: string) => {
    const again = known.includes(name) || !!state.enrolled[name]?.ok;
    if (again && !window.confirm(`${name} 님 목소리는 이미 등록돼 있어요. 다시 등록할까요?`)) return;
    setWho(name);
    setLeft(ENROLL_SECONDS);
    onEnroll(name, again);
    let n = ENROLL_SECONDS;
    const t = setInterval(() => {
      n -= 1;
      setLeft(n);
      if (n > 0) return;
      clearInterval(t);
      const finish = () => {
        if (talkingRef.current) return setTimeout(finish, 200);
        setTimeout(() => {
          onEnroll(null);
          setWho(null);
        }, 700);
      };
      finish();
    }, 1000);
  };

  if (step === "mic")
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/80 backdrop-blur-sm p-5">
        <div className="pop card max-w-sm w-full p-7 text-center">
          <div className="flex justify-center">
            <Orb mode="listening" talking={false} size={88} />
          </div>
          <h2 className="mt-9 text-[20px] font-bold tracking-[-0.02em]">미티를 회의에 들일까요?</h2>
          <p className="mt-1.5 text-[13.5px] text-ink-2 leading-relaxed">{title} · 마이크를 켜면 미티가 듣기 시작해요. 다음 화면에서 목소리를 등록할 수 있어요.</p>
          <button type="button" onClick={onMic} className="btn btn-lg btn-agent mt-5 w-full">
            <Mic className="h-4 w-4" /> 마이크 켜기
          </button>
          <button type="button" onClick={onViewer} className="btn btn-md btn-ghost mt-2 w-full">
            이 기기는 화면으로만 볼게요
          </button>
        </div>
      </div>
    );

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/80 backdrop-blur-sm p-5">
      <div className="pop card max-w-md w-full p-6">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">목소리 등록</h2>
        <p className="mt-1 text-[13px] text-ink-2 leading-relaxed">한 사람씩 눌러서 {ENROLL_SECONDS}초 동안 말해 주세요. 등록한 목소리만 &ldquo;끼어들지 마&rdquo; 같은 설정을 바꿀 수 있어요. 건너뛰어도 돼요.</p>
        {who ? (
          <div className="mt-4 rounded-2xl bg-agent/10 px-4 py-4">
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-semibold text-agent">{who} 님, 읽어 주세요</span>
              <span className="text-[13px] font-semibold tabular-nums text-agent">{left > 0 ? `${left}초` : "마무리 중…"}</span>
            </div>
            <p className="mt-2 text-[16px] font-semibold leading-relaxed">{ENROLL_LINE}</p>
            <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
              <span className="lv-bars text-agent" data-on={state.talking ? "1" : "0"} style={{ transform: "scale(.6)" }}>
                <span />
                <span />
                <span />
                <span />
                <span />
              </span>
              {state.talking ? "듣고 있어요" : "말을 시작해 주세요"}
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {participants.length === 0 && <p className="text-[13px] text-ink-3">참석자가 없어요. 바로 시작해도 돼요.</p>}
            {participants.map((p) => {
              const r = state.enrolled[p] ?? (known.includes(p) ? { ok: true } : undefined);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => enroll(p)}
                  className={`inline-flex items-center gap-1.5 rounded-full pl-1 pr-3 py-1 text-[13.5px] transition ${r?.ok ? "bg-green/12 text-green-ink" : "bg-black/5 hover:bg-black/10"}`}
                  title={r && !r.ok ? r.message : undefined}
                >
                  <Avatar name={p} color={colors[p]} size={22} />
                  {p}
                  {r?.ok ? " ✓" : r ? " · 다시" : ""}
                </button>
              );
            })}
          </div>
        )}
        {Object.entries(state.enrolled).some(([, r]) => !r.ok) && !who && (
          <p className="mt-2 text-[12px] text-red">
            {Object.entries(state.enrolled)
              .filter(([, r]) => !r.ok)
              .map(([n, r]) => `${n}: ${r.message}`)
              .join(" · ")}
          </p>
        )}
        <label className="mt-5 flex items-start gap-2 text-[13px] text-ink-2 cursor-pointer select-none">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="mt-0.5 accent-[var(--agent-1)]" />
          <span>
            녹음 파일도 저장하는 데 모두 동의했어요
            <span className="block text-[12px] text-ink-3">체크하지 않으면 소리는 저장하지 않고 받아쓴 글만 남겨요.</span>
          </span>
        </label>
        <button type="button" disabled={!!who} onClick={() => onBegin(save)} className="btn btn-lg btn-agent mt-5 w-full">
          회의 시작
        </button>
        <p className="mt-2 text-center text-[12px] text-ink-3">시작하면 미티가 &ldquo;회의 녹음과 기록을 시작할게요&rdquo;라고 안내해요</p>
      </div>
    </div>
  );
}
