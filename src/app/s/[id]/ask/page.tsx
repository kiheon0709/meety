import { AskBox } from "@/components/AskBox";

export const dynamic = "force-dynamic";

// "갈피에게 물어보기" — 저장된 맥락과 발화만으로 답한다. 답은 저장하지 않는다.
export default async function AskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="fade-up max-w-2xl mx-auto" style={{ "--i": 2 } as React.CSSProperties}>
      <h2 className="text-[22px] font-bold tracking-[-0.02em]">미티에게 물어보기</h2>
      <p className="text-[13.5px] text-ink-2 mt-0.5 mb-5">지금까지의 결정·의견·할 일과 그때 한 말로만 답해요. 기록에 없는 건 없다고 말해요.</p>
      <AskBox spaceId={id} />
    </div>
  );
}
