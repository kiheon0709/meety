import type { Source } from "@/lib/types";

export function SourceQuotes({ sources, sessionTitles }: { sources: Source[]; sessionTitles?: Map<string, string> }) {
  if (!sources.length) return <p className="text-[12px] text-ink-3">출처 발화 없음</p>;
  return (
    <ul className="space-y-2">
      {sources.map((s, i) => (
        <li key={s.id} className="fade-up card-flat px-4 py-3" style={{ "--i": i + 3 } as React.CSSProperties}>
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="font-semibold">{s.speaker}</span>
            <span className="text-ink-3">
              {sessionTitles?.get(s.session_id) ?? ""}
              {sessionTitles?.get(s.session_id) ? " · " : ""}#{s.idx}
            </span>
          </div>
          <p className="mt-1 text-[14px] leading-relaxed">&ldquo;{s.text}&rdquo;</p>
        </li>
      ))}
    </ul>
  );
}
