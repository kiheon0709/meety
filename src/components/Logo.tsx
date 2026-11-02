// 미티 마스코트(둥근 틸 블롭 + 눈 두 개, 포스터 역할 그림과 같은 모양)를 작게. 로고와 "미티가 한 일" 표식에 같이 쓴다.
function Blob({ size, id }: { size: number | string; id: string }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} fill="none" aria-hidden>
      <defs>
        <radialGradient id={id} cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="0.55" stopColor="#2bb5a3" />
          <stop offset="1" stopColor="#119184" />
        </radialGradient>
      </defs>
      <path d="M20 4.5c8.6 0 15 6.9 15 15.6 0 8.4-6.8 14.4-15 14.4S5 28.5 5 20.1C5 11.4 11.4 4.5 20 4.5z" fill={`url(#${id})`} />
      <ellipse cx="15.6" cy="21" rx="2.1" ry="2.9" fill="#14142b" />
      <ellipse cx="24.4" cy="21" rx="2.1" ry="2.9" fill="#14142b" />
      <circle cx="16.3" cy="19.9" r="0.75" fill="#fff" />
      <circle cx="25.1" cy="19.9" r="0.75" fill="#fff" />
    </svg>
  );
}

export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center ${className}`}>
      <Blob size="100%" id="mt-logo" />
    </span>
  );
}

// 미티 표식: 미티가 한 일 옆에 붙는다. 사람 아바타(이니셜)와 한눈에 구분된다.
export function AgentMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${className}`} style={{ width: size, height: size }} aria-label="미티">
      <Blob size={size} id={`mt-${size}`} />
    </span>
  );
}
