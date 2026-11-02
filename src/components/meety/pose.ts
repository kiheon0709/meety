// 다섯 상태 → 캐릭터 목표값. 판단은 리듀서(meetyMode), 모양은 여기 상수. 매 프레임 approach로 따라가서 이벤트 순서가 뒤섞여도 튀지 않는다
import type { MeetyMode } from "@/components/live/state";

export interface Pose {
  lean: number; // 상체 앞으로 (0~1 → 0~5°)
  tilt: number; // 고개 기울기 (0~1 → 0~3°)
  hand: number; // 손 들기 (0~1)
  eyes: number; // 눈 크게 (0~1, 놀람)
  sad: number; // 조심·물러남 (0~1)
  glow: number; // 둘레 빛 (0~1)
  still: number; // 움직임 멈춤 (1이면 숨쉬기·흔들림 거의 없음)
  shrink: number; // 움츠림 (끊겼을 때 몸이 작아지고 납작해짐)
  look: number; // 눈동자 위아래 (+ 위 · - 아래). 0이면 정면 = 눈 맞춤
  // 팔: 평소엔 몸에 숨어 있다가 필요할 때 나온다 (hand = 한쪽 팔을 들어 올림)
  peek: number; // 팔이 몸 밖으로 나온 정도
  shy: number; // 두 팔을 얼굴 앞으로 모아 가림 (끊겼을 때)
  // 표정은 눈으로만
  joy: number; // 눈이 위아래로 조금 납작해짐 (기쁨·눈웃음)
  curious: number; // 한쪽 눈이 커지고 고개 갸웃 (궁금)
  sorry: number; // 눈이 바깥쪽으로 처져 기울고 조금 작아짐 (미안)
  think: number; // 생각 중 (두뇌 draft): 눈이 옆·위로, 숨이 조금 빨라짐 — 손·소리·카드 아님
}

const BASE: Pose = { lean: 0, tilt: 0, hand: 0, eyes: 0, sad: 0, glow: 0.25, still: 0, shrink: 0, look: 0, peek: 0, shy: 0, joy: 0, curious: 0, sorry: 0, think: 0 };
const BY_MODE: Record<MeetyMode, Partial<Pose>> = {
  listening: {},
  // 팔은 손 들기·끊김(가림)에서만 나온다. 반쯤 나온 팔은 몸 가장자리 혹으로 보여서(기헌 1:1 시험) 할 말 있음·말하는 중엔 안 쓴다
  has_something: { lean: 1, eyes: 1, glow: 0.7, still: 0.8, curious: 1 }, // 눈이 커지고(한쪽 더) 몸이 앞으로
  hand_raised: { hand: 1, peek: 1, eyes: 0.4, glow: 0.6, look: 0.5, joy: 0.3 }, // 한쪽 팔이 쑥 나와 올라가고 그 손 쪽을 봄
  speaking: { glow: 1, joy: 0.35 }, // 눈웃음
  cut: { sad: 0.6, tilt: -0.4, glow: 0, shrink: 1, look: -0.6, peek: 1, shy: 1, sorry: 1 }, // 팔로 가리듯 움츠리고 미안한 눈
};

export function targetOf(mode: MeetyMode, talking: boolean, thinking = false): Pose {
  const p = { ...BASE, ...BY_MODE[mode] };
  if (mode === "listening" && talking) p.tilt = 1; // 사람이 말하면 그쪽으로 고개를 기울인다
  if (mode === "listening" && thinking) Object.assign(p, { think: 1, look: 0.4 }); // 다른 상태가 이기면 생각 중은 안 보인다
  return p;
}

// cur를 target으로 τ초 시상수로 따라간다 (프레임 수와 상관없이 같은 속도)
export const approach = (cur: number, target: number, dt: number, tau = 0.12) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

// 깜빡임: 시작부터 0.16초 동안 0→1→0 (부드럽게 감았다 뜸)
export const BLINK_S = 0.16;
export function blinkAt(t: number, start: number) {
  const d = t - start;
  return d < 0 || d >= BLINK_S ? 0 : Math.sin((Math.PI * d) / BLINK_S);
}

// 상태가 바뀐 뒤 d초: 젤리처럼 늘었다 줄었다 하다 멎는다 (몸 늘어남에 더한다)
export function jiggle(d: number) {
  return d <= 0 ? 0 : 0.08 * Math.exp(-d / 0.18) * Math.sin(d * 22);
}

// 능동형 미티의 작은 반응 (d = 그 일이 생긴 뒤 초). 상태(mode)와 따로 몸·눈에 더한다
// 뭔가 떠올림(think): 0.5초 동안 살짝 뛰고, 눈은 위로 갔다가 1초 뒤부터 천천히 제자리
export function ideaFx(d: number) {
  if (d < 0) return { hop: 0, up: 0 };
  return { hop: d < 0.5 ? 0.05 * Math.sin((Math.PI * d) / 0.5) : 0, up: d < 1 ? 1 : Math.exp(-(d - 1) / 0.3) };
}
// 맞장구: 0.5초에 한 번 고개 끄덕임 (아래로 갔다 올라옴) — 0~1
export const NOD_S = 0.5;
export const nodFx = (d: number) => (d < 0 || d >= NOD_S ? 0 : Math.sin((Math.PI * d) / NOD_S));
// 찾아보는 중(research): 눈이 왼쪽·오른쪽으로 천천히 훑는다 — -1~1
export const scanFx = (t: number) => Math.sin(t * 2.4);

// 눈·반짝임 크기 (Avatar3D). 반짝임은 눈 크기의 1/4쯤, 눈 오른쪽 위
export const EYE_R = { x: 0.095, y: 0.165 }; // 눈(타원) 반지름
export const SHINE_R = 0.04;
export const SHINE = { x: 0.034, y: 0.068, z: 0.046 }; // 눈 오른쪽 위, 눈 표면 바로 위
// 반짝임 중심을 (눈 반지름 - 반짝임 반지름 - 여유) 타원 안으로 당긴다 → 반짝임이 눈 밖으로 안 나감
export function insideEye(x: number, y: number): [number, number] {
  const ax = EYE_R.x - SHINE_R - 0.008;
  const ay = EYE_R.y - SHINE_R - 0.008;
  const r = Math.hypot(x / ax, y / ay);
  return r <= 1 ? [x, y] : [x / r, y / r];
}
