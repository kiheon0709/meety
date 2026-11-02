"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import { saveRecordingAction } from "@/lib/actions";
import { Avatar } from "./ui";
import { Spinner } from "./SubmitButton";

type Line = { speaker: string; text: string; t: number };
type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };

function getSR(): (new () => SR) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// 브라우저 내장 음성 인식으로 실시간 받아 적기. 말하는 사람은 칩을 눌러 바꾼다.
export function Recorder({ spaceId, members, defaultTitle }: { spaceId: string; members: { name: string; color: string }[]; defaultTitle: string }) {
  const [speakers, setSpeakers] = useState(members.map((m) => m.name));
  const [current, setCurrent] = useState(members[0]?.name ?? "회의");
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const supported = useSyncExternalStore(
    () => () => {},
    () => !!getSR(),
    () => true,
  );
  const [err, setErr] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);
  const currentRef = useRef(current);
  const wantRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    if (!recording) return;
    const t0 = Date.now() - elapsed * 1000;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, interim]);

  const start = useCallback(() => {
    const Ctor = getSR();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "ko-KR";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) setLines((ls) => [...ls, { speaker: currentRef.current, text, t: Date.now() }]);
        else interimText += text;
      }
      setInterim(interimText);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed") {
        setErr("마이크 권한이 필요해요. 브라우저 주소창에서 마이크를 허용해 주세요.");
        wantRef.current = false;
        setRecording(false);
      }
    };
    // 크롬은 잠깐 조용하면 끊긴다 → 원하는 동안 다시 시작
    r.onend = () => {
      setInterim("");
      if (wantRef.current) {
        try {
          r.start();
        } catch {
          /* 이미 시작됨 */
        }
      }
    };
    recRef.current = r;
    wantRef.current = true;
    setErr(null);
    r.start();
    setRecording(true);
  }, []);

  const stop = useCallback(() => {
    wantRef.current = false;
    recRef.current?.stop();
    setRecording(false);
    setInterim("");
  }, []);

  const addSpeaker = () => {
    const name = prompt("이름");
    if (!name) return;
    const n = name.trim();
    if (!n) return;
    setSpeakers((s) => (s.includes(n) ? s : [...s, n]));
    setCurrent(n);
  };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const colorOf = (name: string) => members.find((m) => m.name === name)?.color ?? "stone";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4 min-w-0">
        {/* 상단: 녹음 버튼 + 시간 */}
        <div className="card p-6 flex items-center gap-5">
          <button
            type="button"
            onClick={recording ? stop : start}
            disabled={!supported}
            className={`relative h-16 w-16 rounded-full flex items-center justify-center transition ${recording ? "bg-red text-white" : "bg-ink text-white hover:bg-ink/85"} disabled:opacity-40`}
            aria-label={recording ? "녹음 멈추기" : "녹음 시작"}
          >
            {recording ? <span className="h-5 w-5 rounded-[4px] bg-white" /> : <span className="h-6 w-6 rounded-full bg-red" />}
            {recording && <span className="absolute inset-0 rounded-full ring-4 ring-red/30 animate-ping" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[22px] font-bold tracking-[-0.02em] tabular-nums">{fmt(elapsed)}</div>
            <div className="text-[13px] text-ink-2">
              {!supported
                ? "이 브라우저는 음성 인식을 지원하지 않아요. 크롬·엣지·사파리에서 열거나, 녹취를 붙여넣어 주세요."
                : err ?? (recording ? "듣고 있어요. 말하는 사람이 바뀌면 오른쪽에서 눌러주세요." : lines.length ? "멈춤. 다시 시작하거나 아래에서 정리하기." : "버튼을 누르면 바로 받아 적기 시작해요.")}
            </div>
          </div>
          <div className="hidden sm:block text-[12px] text-ink-3 text-right">
            {lines.length}마디
            <br />
            {speakers.length}명
          </div>
        </div>

        {/* 실시간 전사 */}
        <div ref={listRef} className="card p-5 h-[46vh] overflow-y-auto space-y-3">
          {lines.length === 0 && !interim && <p className="text-[13.5px] text-ink-3">여기에 말이 실시간으로 적혀요. 틀린 글자는 나중에 고치지 않아도 돼요 — 정리는 뜻을 보고 해요.</p>}
          {lines.map((l, i) => (
            <div key={i} className="flex gap-3 text-[15px] leading-relaxed">
              <Avatar name={l.speaker} color={colorOf(l.speaker)} size={24} />
              <div className="min-w-0">
                <span className="font-semibold mr-1.5">{l.speaker}</span>
                <span className="text-ink-2">{l.text}</span>
              </div>
            </div>
          ))}
          {interim && (
            <div className="flex gap-3 text-[15px] leading-relaxed opacity-60">
              <Avatar name={current} color={colorOf(current)} size={24} />
              <div>
                <span className="font-semibold mr-1.5">{current}</span>
                <span className="text-ink-2 caret">{interim}</span>
              </div>
            </div>
          )}
        </div>

        {/* 저장 */}
        <form action={saveRecordingAction} className="card p-5 flex flex-wrap items-center gap-3">
          <input type="hidden" name="space_id" value={spaceId} />
          <input type="hidden" name="utterances" value={JSON.stringify(lines.map(({ speaker, text }) => ({ speaker, text })))} />
          <input name="title" defaultValue={defaultTitle} className="input flex-1 min-w-[200px]" placeholder="회의 제목" />
          <SaveButton disabled={recording || lines.length === 0} />
          <span className="text-[12px] text-ink-3 basis-full">멈춘 뒤 정리하기를 누르면 1분 안에 달라진 점이 나와요. 녹음 자체는 저장하지 않고 글만 남겨요.</span>
        </form>
      </div>

      {/* 화자 */}
      <aside className="card p-5 self-start lg:sticky lg:top-20">
        <div className="text-[13px] font-semibold">지금 말하는 사람</div>
        <p className="text-[12px] text-ink-3 mt-0.5">말하는 사람이 바뀌면 눌러주세요</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {speakers.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setCurrent(s)}
              className={`inline-flex items-center gap-1.5 rounded-full pl-1 pr-3 py-1 text-[13.5px] transition ${current === s ? "bg-ink text-white" : "bg-black/5 hover:bg-black/10"}`}
            >
              <Avatar name={s} color={colorOf(s)} size={22} />
              {s}
            </button>
          ))}
          <button type="button" onClick={addSpeaker} className="rounded-full px-3 py-1 text-[13px] text-blue bg-blue/10 hover:bg-blue/15 transition">
            + 추가
          </button>
        </div>
        <div className="mt-5 pt-4 text-[12px] text-ink-3 leading-relaxed [box-shadow:inset_0_0.5px_0_rgba(0,0,0,0.08)]">
          <div className="font-semibold text-ink-2 mb-1">단축키</div>
          숫자 1~9: 말하는 사람 바꾸기
          <br />
          스페이스: 녹음 시작/멈춤
        </div>
      </aside>
      <Hotkeys speakers={speakers} onPick={setCurrent} onToggle={recording ? stop : start} />
    </div>
  );
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} className="btn btn-md btn-primary">
      {pending && <Spinner />}
      {pending ? "저장하는 중…" : "정리하기"}
    </button>
  );
}

function Hotkeys({ speakers, onPick, onToggle }: { speakers: string[]; onPick: (s: string) => void; onToggle: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        onToggle();
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && speakers[n - 1]) onPick(speakers[n - 1]);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [speakers, onPick, onToggle]);
  return null;
}
