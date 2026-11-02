"use client";

import { useEffect, useRef } from "react";

// 뷰포트에 들어오면 .is-in 을 붙인다. 자식 .reveal 요소들도 같이.
export function Reveal({ children, className = "", as: Tag = "div" }: { children: React.ReactNode; className?: string; as?: "div" | "section" | "li" }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const targets = [el, ...Array.from(el.querySelectorAll<HTMLElement>(".reveal"))];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            targets.forEach((t) => t.classList.add("is-in"));
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const T = Tag as any;
  return (
    <T ref={ref} className={`reveal ${className}`}>
      {children}
    </T>
  );
}
