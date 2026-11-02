"use client";
// 미티 3D 캐릭터: 이 파일의 절차적 마스코트(모델 파일 없음, 라이선스 걱정 없음).
// 매 프레임: 상태 목표값(pose.ts)을 따라가고, 입은 TTS 크기(levels.ts) × 한글 모음(vowels.ts). React 리렌더 없이 ref로만 움직인다
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { MeetyMode } from "@/components/live/state";
import { level } from "./levels";
import { heldOn } from "@/components/live/state";
import { EYE_R, SHINE, SHINE_R, approach, blinkAt, ideaFx, insideEye, jiggle, nodFx, scanFx, targetOf, type Pose } from "./pose";
import { mouthAt, type Mouth } from "./vowels";

export interface AvatarProps {
  mode: MeetyMode;
  talking: boolean;
  thinking?: boolean; // 두뇌가 말 끝나기 전에 미리 생각 중 (draft thinking) — 아주 작게만
  ideaKey?: number; // 바뀌면 "뭔가 떠올림" (think): 눈 위로·살짝 뜀
  searching?: boolean; // 찾아보는 중 (think research): 눈이 옆으로 훑음
  nodKey?: number; // 바뀌면 고개 끄덕임 (맞장구)
  sentence?: string; // 지금 읽는 문장 (입 모양 힌트)
  sentenceKey?: string; // 문장이 바뀌면 바뀌는 값 (actionId:index)
  mock?: boolean; // 목업: 소리가 없으니 입을 글자로만 움직인다
  reduced?: boolean; // 움직임 줄이기: 정지 프레임만
  onSlow?: (fps: number) => void; // 처음 3초 평균 fps가 낮으면
  onLost?: (lost: boolean) => void; // WebGL 문맥을 잃음/되찾음 (GPU 리셋·잠자기 뒤·화면 캡처) → 그동안 2D로
}

// fx: 상태가 바뀐 뒤 젤리 출렁임(jiggle), 마우스 쪽 시선(px·py, -1~1), 떠올림(hop·up), 끄덕임(nod 0~1), 훑기(scan -1~1)
type Fx = { jiggle: number; px: number; py: number; hop: number; up: number; nod: number; scan: number };
const NO_FX: Fx = { jiggle: 0, px: 0, py: 0, hop: 0, up: 0, nod: 0, scan: 0 };
// 리그: 매 프레임 자세·입 모양·깜빡임·시각·마이크 크기를 받는다
interface Rig {
  apply(p: Pose, mouth: Mouth, blink: number, t: number, mic: number, fx: Fx): void;
}

const VOWELS = ["aa", "ih", "ou", "ee", "oh"] as const;
const CHAR_S = 0.115; // 소리 길이를 모를 때 글자당 초 (client.ts 자막 폴백과 같게)

