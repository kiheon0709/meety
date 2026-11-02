"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Upload } from "lucide-react";

// 자료 올리기: 회의 준비 화면과 같은 길(POST /api/live/docs/upload)로 이 프로젝트에 묶는다
export function DocUpload({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(file.name);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("spaceId", spaceId);
      fd.set("file", file);
      const r = await fetch("/api/live/docs/upload", { method: "POST", body: fd });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(d.error ?? String(r.status));
      router.refresh();
    } catch (e) {
      setErr(`올리지 못했어요: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <label className={`btn btn-md btn-agent ${busy ? "opacity-60 pointer-events-none" : "cursor-pointer"}`}>
        <Upload className="h-4 w-4" />
        {busy ? `읽는 중… ${busy}` : "파일 올리기"}
        <input
          type="file"
          accept=".md,.markdown,.txt,.pdf,.zip"
          className="sr-only"
          disabled={!!busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
      </label>
      {err && <p className="mt-2 text-[12.5px] text-red">{err}</p>}
    </div>
  );
}
