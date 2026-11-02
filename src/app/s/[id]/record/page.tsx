import Link from "next/link";
import { listMembers } from "@/lib/service";
import { Recorder } from "@/components/Recorder";

export const dynamic = "force-dynamic";

export default async function RecordPage({ params, searchParams }: PageProps<"/s/[id]/record">) {
  const { id } = await params;
  const sp = await searchParams;
  const members = listMembers(id);
  const d = new Date();
  return (
    <div className="space-y-4">
      <div className="fade-up flex items-end justify-between gap-3" style={{ "--i": 2 } as React.CSSProperties}>
        <div>
          <h2 className="text-[22px] font-bold tracking-[-0.02em]">회의 녹음</h2>
          <p className="text-[13.5px] text-ink-2 mt-0.5">노트북을 테이블 가운데 두고 누르면 돼요. 끝나면 알아서 정리해요.</p>
          {sp?.empty && <p className="text-[13px] text-red mt-1">받아 적힌 말이 없어서 저장하지 않았어요.</p>}
        </div>
        <Link href={`/s/${id}/sessions/new`} className="btn btn-sm btn-secondary shrink-0">
          녹취 붙여넣기
        </Link>
      </div>
      <div className="fade-up" style={{ "--i": 3 } as React.CSSProperties}>
        <Recorder spaceId={id} members={members.map((m) => ({ name: m.name, color: m.color }))} defaultTitle={`${d.getMonth() + 1}월 ${d.getDate()}일 회의`} />
      </div>
    </div>
  );
}
