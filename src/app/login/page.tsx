import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { AuthForm } from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp?.next === "string" && sp.next.startsWith("/") ? sp.next : "/home";
  if (await getUser()) redirect(next);
  return (
    <div className="mx-auto max-w-sm px-5 py-16">
      <h1 className="fade-up text-[28px] font-bold tracking-[-0.03em] text-center">다시 오셨네요</h1>
      <p className="fade-up text-[14px] text-ink-2 text-center mt-1 mb-6" style={{ "--i": 1 } as React.CSSProperties}>
        팀의 맥락은 그대로 있어요.
      </p>
      <div className="fade-up" style={{ "--i": 2 } as React.CSSProperties}>
        <AuthForm mode="login" next={next} />
      </div>
    </div>
  );
}
