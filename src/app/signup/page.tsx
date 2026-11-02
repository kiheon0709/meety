import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { AuthForm } from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const sp = await searchParams;
  const next = typeof sp?.next === "string" && sp.next.startsWith("/") ? sp.next : "/home";
  if (await getUser()) redirect(next);
  return (
    <div className="mx-auto max-w-sm px-5 py-16">
      <h1 className="fade-up text-[28px] font-bold tracking-[-0.03em] text-center">팀의 서기를 만드세요</h1>
      <p className="fade-up text-[14px] text-ink-2 text-center mt-1 mb-6" style={{ "--i": 1 } as React.CSSProperties}>
        무료예요. 카드 필요 없어요.
      </p>
      <div className="fade-up" style={{ "--i": 2 } as React.CSSProperties}>
        <AuthForm mode="signup" next={next} />
      </div>
    </div>
  );
}
