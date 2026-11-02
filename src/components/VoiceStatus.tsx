"use client";

import { useEffect, useState } from "react";
import { Mic } from "lucide-react";

// 목소리 등록 상태: 음성 서버(GET /speakers)를 화면이 직접 묻는다. 꺼져 있으면 "음성 서버 꺼짐"
// 주소는 회의 화면(transport.ts)과 같은 규칙: 지금 연 호스트 + NEXT_PUBLIC_VOICE_PORT(기본 8765)
let cache: Promise<string[] | null> | null = null;
function speakers(): Promise<string[] | null> {
  if (!cache) {
    const base = process.env.NEXT_PUBLIC_VOICE_URL ? process.env.NEXT_PUBLIC_VOICE_URL.replace(/^ws/, "http").replace(/\/ws$/, "") : `http://${location.hostname}:${process.env.NEXT_PUBLIC_VOICE_PORT || 8765}`;
    cache = fetch(`${base}/speakers`, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { speakers?: string[] } | null) => d?.speakers ?? null)
      .catch(() => null);
  }
  return cache;
}

export function VoiceStatus({ name }: { name: string }) {
  const [s, setS] = useState<"loading" | "on" | "off" | "down">("loading");
  useEffect(() => {
    let off = false;
    void speakers().then((list) => !off && setS(list === null ? "down" : list.includes(name) ? "on" : "off"));
    return () => {
      off = true;
    };
  }, [name]);
  const label = { loading: "목소리 확인 중", on: "목소리 등록됨", off: "목소리 아직", down: "음성 서버 꺼짐" }[s];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${s === "on" ? "bg-[var(--agent-soft)] text-agent" : s === "off" ? "bg-orange/12 text-amber-ink" : "bg-black/5 text-ink-3"}`}>
      <Mic className="h-3 w-3" strokeWidth={2.2} />
      {label}
    </span>
  );
}