function Driver({ props, rig }: { props: AvatarProps; rig: React.RefObject<Rig | null> }) {
  const cur = useRef<Pose>(targetOf("listening", false));
  const since = useRef({ key: "", at: 0 });
  const blink = useRef({ next: 2, start: -1 });
  const changed = useRef({ mode: props.mode, at: -1 });
  const thinkAt = useRef<number | null>(null);
  const idea = useRef({ key: props.ideaKey, at: -9 }); // 마지막으로 떠올린 때
  const nod = useRef({ key: props.nodKey, at: -9 }); // 마지막으로 끄덕인 때 // 생각 중이 마지막으로 켜진 때 (최소 0.6초는 보여 깜빡이지 않게)
  const fps = useRef({ frames: 0, t: 0, done: false });
  const { invalidate } = useThree();
  useEffect(() => {
    if (props.reduced) invalidate();
  }, [props.mode, props.talking, props.reduced, invalidate]);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    if (!fps.current.done && !props.reduced) {
      fps.current.frames++;
      fps.current.t += dt;
      if (fps.current.t >= 3) {
        fps.current.done = true;
        props.onSlow?.(fps.current.frames / fps.current.t);
      }
    }
    const step = props.reduced ? 10 : Math.min(dt, 0.1); // 움직임 줄이기면 목표로 바로
    // 켜진 때를 적어 두고, 꺼져도 켜진 지 0.6초가 안 됐으면 계속 보인다
    if (props.thinking && thinkAt.current === null) thinkAt.current = t;
    const thinking = heldOn(!!props.thinking, thinkAt.current === null ? null : thinkAt.current * 1000, t * 1000);
    if (!thinking) thinkAt.current = null;
    const target = targetOf(props.mode, props.talking, thinking);
    const p = cur.current;
    for (const k of Object.keys(target) as (keyof Pose)[]) p[k] = approach(p[k], target[k], step);

    // 입: 말하는 중일 때만. 실제는 TTS 크기, 목업은 글자 리듬으로 흉내
    let mouth: Mouth = {};
    if (props.mode === "speaking" && props.sentence && !props.reduced) {
      if (since.current.key !== props.sentenceKey) since.current = { key: props.sentenceKey ?? "", at: t };
      const el = t - since.current.at;
      const vowel = mouthAt(props.sentence, props.sentence.length * CHAR_S, el);
      const amp = props.mock ? (Object.keys(vowel).length ? 0.55 + 0.45 * Math.abs(Math.sin(el * 11)) : 0) : level("tts");
      mouth = Object.fromEntries(VOWELS.map((v) => [v, (vowel[v] ?? (amp > 0.05 ? 0.3 : 0)) * amp])) as Mouth;
    }
    // 깜빡임: 3~6초마다 부드럽게, 열에 셋은 두 번 연달아. 말하는 중엔 3~5초마다 한 번씩만
    let b = 0;
    if (!props.reduced) {
      if (t > blink.current.next) {
        const talking = props.mode === "speaking";
        const twice = !talking && Math.random() < 0.3;
        blink.current = { start: t, next: t + (twice ? 0.24 : talking ? 3 + Math.random() * 2 : 3 + Math.random() * 3) };
      }
      b = blinkAt(t, blink.current.start);
    }
    if (changed.current.mode !== props.mode) changed.current = { mode: props.mode, at: t };
    if (idea.current.key !== props.ideaKey) idea.current = { key: props.ideaKey, at: t };
    if (nod.current.key !== props.nodKey) nod.current = { key: props.nodKey, at: t };
    const fx: Fx = props.reduced
      ? NO_FX
      : { jiggle: jiggle(t - changed.current.at), px: state.pointer.x, py: state.pointer.y, ...ideaFx(t - idea.current.at), nod: nodFx(t - nod.current.at), scan: props.searching ? scanFx(t) : 0 };
    rig.current?.apply(p, mouth, b, props.reduced ? 0 : t, props.reduced ? 0 : level("mic"), fx);
  });
  return null;
}

// ── 절차적 마스코트: 무광 점토 질감의 틸색 블롭 한 덩어리 + 세로로 긴 검은 타원 눈 둘 + 바닥 그림자 ─────────
// 기헌 결정(10/30 밤): 피클(pickle.com) 캐릭터의 어법 — 둥글고 살짝 비대칭인 파스텔 단색 덩어리, 눈만, 입·팔 없음.
// 다섯 상태는 눈 크기·기울기·몸의 눌림/늘어남·둘레 빛으로:
//   듣는 중 = 눈 맞춤·숨쉬기, 할 말 있음 = 눈 커지고 위로 늘어나 앞으로 기욺·멈춤, 손 들었음 = 길게 늘어나 옆으로 기울고 통통 튐,
//   말하는 중 = 말소리 크기만큼 눌렸다 늘어남, 끊김 = 납작하게 눌리고 눈이 가늘어지며 시선 아래
const TEAL = "#14B8A6";

