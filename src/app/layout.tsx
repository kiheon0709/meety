import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";
import { BRAND } from "@/lib/brand";
import { getUser } from "@/lib/auth";
import { signOutAction } from "@/lib/actions";
import { listMembersForUser } from "@/lib/service";
import { countUnread } from "@/lib/events";
import { Bell } from "@/components/Bell";
import "./globals.css";

const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: BRAND.description,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getUser();
  const unread = user ? countUnread(listMembersForUser(user.id).map((m) => m.id)) : 0;
  return (
    <html lang="ko" className={`${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
      </head>
      <body className="min-h-full flex flex-col">
        <header className="sticky top-0 z-40 glass hairline-b">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-5 h-12 flex items-center justify-between">
            <Link href={user ? "/home" : "/"} className="flex items-center gap-2 font-semibold tracking-tight group">
              <LogoMark className="h-7 w-7 transition-transform group-hover:-rotate-6" />
              <span className="text-[16px] font-bold">{BRAND.name}</span>
              <span className="hidden sm:inline text-[11px] font-medium text-agent ml-1 px-2 py-0.5 rounded-full bg-[var(--agent-soft)]">{BRAND.tagline}</span>
            </Link>
            <nav className="flex items-center gap-1 text-[13px]">
              {user ? (
                <>
                  <Link href="/home" className="px-3 py-1.5 rounded-full text-ink-2 hover:text-ink hover:bg-black/5 transition">
                    내 프로젝트
                  </Link>
                  <Bell unread={unread} />
                  <span className="hidden sm:inline px-2 text-ink-3">{user.name}</span>
                  <form action={signOutAction}>
                    <button className="px-3 py-1.5 rounded-full text-ink-2 hover:text-ink hover:bg-black/5 transition">로그아웃</button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/#how" className="hidden sm:inline px-3 py-1.5 rounded-full text-ink-2 hover:text-ink hover:bg-black/5 transition">
                    미티가 하는 일
                  </Link>
                  <Link href="/login" className="px-3 py-1.5 rounded-full text-ink-2 hover:text-ink hover:bg-black/5 transition">
                    로그인
                  </Link>
                  <Link href="/signup" className="btn btn-sm btn-dark ml-1">
                    시작하기
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>
        <div className="flex-1">{children}</div>
        <footer className="py-10">
          <div className="mx-auto max-w-[1360px] px-4 sm:px-5 flex items-center justify-between text-[12px] text-ink-3">
            <span className="flex items-center gap-2">
              <LogoMark className="h-4 w-4 opacity-60" /> {BRAND.name}
            </span>
            <span>{BRAND.tagline}</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
