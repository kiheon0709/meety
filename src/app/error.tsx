"use client";

import Link from "next/link";

// 화면이 깨졌을 때. 녹취·업데이트는 이미 저장돼 있으니 잃는 건 없다.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md px-5 py-20 text-center">
      <h1 className="text-[24px] font-bold tracking-[-0.03em]">화면을 그리다가 멈췄어요</h1>
      <p className="mt-2 text-[14px] text-ink-2">저장된 건 그대로예요. 다시 열어보고, 계속 그러면 알려주세요.</p>
      <p className="mt-3 text-[12px] text-ink-3 font-mono break-all">{error.message}</p>
      <div className="mt-6 flex justify-center gap-2">
        <button onClick={reset} className="btn btn-md btn-primary">
          다시 열기
        </button>
        <Link href="/home" className="btn btn-md btn-secondary">
          내 프로젝트
        </Link>
      </div>
    </div>
  );
}
