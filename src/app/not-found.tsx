import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-5 py-20 text-center">
      <h1 className="text-[24px] font-bold tracking-[-0.03em]">여기엔 아무것도 없어요</h1>
      <p className="mt-2 text-[14px] text-ink-2">주소가 바뀌었거나, 지워진 항목이에요.</p>
      <Link href="/home" className="btn btn-md btn-primary mt-6">
        내 프로젝트로
      </Link>
    </div>
  );
}
