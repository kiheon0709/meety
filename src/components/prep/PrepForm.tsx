"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, FileText, Plus, RotateCcw, Upload, X } from "lucide-react";
import type { AgendaItem, DocInfo, Intensity, MeetingMode, RoleKind, StartMeetingReq, StartMeetingRes } from "@/lib/live/contract";
import { Avatar } from "@/components/ui";
import { AgentMark } from "@/components/Logo";
import { VoiceStatus } from "@/components/VoiceStatus";
import { SCENARIOS } from "@/components/live/mock";
import { INTENSITIES, INTENSITY, type MeetingSetup } from "@/components/live/state";
import { setupKey } from "@/components/live/LiveMeeting";
import { MODES, ROLES, allRoles, withHostMode } from "@/components/live/start-req";

// 회의 준비 (uiux-redesign.md §4). 네 덩어리 — 무엇을 · 누가 · 미티는 · 무엇을 보고.
// 두 번째 회의부터는 지난 회의 기록(live_json)으로 참석자·다이얼·역할·자료를 채우고, 안 끝난 안건을 "남은 것"으로 제안한다.
// 시작 요청은 옛 NewMeetingForm(S6)과 같다: withHostMode → POST /api/live/start → localStorage(setupKey) → /live/{id}

export type PrepDefaults = {
  from: { title: string; held_at: string } | null;
  meetings: number;
  participants: string[] | null;
  host: string | null;
  mode: MeetingMode | null;
  participation: number | null;
  roles: Partial<Record<RoleKind, boolean>> | null;
  docIds: string[] | null;
  leftovers: { title: string; expected: string[]; why: string }[];
};
export type PrepSpace = { id: string; name: string; demo: boolean; members: { name: string; color: string }[]; defaults: PrepDefaults };
type Row = { title: string; expected: string };

const ROLE_INFO: Record<RoleKind, { img: string; label: string; line: string }> = {
  conflict: { img: "1-conflict", label: "지난 결정 확인", line: "정한 것과 다른 말이 나오면" },
  owner_gap: { img: "2-owner-gap", label: "업무 분담 제안", line: "정했는데 맡을 사람이 없으면" },
  research: { img: "3-research", label: "팀 자료 리서치", line: "수치·자료가 궁금할 때" },
  feedback: { img: "4-feedback", label: "피드백", line: "반론 없이 너무 빨리 정하면" },
  structure: { img: "5-structure", label: "갈등 정리", line: "같은 두 안이 맴돌면" },
  quiet_member: { img: "6-quiet-member", label: "조용한 팀원", line: "오래 말 없는 사람에게 따로" },
  suggest: { img: "7-suggest", label: "제안", line: "막혔을 때 아이디어를" },
};
function seed(d: PrepDefaults | undefined, withLast: boolean) {
  const l = withLast && d?.from ? d : null;
  const mode = l?.mode ?? "decision";
  return { people: l?.participants ?? null, host: l?.host ?? null, mode, dial: l?.participation ?? MODES[mode].participation, roles: { ...allRoles(), ...(l?.roles ?? {}) } };
}
const dialWord = (n: number) => (n <= 3 ? "조용히, 손만 들어요" : n <= 6 ? "필요할 때 말해요" : "먼저 꺼내고 자주 거들어요");
const toAgenda = (rows: Row[]): AgendaItem[] =>
  rows
    .filter((r) => r.title.trim())
    .map((r) => ({
      title: r.title.trim(),
      expected: r.expected
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    }));