// 구를 콩·검드롭 모양으로: 아래가 넓고 납작, 위는 둥글게, 살짝 한쪽으로 쏠림
function blobGeometry() {
  const g = new THREE.SphereGeometry(1, 96, 64);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const y = v.y;
    const wide = 1 + 0.14 * Math.max(0, -y) - 0.1 * Math.max(0, y); // 아래 넓게, 위 좁게 (검드롭)
    v.x *= wide;
    v.z *= wide * 0.9;
    v.x += 0.07 * Math.max(0, y) ** 2 + 0.03 * Math.sin(2.3 * y + 0.6); // 위가 살짝 오른쪽으로, 옆선이 고르지 않게
    // 바닥은 부드럽게 눌러 앉힌다 (각진 턱이 생기지 않게 아래로 갈수록 점점 더 눌림)
    v.y = y < 0 ? y * (1 - 0.18 * -y) : y * 1.02; // 떠 있으니 바닥은 조금만 눌러 달걀처럼
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// 바닥의 부드러운 그림자 / 둘레 빛: 가운데가 진하고 바깥으로 사라지는 원
function radialTexture(inner: string, outer: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BOTTOM = -0.82; // 몸(달걀꼴) 맨 아래 — 그림자는 여기, 몸은 lift만큼 떠 있다
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const EYE_X = 0.2;
const ARM_X = 0.9;
function Mascot({ onRig }: { onRig: (r: Rig | null) => void }) {
  const body = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Group[]>([]);
  const shines = useRef<THREE.Mesh[]>([]);
  const arms = useRef<THREE.Group[]>([]); // 0: 왼쪽(화면 왼쪽), 1: 오른쪽 — 손 드는 팔
  const shadow = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const res = useMemo(() => {
    const shadowTex = radialTexture("rgba(15,60,55,0.42)", "rgba(15,60,55,0)");
    const haloTex = radialTexture("rgba(94,234,212,0.55)", "rgba(94,234,212,0)");
    return {
      geo: blobGeometry(),
      // 점토 질감: 거친 무광 + 보드라운 sheen(가장자리에 옅은 빛) + 아주 약한 자체 발광(속이 비치는 느낌)
      skin: new THREE.MeshPhysicalMaterial({ color: TEAL, roughness: 0.82, metalness: 0, sheen: 0.7, sheenColor: new THREE.Color("#ccfbf1"), sheenRoughness: 0.6, emissive: TEAL, emissiveIntensity: 0.06 }),
      // 표정은 눈 모양(세로 크기·기울기)으로만 — 잘라 내면 눈 아래가 평평하거나 들쭉날쭉하게 잘려 보였다(기헌 1:1 시험)
      eye: new THREE.MeshStandardMaterial({ color: "#13244a", roughness: 0.22 }), // 네이비
      shine: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
      shadowTex,
      haloTex,
      shadow: new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
      halo: new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.4, depthWrite: false }),
    };
  }, []);
  useEffect(
    () => () => {
      res.geo.dispose();
      for (const k of ["skin", "eye", "shine", "shadow", "halo", "shadowTex", "haloTex"] as const) res[k].dispose();
    },
    [res],
  );

  useEffect(() => {
    // 눈의 작은 떨림(사케이드): 1~3초마다 조금씩 옮겨 "살아 있는" 눈 맞춤
    let sac = { x: 0, y: 0, next: 0 };
    // 말소리 크기는 그대로 쓰면 0.1초마다 튄다 → 몸은 짧게, 눈은 길게 고르게 (지수 평활)
    const soft = { t: 0, body: 0, eye: 0 };
    onRig({
      apply(p, m, blink, t, mic, fx) {
        const g = body.current;
        if (!g) return;
        const raw = Math.min(1, (m.aa ?? 0) + (m.oh ?? 0) + (m.ou ?? 0) + (m.ee ?? 0) * 0.6 + (m.ih ?? 0) * 0.4);
        const dt = Math.min(0.1, Math.max(0, t - soft.t));
        soft.t = t;
        soft.body = approach(soft.body, raw, dt, 0.08);
        soft.eye = approach(soft.eye, raw, dt, 0.18);
        const amp = soft.body;
        // 바닥에서 살짝 떠서 숨쉬듯 천천히 오르내림 (끊기면 내려앉음)
        const lift = (0.17 + (1 - p.still) * Math.sin(t * 1.3) * 0.035) * (1 - p.shrink * 0.6) + fx.hop - fx.nod * 0.03;
        const breathe = (1 - p.still) * Math.sin(t * 1.6) * 0.012 + p.think * Math.sin(t * 3.4) * 0.01; // 생각 중엔 숨이 조금 빨라짐
        // 늘어남(+)·눌림(-): 할 말 있음·손 들었음은 위로, 말소리는 들썩, 끊김은 납작
        const stretch = breathe + p.eyes * 0.05 + p.hand * 0.05 + amp * 0.06 - p.shrink * 0.12 + fx.jiggle - fx.nod * 0.05;
        g.scale.set(1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);
        g.position.y = BOTTOM + lift;
        g.rotation.x = (p.lean * 7 + p.sad * 5 + fx.nod * 6) * (Math.PI / 180); // 끄덕임: 앞으로 숙였다 듦
        // 듣는 동안 천천히 좌우로 흔들흔들, 궁금하면 갸웃, 손 들면 반대쪽으로 살짝
        const sway = (1 - p.still) * (1 - p.hand) * Math.sin(t * 0.9) * 1.5;
        g.rotation.z = (p.tilt * 4 + sway + p.curious * 6 + mic * 1.5 * Math.sin(t * 9) + p.hand * 5) * (Math.PI / 180);

        if (t > sac.next) sac = { x: (Math.random() - 0.5) * 0.03, y: (Math.random() - 0.5) * 0.02, next: t + 1 + Math.random() * 2 };
        // 눈: 크고, 표정은 눈 모양으로만 — 기쁨(위아래로 조금 납작)·궁금(한쪽 눈이 큼)·미안(바깥쪽으로 처져 기욺)
        const open = Math.max(0.08, 1 - Math.max(blink, p.sad * 0.3));
        const big = 1 + p.eyes * 0.25 + soft.eye * 0.05; // 말소리로는 ±5% 안에서만
        const flat = 1 - 0.28 * p.joy - 0.15 * p.sorry;
        const follow = 1 - p.still;
        for (const [i, e] of eyes.current.entries()) {
          if (!e) continue;
          const side = i === 0 ? -1 : 1;
          const cur = 1 + (side < 0 ? 0.22 : -0.04) * p.curious;
          e.scale.set(big * cur, big * cur * open * flat, big * cur);
          e.rotation.z = side * 0.35 * p.sorry; // 미안: 바깥 끝이 낮게
          const dy = p.look * 0.06 + (sac.y + fx.py * 0.025) * follow + fx.up * 0.045 + Math.abs(fx.scan) * 0.012;
          const dx = (sac.x + fx.px * 0.035 + p.hand * 0.03) * follow + p.think * 0.04 + fx.scan * 0.05; // 생각 중: 눈이 옆(·위)으로, 찾는 중: 좌우로 훑음
          e.position.y = 0.06 + dy;
          e.position.x = side * EYE_X + dx;
          // 흰 반짝임: 눈이 움직여도 빛 쪽(오른쪽 위)에 머물게 반쯤 거꾸로 옮기고, 눈 안에 가둔다. 감을 땐 사라진다
          const sh = shines.current[i];
          if (sh) {
            const [x, y] = insideEye(SHINE.x - dx * 0.6, SHINE.y - dy * 0.6);
            sh.position.set(x, y, SHINE.z);
            sh.visible = open > 0.45;
          }
        }
        // 팔: 평소엔 몸 안에 숨어 있다가(크기 0) 나온다. 오른팔이 손 드는 팔
        for (const [i, a] of arms.current.entries()) {
          if (!a) continue;
          const side = i === 0 ? -1 : 1;
          const out = Math.max(p.peek, i === 1 ? p.hand : 0, p.shy);
          a.visible = out > 0.25; // 조금만 나온 팔은 몸 가장자리 혹으로 보인다 — 충분히 나왔을 때만
          const reach = i === 1 ? 1 + 0.45 * p.hand : 1; // 손 드는 팔은 쭉 뻗는다
          a.scale.set(Math.max(0.001, out), Math.max(0.001, out * reach), Math.max(0.001, out));
          // 어깨 자리(조금 나올수록 몸 밖으로) → 끊기면 얼굴 앞(입 가리듯)으로
          a.position.set(lerp(side * ARM_X * (0.93 + 0.07 * out), side * 0.3, p.shy), lerp(-0.05, -0.2, p.shy), lerp(0.22, 0.86, p.shy));
          const bob = p.peek * (1 - p.hand) * (1 - p.shy) * Math.sin(t * 6 + i) * 0.18; // 할 말 있음: 들썩
          const gesture = amp * Math.sin(t * 5 + i * 1.7) * 0.35; // 말하는 중: 작게 제스처
          const raise = i === 1 ? p.hand * (2.5 + Math.sin(t * 3) * 0.1) : 0; // 손 들기 (살짝 흔듦)
          const rest = side * 0.3; // 몸 옆으로 살짝 벌어져 늘어진 팔
          a.rotation.z = lerp(rest + side * (raise + bob + gesture), side * 2.75, p.shy);
        }
        if (shadow.current) {
          // 떠 있을수록 그림자가 작고 옅다
          const s = 0.78 - (lift - 0.17) * 1.6 + p.shrink * 0.12;
          shadow.current.scale.set(s, s, 1);
          (shadow.current.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.75 - (lift - 0.17) * 2.5 + p.shrink * 0.2);
        }
        if (halo.current) {
          (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.05 + p.glow * 0.5 + amp * 0.15;
          const s = 1 + p.glow * 0.05 * Math.sin(t * 2.4);
          halo.current.scale.set(s, s, 1);
        }
      },
    });
    return () => onRig(null);
  }, [onRig, res]);

  return (
    <group position={[0, -0.05, 0]}>
      <mesh ref={halo} position={[0, 0.2, -1]} material={res.halo}>
        <planeGeometry args={[3.6, 3.6]} />
      </mesh>
      <mesh ref={shadow} position={[0, BOTTOM - 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={res.shadow}>
        <planeGeometry args={[2.6, 2.2]} />
      </mesh>
      {/* 원점을 몸 바닥에 두고 위로 — 늘어나고 눌릴 때 바닥 쪽이 기준 */}
      <group ref={body} position={[0, BOTTOM, 0]}>
        <group position={[0, -BOTTOM, 0]}>
          <mesh geometry={res.geo} material={res.skin} />
          {[0, 1].map((i) => (
            <group key={i} ref={(g) => void (g && (eyes.current[i] = g))} position={[(i ? 1 : -1) * EYE_X, 0.06, 0.885]}>
              <mesh material={res.eye} scale={[EYE_R.x, EYE_R.y, 0.055]}>
                <sphereGeometry args={[1, 28, 20]} />
              </mesh>
              {/* 흰 반짝임: 눈 크기의 1/4쯤 (피클 캐릭터처럼 검은 눈 오른쪽 위에 작은 흰 원) */}
              <mesh ref={(m) => void (m && (shines.current[i] = m))} material={res.shine} position={[SHINE.x, SHINE.y, SHINE.z]} scale={[1, 1, 0.3]}>
                <sphereGeometry args={[SHINE_R, 20, 12]} />
              </mesh>
            </group>
          ))}
          {[0, 1].map((i) => (
            <group key={i} ref={(g) => void (g && (arms.current[i] = g))} position={[(i ? 1 : -1) * ARM_X, -0.05, 0.22]} visible={false}>
              <mesh position={[0, -0.24, 0]} material={res.skin}>
                <capsuleGeometry args={[0.115, 0.22, 8, 16]} />
              </mesh>
            </group>
          ))}
        </group>
      </group>
    </group>
  );
}

export default function Avatar3D(props: AvatarProps) {
  const rig = useRef<Rig | null>(null);
  const onRig = useCallback((r: Rig | null) => {
    rig.current = r;
  }, []);
  return (
    <Canvas
      aria-hidden
      dpr={[1, 1.5]}
      frameloop={props.reduced ? "demand" : "always"}
      shadows={false}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: true }}
      camera={{ position: [0, 1.1, 5.4], fov: 32 }}
      onCreated={({ gl, camera }) => {
        camera.lookAt(0, -0.15, 0); // 살짝 내려다봐서 바닥 그림자가 몸을 받치게
        const c = gl.domElement;
        c.addEventListener("webglcontextlost", () => props.onLost?.(true));
        c.addEventListener("webglcontextrestored", () => props.onLost?.(false));
      }}
    >
      <hemisphereLight args={["#ffffff", "#d9d4ff", 1.1]} />
      <directionalLight position={[2, 3, 4]} intensity={1.6} />
      <Mascot onRig={onRig} />
      <Driver props={props} rig={rig} />
    </Canvas>
  );
}
