"use client";

import { useState, useSyncExternalStore } from "react";

// 상대 경로를 받아 현재 origin을 붙여 보여주고 복사한다.
export function CopyField({ value, className = "" }: { value: string; className?: string }) {
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const full = value.startsWith("/") ? `${origin}${value}` : value;
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex gap-2 ${className}`}>
      <input readOnly value={full} className="input font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn btn-md btn-dark shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(full);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* 수동 복사 */
          }
        }}
      >
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}