export function PrepForm({ spaces, initialSpaceId }: { spaces: PrepSpace[]; initialSpaceId?: string }) {
  const router = useRouter();
  const [spaceId, setSpaceId] = useState(initialSpaceId && spaces.some((s) => s.id === initialSpaceId) ? initialSpaceId : (spaces[0]?.id ?? ""));
  const space = spaces.find((s) => s.id === spaceId);
  const d = space?.defaults;
  const [useLast, setUseLast] = useState(true);
  const last = useLast && d?.from ? d : null;
  const first = seed(spaces.find((s) => s.id === spaceId)?.defaults, true);

  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([{ title: "", expected: "" }]);
  const [people, setPeople] = useState<string[] | null>(first.people);
  const [host, setHost] = useState<string | null>(first.host);
  const [mode, setMode] = useState<MeetingMode>(first.mode);
  const [dial, setDial] = useState(first.dial);
  const [roles, setRoles] = useState(first.roles);
  const [intensity, setIntensity] = useState<Intensity>("mid");
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [mock, setMock] = useState<"A" | "B" | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 프로젝트를 바꾸거나 "처음부터"를 누르면 기본값을 다시 채운다
  const reseed = (sid: string, withLast: boolean) => {
    const x = seed(spaces.find((s) => s.id === sid)?.defaults, withLast);
    setPeople(x.people);
    setHost(x.host);
    setMode(x.mode);
    setDial(x.dial);
    setRoles(x.roles);
    setDocs(null);
    setDocIds([]);
  };

  // 이 프로젝트에 묶인 자료 (GET /api/live/docs?spaceId=). 지난 회의에 켠 자료가 있으면 그것만, 없으면 다 켠다
  useEffect(() => {
    if (!spaceId) return;
    let off = false;
    fetch(`/api/live/docs?spaceId=${encodeURIComponent(spaceId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((x) => {
        if (off) return;
        const list: DocInfo[] = Array.isArray(x) ? x : [];
        setDocs(list);
        if (mock) return;
        const lastIds = last?.docIds?.filter((id) => list.some((l) => l.id === id));
        setDocIds(lastIds?.length ? lastIds : list.map((l) => l.id));
      })
      .catch(() => !off && setDocs([]));
    return () => {
      off = true;
    };
  }, [spaceId, useLast]); // eslint-disable-line react-hooks/exhaustive-deps

  const participants = people ?? space?.members.map((m) => m.name) ?? [];
  const solo = participants.length === 1;
  const agenda = toAgenda(rows);
  const onRoles = ROLES.filter((r) => roles[r]).length;
  const added = useMemo(() => new Set(rows.map((r) => r.title.trim())), [rows]);

  const addRow = (r: Row) => setRows((prev) => [...prev.filter((x) => x.title.trim() || x.expected.trim()), r]);
  const pickMode = (m: MeetingMode) => {
    setMode(m);
    setDial(MODES[m].participation);
  };

  const upload = async (file: File) => {
    if (!spaceId) return;
    setUploading(file.name);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("spaceId", spaceId);
      fd.set("file", file);
      const r = await fetch("/api/live/docs/upload", { method: "POST", body: fd });
      const x = (await r.json().catch(() => ({}))) as DocInfo & { error?: string };
      if (!r.ok) throw new Error(x.error ?? String(r.status));
      setDocs((prev) => [...(prev ?? []).filter((y) => y.id !== x.id), x]);
      setDocIds((prev) => (prev.includes(x.id) ? prev : [...prev, x.id]));
    } catch (e) {
      setErr(`자료를 올리지 못했어요: ${(e as Error).message}`);
    } finally {
      setUploading(null);
    }
  };

  // 시연용 예시 대본 (마이크 없이 재생)
  const fill = (key: "A" | "B") => {
    const s = SCENARIOS[key].setup;
    const demo = spaces.find((x) => x.demo) ?? spaces[0];
    if (demo) setSpaceId(demo.id);
    setTitle(s.title);
    setRows(s.agenda.map((a) => ({ title: a.title, expected: a.expected.join(", ") })));
    setPeople(s.participants ?? null);
    setIntensity(s.intensity);
    pickMode(key === "B" ? "presentation" : "decision");
    setDocIds(s.docIds ? (docs ?? []).filter((x) => s.docIds!.some((n) => x.id.startsWith(n.replace(/\.md$/, "")))).map((x) => x.id) : docIds);
    setMock(key);
    setErr(null);
  };

  const start = async () => {
    if (!spaceId || !title.trim()) {
      setErr("회의 제목을 적어 주세요");
      return;
    }
    if (mock) {
      router.push(`/live/${SCENARIOS[mock].meetingId}?mock=${mock}`);
      return;
    }
    const req: StartMeetingReq = withHostMode(
      { spaceId, title: title.trim(), agenda, intensity, participants, docIds: docIds.length ? docIds : undefined },
      { host, mode, participation: dial, roles },
    );
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/live/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      if (!r.ok) throw new Error(String(r.status));
      const { meetingId, controlToken } = (await r.json()) as StartMeetingRes;
      const setup: MeetingSetup = { ...req, spaceName: space?.name, controlToken };
      try {
        localStorage.setItem(setupKey(meetingId), JSON.stringify(setup));
      } catch {
        /* 저장 못 해도 회의는 된다 */
      }
      router.push(`/live/${encodeURIComponent(meetingId)}?space=${encodeURIComponent(spaceId)}`);
    } catch {
      setBusy(false);
      setErr("미티를 부르지 못했어요. 잠시 뒤 다시 눌러 주세요.");
    }
  };

  const docList = (docs ?? []).map((x) => ({ id: x.id, title: x.title }));

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-8 lg:items-start pb-24 lg:pb-0">
      <div className="space-y-4 min-w-0">
        {spaces.length > 1 && (
          <select
            value={spaceId}
            onChange={(e) => {
              setSpaceId(e.target.value);
              reseed(e.target.value, useLast);
            }} className="input !w-auto" aria-label="프로젝트">
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.demo ? " (예시)" : ""}
              </option>
            ))}
          </select>
        )}

        {d?.from && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--agent-soft)] px-4 py-3 text-[13.5px]">
            <AgentMark size={22} />
            <span className="min-w-0 flex-1">
              {useLast ? (
                <>
                  지난 회의 <b>{d.from.title}</b>의 참석자·참여도·역할·자료를 가져왔어요.
                </>
              ) : (
                "처음부터 채우는 중이에요."
              )}
            </span>
            <button
              type="button"
              onClick={() => {
                setUseLast(!useLast);
                reseed(spaceId, !useLast);
              }}
              className="btn btn-sm btn-secondary"
            >
              <RotateCcw className="h-3.5 w-3.5" /> {useLast ? "처음부터" : "지난 회의 값으로"}
            </button>
          </div>
        )}

        {/* ① 무엇을 */}
        <Block n={1} title="무엇을 정하나요" hint="안건마다 끝날 때 나와야 할 것을 적으면, 회의 끝에 미티가 하나씩 확인해요.">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="input !text-[16px] !py-3 font-semibold" placeholder={`회의 ${(d?.meetings ?? 0) + 1} — 무엇을 정하나`} aria-label="회의 제목" />
          {d && d.leftovers.length > 0 && (
            <div className="mt-3">
              <div className="text-[12.5px] font-semibold text-ink-2 mb-1.5">지난 회의에서 남은 것 — 누르면 안건에 넣어요</div>
              <div className="flex flex-wrap gap-1.5">
                {d.leftovers.map((l) => {
                  const on = added.has(l.title);
                  return (
                    <button
                      key={l.title}
                      type="button"
                      disabled={on}
                      onClick={() => addRow({ title: l.title, expected: l.expected.join(", ") })}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition ${on ? "bg-[var(--agent-soft)] text-agent" : "bg-orange/12 text-amber-ink hover:bg-orange/20"}`}
                    >
                      {on ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                      {l.title}
                      <span className="opacity-70 text-[11.5px]">{l.why}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="mt-3 space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="mt-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--agent-soft)] text-[11px] font-bold text-agent">{i + 1}</span>
                <div className="flex-1 min-w-0 grid gap-1.5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                  <input value={r.title} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} className="input" placeholder="안건 (예: 시연 영상 장면 순서)" />
                  <input value={r.expected} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, expected: e.target.value } : x)))} className="input" placeholder="끝날 때 나와야 할 것 (예: 순서, 담당자)" />
                </div>
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="mt-1 h-8 w-8 shrink-0 rounded-full text-ink-3 hover:bg-black/5 flex items-center justify-center" aria-label="안건 빼기">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setRows([...rows, { title: "", expected: "" }])} className="btn btn-sm btn-ghost">
              <Plus className="h-3.5 w-3.5" /> 안건 추가
            </button>
          </div>
        </Block>

        {/* ② 누가 */}
        {space && (
          <Block n={2} title="누가 오나요" hint="오늘 온 사람만 골라요. 목소리를 등록한 사람은 받아쓰기에 이름이 붙어요.">
            <div className="grid gap-2 grid-cols-2">
              {space.members.map((m) => {
                const on = participants.includes(m.name);
                return (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => setPeople(on ? participants.filter((p) => p !== m.name) : [...participants, m.name])}
                    aria-pressed={on}
                    className={`flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left transition ${on ? "bg-surface shadow-[0_0_0_1.5px_var(--agent-1)]" : "bg-black/[0.035] opacity-60 hover:opacity-100"}`}
                  >
                    <Avatar name={m.name} color={m.color} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] font-semibold truncate">{m.name}</span>
                      <VoiceStatus name={m.name} />
                    </span>
                    <span className={`h-5 w-5 rounded-full flex items-center justify-center ${on ? "bg-agent text-white" : "shadow-[inset_0_0_0_1.5px_var(--ink-3)]"}`}>{on && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                  </button>
                );
              })}
            </div>
            {solo && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--agent-soft)] px-3 py-1.5 text-[13px] text-agent font-semibold">
                <AgentMark size={18} /> 1:1 — 미티와 둘이 해요. 부르지 않아도 답해요
              </p>
            )}
            {participants.length > 1 && (
              <label className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                호스트
                <select value={host && participants.includes(host) ? host : participants[0]} onChange={(e) => setHost(e.target.value)} className="input !w-auto !py-1.5">
                  {participants.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <span className="text-[12px] text-ink-3">미티가 개인에게만 할 말을 먼저 보여 주는 사람</span>
              </label>
            )}
          </Block>
        )}

        {/* ③ 미티는 */}
        <Block n={3} title="미티는 얼마나 나설까요" hint="회의 중에도 “미티야 조용히 해 / 더 끼어들어”나 화면 ⚙로 바꿀 수 있어요.">
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(MODES) as MeetingMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => pickMode(m)}
                aria-pressed={mode === m}
                className={`rounded-2xl px-3 py-2.5 text-left transition ${mode === m ? "bg-surface shadow-[0_0_0_1.5px_var(--agent-1)]" : "bg-black/[0.035] hover:bg-black/[0.06]"}`}
              >
                <div className={`text-[14px] font-bold ${mode === m ? "text-agent" : ""}`}>{MODES[m].label}</div>
                <div className="hidden sm:block text-[12px] text-ink-2 mt-0.5 leading-snug">{MODES[m].line}</div>
              </button>
            ))}
          </div>
          <div className="mt-4 rounded-2xl bg-black/[0.03] px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold">참여도</span>
              <span className="text-[13px] text-agent font-semibold">
                <span className="text-[22px] font-bold tabular-nums mr-1">{dial}</span>
                {dialWord(dial)}
              </span>
            </div>
            <input type="range" min={0} max={10} step={1} value={dial} onChange={(e) => setDial(Number(e.target.value))} aria-valuetext={`참여도 ${dial}`} className="mt-2 w-full accent-[var(--agent-1)]" />
            <div className="flex justify-between text-[11.5px] text-ink-3">
              <span>0 조용히</span>
              <span>10 적극적으로</span>
            </div>
          </div>
          <div className="mt-4 text-[12.5px] font-semibold text-ink-2 mb-1.5">
            맡길 역할 <span className="text-ink-3 font-normal">{onRoles}/7</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {ROLES.map((r) => {
              const on = roles[r];
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRoles({ ...roles, [r]: !on })}
                  aria-pressed={on}
                  className={`relative rounded-2xl p-2.5 text-left transition ${on ? "bg-surface shadow-[0_0_0_1.5px_var(--agent-1)]" : "bg-black/[0.035] grayscale opacity-55 hover:opacity-80"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/meety/roles/${ROLE_INFO[r].img}.png`} alt="" width={52} height={52} className="rounded-xl bg-[var(--agent-soft)]" />
                  <div className="mt-1.5 text-[13px] font-bold">{ROLE_INFO[r].label}</div>
                  <div className="text-[11.5px] text-ink-2 leading-snug">{ROLE_INFO[r].line}</div>
                  <span className={`absolute top-2.5 right-2.5 h-5 w-5 rounded-full flex items-center justify-center ${on ? "bg-agent text-white" : "shadow-[inset_0_0_0_1.5px_var(--ink-3)]"}`}>{on && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                </button>
              );
            })}
          </div>
          <details className="mt-4">
            <summary className="cursor-pointer select-none text-[12.5px] font-semibold text-ink-2">세부 — 끼어들기 강도</summary>
            <p className="text-[12px] text-ink-3 mt-1.5 mb-2">회의 중에 말로 낮출 수 있어요 (“미티야 끼어들지 마”). 올리는 건 화면에서 확인해야 해요.</p>
            <div className="grid grid-cols-3 gap-2">
              {INTENSITIES.map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIntensity(i)}
                  aria-pressed={intensity === i}
                  className={`rounded-2xl px-3 py-2.5 text-left transition ${intensity === i ? "bg-surface shadow-[0_0_0_1.5px_var(--agent-1)]" : "bg-black/[0.035] hover:bg-black/[0.06]"}`}
                >
                  <div className={`text-[14px] font-bold ${intensity === i ? "text-agent" : ""}`}>{INTENSITY[i].label}</div>
                  <div className="hidden sm:block text-[12px] text-ink-2 mt-0.5 leading-snug">{INTENSITY[i].line}</div>
                </button>
              ))}
            </div>
          </details>
        </Block>

        {/* ④ 무엇을 보고 */}
        <Block n={4} title="무엇을 보고 들어갈까요" hint="미티가 근거로 볼 기획 문서예요. md·txt·pdf·노션 내보내기 zip(10MB까지). 없으면 그동안의 회의 기록만 봐요.">
          <div className="flex flex-wrap gap-2">
            {docList.map((x) => {
              const on = docIds.includes(x.id);
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setDocIds(on ? docIds.filter((y) => y !== x.id) : [...docIds, x.id])}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition ${on ? "bg-[var(--agent-soft)] text-agent font-semibold" : "bg-black/5 text-ink-2 hover:bg-black/10"}`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  {x.title}
                </button>
              );
            })}
            <label className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] shadow-[inset_0_0_0_1px_var(--line)] bg-surface text-ink-2 hover:text-ink ${uploading ? "opacity-60 pointer-events-none" : "cursor-pointer"}`}>
              <Upload className="h-3.5 w-3.5" />
              {uploading ? `읽는 중… ${uploading}` : "자료 올리기"}
              <input
                type="file"
                accept=".md,.markdown,.txt,.pdf,.zip"
                className="sr-only"
                disabled={!!uploading || !spaceId}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void upload(f);
                }}
              />
            </label>
          </div>
          {docs !== null && docList.length === 0 && <p className="mt-2 text-[12.5px] text-ink-3">아직 읽어 둔 자료가 없어요.</p>}
        </Block>

        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3 px-1">
          시연용:
          <button type="button" onClick={() => fill("A")} className="underline hover:text-ink">
            예시 회의로 채우기
          </button>
          <button type="button" onClick={() => fill("B")} className="underline hover:text-ink">
            발표 예시
          </button>
          {mock && (
            <label className="inline-flex items-center gap-1.5 text-ink-2 cursor-pointer select-none">
              <input type="checkbox" checked onChange={() => setMock(null)} className="accent-[var(--agent-1)]" />
              예시 대본대로 재생 (마이크 없이)
            </label>
          )}
        </div>
      </div>

      {/* 오른쪽 요약 + 시작 (휴대폰은 아래 고정 띠) */}
      <aside className="hidden lg:block lg:sticky lg:top-[72px]">
        <div className="card p-5">
          <div className="flex items-center gap-2 text-[14px] font-bold">
            <AgentMark size={30} /> 미티가 이렇게 들어가요
          </div>
          <dl className="mt-4 space-y-2.5 text-[13.5px]">
            <Sum k="참석" v={solo ? "1:1 · 미티와 둘이" : `${participants.length}명`} />
            <Sum k="안건" v={agenda.length ? `${agenda.length}개` : "없음 (자유 대화)"} />
            <Sum k="참여도" v={`${dial} · ${dialWord(dial)}`} />
            <Sum k="역할" v={`${onRoles}/7`} />
            <Sum k="자료" v={`${docIds.length}개`} />
          </dl>
          <button type="button" onClick={start} disabled={busy} className="btn btn-lg btn-agent w-full mt-5">
            {busy ? "미티를 부르는 중…" : "회의 시작"}
          </button>
          {err && <p className="mt-2 text-[12.5px] text-red">{err}</p>}
        </div>
      </aside>
      <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 glass [box-shadow:inset_0_0.5px_0_var(--line)] px-4 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1 text-[12.5px] text-ink-2 leading-tight">
          {err ? (
            <span className="text-red">{err}</span>
          ) : (
            <>
              {solo ? "1:1" : `${participants.length}명`} · 안건 {agenda.length} · 참여도 {dial} · 자료 {docIds.length}
            </>
          )}
        </div>
        <button type="button" onClick={start} disabled={busy} className="btn btn-md btn-agent shrink-0">
          {busy ? "부르는 중…" : "회의 시작"}
        </button>
      </div>
    </div>
  );
}

function Block({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-[16px] font-bold tracking-[-0.02em]">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-agent text-white text-[12px] font-bold">{n}</span>
        {title}
      </h2>
      {hint && <p className="text-[12.5px] text-ink-3 mt-1 mb-3">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

function Sum({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className="font-semibold text-right">{v}</dd>
    </div>
  );
}
