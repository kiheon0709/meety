import Link from "next/link";

// 상단 바의 알림 종. 읽지 않은 수를 배지로.
export function Bell({ unread }: { unread: number }) {
  return (
    <Link href="/notifications" className="relative inline-flex items-center justify-center h-8 w-8 rounded-full text-ink-2 hover:text-ink hover:bg-black/5 transition" aria-label={`알림 ${unread}개`}>
      <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" aria-hidden>
        <path d="M10 2.5a5 5 0 0 0-5 5v3.2l-1.4 2.3a.6.6 0 0 0 .5.9h11.8a.6.6 0 0 0 .5-.9L15 10.7V7.5a5 5 0 0 0-5-5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 16.5a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-orange text-white text-[10px] font-bold leading-4 text-center ring-2 ring-white">{unread > 99 ? "99+" : unread}</span>
      )}
    </Link>
  );
}
