import Link from "next/link";
import { ensureBriefing, getBriefing, hasContext as hasContextOf } from "@/lib/service";
import { BriefingWatcher } from "@/components/BriefingWatcher";
import { AgentMark } from "@/components/Logo";
import { Empty } from "@/components/ui";
import type { Usage } from "@/lib/agent";

export const dynamic = "force-dynamic";

// 회의 전 브리핑. 맥락이 바뀌면 갈피가 알아서 다시 쓴다 — 쓰는 동안은 옛 브리핑을 그대로 보여준다.
export default async function BriefingPage({ params }: PageProps<"/s/[id]/briefing">) {
  const { id } = await params;
  const briefing = getBriefing(id);
  const hasContext = hasContextOf(id);
  const state = ensureBriefing(id);
  const usage = briefing?.usage_json ? (JSON.parse(briefing.usage_json) as Usage) : null;

  return (
    <div className="fade-up max-w-3xl mx-auto space-y-5" style={{ "--i": 2 } as React.CSSProperties}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href={`/s/${id}`} className="text-[12px] text-ink-3 hover:text-ink transition">
            ← 홈
          </Link>
          <h2 className="text-[26px] font-bold tracking-[-0.03em] mt-0.5">다음 회의 전 브리핑</h2>
          <p className="text-[13.5px] text-ink-2 mt-1">회의 시작할 때 다 같이 30초만 읽으면, 맥락 맞추는 10분이 사라져요.</p>
        </div>
        {state === "writing" && <BriefingWatcher spaceId={id} createdAt={briefing?.created_at ?? null} />}
      </div>
      {!hasContext && <Empty>아직 반영된 맥락이 없어요. 첫 회의를 정리하면 미티가 브리핑을 써요.</Empty>}
      {hasContext && !briefing && <Empty>미티가 첫 브리핑을 쓰고 있어요. 10초쯤 걸려요.</Empty>}
      {briefing && (
        <article className="card p-8 sm:p-10">
          <div className="flex items-center gap-2.5 mb-6 text-[13px] text-ink-2">
            <AgentMark size={26} />
            <span>
              <span className="font-semibold text-ink">미티</span>가 지금까지의 맥락으로 썼어요 · {new Date(briefing.created_at).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })}
            </span>
          </div>
          <div className="prose-brief text-[15.5px] leading-relaxed">{renderMarkdown(briefing.content)}</div>
          <div className="text-[11px] text-ink-3 mt-8 pt-3 font-mono [box-shadow:inset_0_0.5px_0_rgba(0,0,0,0.08)]">
            {briefing.stale ? "맥락이 바뀐 뒤라 곧 새로 써져요 · " : ""}
            {new Date(briefing.created_at).toLocaleString("ko-KR")}
            {usage && ` · ${usage.model} · $${usage.cost_usd}`}
          </div>
        </article>
      )}
    </div>
  );
}

function renderMarkdown(md: string) {
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(
        <ul key={out.length}>
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,2} /.test(t)) {
      flush();
      out.push(<h2 key={out.length}>{t.replace(/^#+\s*/, "")}</h2>);
    } else if (/^#{3,} /.test(t)) {
      flush();
      out.push(<h3 key={out.length}>{t.replace(/^#+\s*/, "")}</h3>);
    } else if (/^[-*] /.test(t)) {
      list.push(t.slice(2));
    } else {
      flush();
      out.push(<p key={out.length}>{inline(t)}</p>);
    }
  }
  flush();
  return out;
}

function inline(s: string): React.ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}
