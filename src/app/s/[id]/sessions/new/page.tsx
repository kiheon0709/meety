import { createSessionAction } from "@/lib/actions";
import { ProcessingButton } from "@/components/ProcessingButton";
import { TranscriptField } from "@/components/TranscriptField";
import { todayLocal } from "@/lib/date";

export default async function NewSessionPage({ params }: PageProps<"/s/[id]/sessions/new">) {
  const { id } = await params;
  const today = todayLocal();
  return (
    <form action={createSessionAction} className="max-w-3xl space-y-5">
      <input type="hidden" name="space_id" value={id} />
      <div className="fade-up card p-6 space-y-5" style={{ "--i": 2 } as React.CSSProperties}>
        <div>
          <h2 className="text-[20px] font-bold tracking-[-0.02em]">회의 녹취 넣기</h2>
          <p className="text-[13.5px] text-ink-2 mt-1">클로바노트·줌에서 받아 적은 글을 그대로 붙여넣으면 돼요. 1분 안에 달라진 점이 정리돼요.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_170px]">
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">회의 제목</span>
            <input name="title" className="input mt-1" placeholder="예: 가격 정책 회의" />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">날짜</span>
            <input name="held_at" type="date" defaultValue={today} className="input mt-1" />
          </label>
        </div>
        <TranscriptField />
      </div>
      <div className="fade-up flex items-center gap-3" style={{ "--i": 3 } as React.CSSProperties}>
        <ProcessingButton className="btn btn-lg btn-primary">정리하기</ProcessingButton>
        <span className="text-[12px] text-ink-3">끝나면 바로 달라진 점을 보여드려요.</span>
      </div>
    </form>
  );
}
