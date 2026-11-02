// 프로젝트 안 화면 머리: 제목 · 한 줄 설명 · 오른쪽 버튼
export function PageHead({ title, sub, aside }: { title: string; sub?: string; aside?: React.ReactNode }) {
  return (
    <div className="fade-up flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[24px] sm:text-[26px] font-bold tracking-[-0.03em]">{title}</h1>
        {sub && <p className="text-[14px] text-ink-2 mt-1">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}
