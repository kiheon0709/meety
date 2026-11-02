import Link from "next/link";
import { FileText } from "lucide-react";
import { docsForSpace } from "@/lib/live/docs";
import { getConnection } from "@/lib/integrations/connections";
import { importNotionAction } from "@/lib/actions";
import { PageHead } from "@/components/PageHead";
import { DocUpload } from "@/components/DocUpload";

export const dynamic = "force-dynamic";

// 자료: 미티가 근거로 읽는 파일·노션 (uiux-redesign.md §2). 회의 준비에서 회의마다 켜고 끈다
export default async function DocsPage({ params }: PageProps<"/s/[id]/docs">) {
  const { id } = await params;
  const docs = docsForSpace(id);
  const notion = getConnection(id, "notion");
  return (
    <div className="max-w-[920px] space-y-6">
      <PageHead title="자료" sub="미티가 회의 중에 근거로 보는 기획 문서예요. 읽은 문장마다 출처를 붙여서 말해요." aside={<DocUpload spaceId={id} />} />
      <section className="fade-up" style={{ "--i": 1 } as React.CSSProperties}>
        {docs.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-[15px] font-semibold">아직 읽은 자료가 없어요</p>
            <p className="text-[13.5px] text-ink-2 mt-1">md·txt·pdf·노션 내보내기 zip을 올리면(10MB까지) 미티가 읽고 사실로 나눠 둬요.</p>
          </div>
        ) : (
          <div className="card divide-hair">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-4 py-3.5">
                <span className="h-9 w-9 shrink-0 rounded-xl bg-[var(--agent-soft)] text-agent flex items-center justify-center">
                  <FileText className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-medium truncate">{d.title}</div>
                  <div className="text-[12px] text-ink-3 truncate">{d.path}</div>
                </div>
                <span className="text-[12px] text-ink-2 shrink-0 tabular-nums">사실 {d.facts}개</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="fade-up card p-5" style={{ "--i": 2 } as React.CSSProperties}>
        <div className="font-semibold text-[15px]">노션 페이지</div>
        {notion ? (
          <form action={importNotionAction} className="mt-3 flex flex-col sm:flex-row gap-2">
            <input type="hidden" name="space_id" value={id} />
            <input name="page" placeholder="https://www.notion.so/… 페이지 주소" className="input flex-1 text-[12.5px]" />
            <button className="btn btn-md btn-secondary shrink-0">가져오기</button>
          </form>
        ) : (
          <p className="text-[13px] text-ink-2 mt-1">
            노션을 연결하면 고른 페이지만 읽어요.{" "}
            <Link href={`/s/${id}/settings#integrations`} className="text-agent font-semibold">
              설정에서 연결하기
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
