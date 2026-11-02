"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FileText, Plus, Upload, X } from "lucide-react";
import type { AgendaItem, DocInfo, Intensity, MeetingMode, StartMeetingReq, StartMeetingRes } from "@/lib/live/contract";
import { Avatar } from "@/components/ui";
import { SCENARIOS } from "./mock";
import { INTENSITIES, INTENSITY, type MeetingSetup } from "./state";
import { setupKey } from "./LiveMeeting";
import { MODES, ROLES, ROLE_LABEL, allRoles, withHostMode } from "./start-req";

type SpaceOpt = { id: string; name: string; demo: boolean; members: { name: string; color: string }[] };
type Row = { title: string; expected: string };

const toRows = (a: AgendaItem[]): Row[] => a.map((x) => ({ title: x.title, expected: x.expected.join(", ") }));
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

export function NewMeetingForm({ spaces, initialSpaceId }: { spaces: SpaceOpt[]; initialSpaceId?: string }) {
  const router = useRouter();
  const [spaceId, setSpaceId] = useState(initialSpaceId && spaces.some((s) => s.id === initialSpaceId) ? initialSpaceId : (spaces[0]?.id ?? ""));
  const space = spaces.find((s) => s.id === spaceId);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([{ title: "", expected: "" }]);
  const [intensity, setIntensity] = useState<Intensity>("mid");
  const [people, setPeople] = useState<string[] | null>(null); // null = 프로젝트 팀원 전부
  const [host, setHost] = useState<string | null>(null); // null = 첫 참석자
  const [mode, setMode] = useState<MeetingMode>("decision");
  const [dial, setDial] = useState(MODES.decision.participation);
  const [roles, setRoles] = useState(allRoles);
  const pickMode = (m: MeetingMode) => {
    setMode(m);
    setDial(MODES[m].participation); // 회의 종류는 참여도의 초깃값
  };
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [mock, setMock] = useState<"A" | "B" | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 이 프로젝트에 묶인 자료 (GET /api/live/docs?spaceId=). 처음엔 다 켠다 (npm run meeting이 기획 문서를 묶어 둔다)
  useEffect(() => {
    if (!spaceId) return;
    let off = false;
    fetch(`/api/live/docs?spaceId=${encodeURIComponent(spaceId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        if (off) return;
        const list: DocInfo[] = Array.isArray(d) ? d : [];
        setDocs(list);
        setDocIds((prev) => (prev.length ? prev : list.map((x) => x.id)));
      })
      .catch(() => !off && setDocs([]));
    return () => {
      off = true;
    };
  }, [spaceId]);

  const participants = people ?? space?.members.map((m) => m.name) ?? [];

  // 파일을 올리면 이 프로젝트 자료로 읽어 묶고(POST /api/live/docs/upload), 바로 켠다
  const upload = async (file: File) => {
    if (!spaceId) return;
    setUploading(file.name);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("spaceId", spaceId);
      fd.set("file", file);
      const r = await fetch("/api/live/docs/upload", { method: "POST", body: fd });
      const d = (await r.json().catch(() => ({}))) as DocInfo & { error?: string };
      if (!r.ok) throw new Error(d.error ?? String(r.status));
      setDocs((prev) => [...(prev ?? []).filter((x) => x.id !== d.id), d]);
      setDocIds((prev) => (prev.includes(d.id) ? prev : [...prev, d.id]));
    } catch (e) {
      setErr(`자료를 올리지 못했어요: ${(e as Error).message}`);
    } finally {
      setUploading(null);
    }
  };

  const fill = (key: "A" | "B") => {
    const s = SCENARIOS[key].setup;
    const demo = spaces.find((x) => x.demo) ?? spaces[0];
    if (demo) setSpaceId(demo.id);
    setTitle(s.title);
    setRows(toRows(s.agenda));
    setIntensity(s.intensity);
    setPeople(s.participants ?? null);
    pickMode(key === "B" ? "presentation" : "decision");
    // 예시 대본의 자료 이름(B-plan.md)을 읽어 둔 자료 id로. 없으면 지금 고른 것 그대로
    setDocIds(s.docIds ? (docs ?? []).filter((d) => s.docIds!.some((n) => d.id.startsWith(n.replace(/\.md$/, "")))).map((d) => d.id) : docIds);
    setMock(key);
    setErr(null);
  };

  const start = async () => {
    const agenda = toAgenda(rows);
    if (!spaceId || !title.trim()) {
      setErr("프로젝트와 회의 제목을 정해 주세요");
      return;
    }
    if (mock) {
      router.push(`/live/${SCENARIOS[mock].meetingId}?mock=${mock}`);
      return;
    }
    const req: StartMeetingReq = withHostMode({ spaceId, title: title.trim(), agenda, intensity, participants, docIds: docIds.length ? docIds : undefined }, { host, mode, participation: dial, roles });
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

  const docList = [...(docs ?? []).map((d) => ({ id: d.id, title: d.title })), ...docIds.filter((id) => !docs?.some((d) => d.id === id)).map((id) => ({ id, title: id }))];

  return (
    <div className="space-y-4">
      <div className="card-agent p-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">처음이면 예시로 해 보세요</div>
          <div className="text-[12.5px] text-ink-2">5조의 네 번째 회의를 한 번에 채워요</div>
        </div>
        <button type="button" onClick={() => fill("A")} className="btn btn-md btn-agent">
          예시로 채우기
        </button>
        <button type="button" onClick={() => fill("B")} className="btn btn-md btn-secondary">
          발표 예시
        </button>
      </div>

      <div className="card p-5 space-y-5">
        <Field label="프로젝트">
          <select
            value={spaceId}
            onChange={(e) => {
              setSpaceId(e.target.value);
              setPeople(null);
            }}
            className="input"
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.demo ? " (예시)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="회의 제목">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="예: 회의 4 — 대회 준비" />
        </Field>

        <Field label="안건" hint="안건마다 끝날 때 나와야 할 것을 쉼표로 적어요. 회의가 끝나면 미티가 하나씩 확인해요.">
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <span className="hidden sm:inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/6 text-[11px] font-bold text-ink-2">{i + 1}</span>
                <div className="sm:w-[40%] shrink-0">
                  <input value={r.title} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} className="input" placeholder="안건" />
                </div>
                <div className="flex-1 min-w-0">
                  <input
                    value={r.expected}
                    onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, expected: e.target.value } : x)))}
                    className="input"
                    placeholder="끝날 때 나와야 할 것 (예: 날짜, 담당자)"
                  />
                </div>
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((_, k) => k !== i))}
                    className="h-8 w-8 shrink-0 rounded-full text-ink-3 hover:bg-black/5 flex items-center justify-center self-end sm:self-auto"
                    aria-label="안건 빼기"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setRows([...rows, { title: "", expected: "" }])} className="btn btn-sm btn-ghost">
              <Plus className="h-3.5 w-3.5" /> 안건 추가
            </button>
          </div>
        </Field>

        {space && space.members.length > 0 && (
          <Field label="참가자">
            <div className="flex flex-wrap gap-2">
              {space.members.map((m) => {
                const on = participants.includes(m.name);
                return (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => setPeople(on ? participants.filter((p) => p !== m.name) : [...participants, m.name])}
                    className={`inline-flex items-center gap-1.5 rounded-full pl-1 pr-3 py-1 text-[13.5px] transition ${on ? "bg-ink text-surface" : "bg-black/5 text-ink-2 hover:bg-black/10"}`}
                  >
                    <Avatar name={m.name} color={m.color} size={22} />
                    {m.name}
                  </button>
                );
              })}
            </div>
            {participants.length === 1 && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-ink-2">
                <span className="h-2 w-2 rounded-[30%]" style={{ background: "var(--agent-grad)" }} />
                1:1 회의 — 미티와 바로 대화해요(부르지 않아도 답해요)
              </p>
            )}
          </Field>
        )}

        {participants.length > 1 && (
          <Field label="호스트" hint="미티가 개인에게만 할 말·손 든 것을 먼저 보여 주는 사람이에요.">
            <select value={host && participants.includes(host) ? host : participants[0]} onChange={(e) => setHost(e.target.value)} className="input sm:w-56">
              {participants.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="회의 종류" hint="미티가 맡을 역할과 말할 횟수의 기본값이 바뀌어요.">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(Object.keys(MODES) as MeetingMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => pickMode(m)}
                aria-pressed={mode === m}
                className={`rounded-2xl px-4 py-3 text-left transition ${mode === m ? "bg-surface shadow-[0_0_0_1.5px_var(--agent-1)]" : "bg-black/[0.035] hover:bg-black/[0.06]"}`}
              >
                <div className={`text-[15px] font-bold ${mode === m ? "text-agent" : ""}`}>{MODES[m].label}</div>
                <div className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">{MODES[m].line}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label={`참여도 ${dial}`} hint="미티가 얼마나 나서는지예요. 회의 중에도 화면 ⚙와 “미티야 조용히 해 / 더 끼어들어”로 바꿀 수 있어요.">
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={dial}
            onChange={(e) => setDial(Number(e.target.value))}
            aria-valuetext={`참여도 ${dial}`}
            className="w-full sm:w-[420px] accent-[var(--agent-1)]"
          />
          <div className="flex justify-between sm:w-[420px] text-[12px] text-ink-3">
            <span>조용히</span>
            <span>적극적으로</span>
          </div>
        </Field>

        <details>
          <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2">세부 — 역할·끼어들기 강도</summary>
          <div className="mt-3 space-y-5">
        <Field label="미티가 맡을 역할" hint="끈 역할은 회의 중에 하지 않아요. 회의 중에도 ⚙에서 바꿀 수 있어요.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] bg-black/[0.035] cursor-pointer">
                <input type="checkbox" checked={roles[r]} onChange={(e) => setRoles({ ...roles, [r]: e.target.checked })} className="accent-[var(--agent-1)]" />
                {ROLE_LABEL[r]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="끼어들기 강도" hint="회의 중에 말로 낮출 수 있어요 (“미티야 끼어들지 마”). 올리는 건 화면에서 확인해야 해요.">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {INTENSITIES.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIntensity(i)}
                aria-pressed={intensity === i}
                className={`rounded-2xl px-4 py-3 text-left transition ${intensity === i ? "bg-surface shadow-[0_0_0_1.5px_var(--agent-1)]" : "bg-black/[0.035] hover:bg-black/[0.06]"}`}
              >
                <div className={`text-[16px] font-bold ${intensity === i ? "text-agent" : ""}`}>{INTENSITY[i].label}</div>
                <div className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">{INTENSITY[i].line}</div>
              </button>
            ))}
          </div>
        </Field>
          </div>
        </details>

        <Field label="참고 자료" hint="미티가 근거로 볼 기획 문서예요. md·txt·pdf·노션 내보내기 zip을 올릴 수 있어요(10MB까지). 없으면 그동안의 회의 기록만 봐요.">
          <label className={`mb-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] bg-black/5 text-ink-2 hover:bg-black/10 ${uploading ? "opacity-60 pointer-events-none" : "cursor-pointer"}`}>
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
          {docList.length === 0 ? (
            <p className="text-[13px] text-ink-3">{docs === null ? "자료를 찾는 중…" : "읽어 둔 자료가 없어요"}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {docList.map((d) => {
                const on = docIds.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDocIds(on ? docIds.filter((x) => x !== d.id) : [...docIds, d.id])}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition ${on ? "bg-agent/12 text-agent font-medium" : "bg-black/5 text-ink-2 hover:bg-black/10"}`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {d.title}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={start} disabled={busy} className="btn btn-lg btn-dark">
          {busy ? "미티를 부르는 중…" : "회의 시작"}
        </button>
        {mock && (
          <label className="inline-flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer select-none">
            <input type="checkbox" checked onChange={() => setMock(null)} className="accent-[var(--agent-1)]" />
            예시 대본대로 재생 (마이크 없이)
          </label>
        )}
        {err && (
          <span className="text-[13px] text-red">
            {err}
            {!mock && (
              <button type="button" onClick={() => router.push(`/live/demo-a?mock=A`)} className="ml-2 underline">
                예시로 보기
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[13px] font-semibold mb-1.5">{label}</div>
      {children}
      {hint && <p className="text-[12px] text-ink-3 mt-1.5">{hint}</p>}
    </div>
  );
}
