"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signInAction, signUpAction } from "@/lib/actions";
import { Spinner } from "./SubmitButton";

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next: string }) {
  const action = mode === "login" ? signInAction : signUpAction;
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="card p-7 space-y-4">
      <input type="hidden" name="next" value={next} />
      {mode === "signup" && (
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">이름</span>
          <input name="name" className="input mt-1" placeholder="팀원들이 부르는 이름" required autoComplete="name" />
        </label>
      )}
      <label className="block">
        <span className="text-[12px] font-medium text-ink-2">이메일</span>
        <input name="email" type="email" className="input mt-1" placeholder="you@example.com" required autoComplete="email" />
      </label>
      <label className="block">
        <span className="text-[12px] font-medium text-ink-2">비밀번호</span>
        <input name="password" type="password" className="input mt-1" placeholder={mode === "signup" ? "6자 이상" : ""} required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
      </label>
      {state?.error && <p className="text-[13px] text-red">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn btn-lg btn-primary w-full">
        {pending && <Spinner />}
        {mode === "login" ? "로그인" : "시작하기"}
      </button>
      <p className="text-[13px] text-ink-3 text-center">
        {mode === "login" ? (
          <>
            처음이세요?{" "}
            <Link href={`/signup?next=${encodeURIComponent(next)}`} className="text-blue hover:underline underline-offset-4">
              가입하기
            </Link>
          </>
        ) : (
          <>
            이미 계정이 있어요?{" "}
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-blue hover:underline underline-offset-4">
              로그인
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
