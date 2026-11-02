// 평가용 녹취 생성: 예시 3회의 노이즈 버전(오탈자·화자 뒤섞임·추임새)과 1시간짜리 긴 녹취(회의 1을 약 400마디로 늘림).
//   npx tsx scripts/make-noise.ts   → eval/noisy-01..03.md, eval/long-01.md
import fs from "node:fs";
import path from "node:path";

// 고정 시드 난수 (재현 가능)
let seed = 20261025;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

const SRC = path.join(process.cwd(), "data", "transcripts");
const OUT = path.join(process.cwd(), "eval");
fs.mkdirSync(OUT, { recursive: true });

function parse(file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  const lines = m[2].split("\n").filter((l) => l.trim());
  const utts = lines.map((l) => {
    const mm = l.match(/^([^:]{1,10}):\s*(.*)$/)!;
    return { speaker: mm[1].trim(), text: mm[2].trim() };
  });
  return { front: m[1], utts };
}

const isHangul = (ch: string) => ch >= "가" && ch <= "힣";
const FILLERS = ["음", "네네", "아 그렇죠", "잠깐만요", "어 그러니까", "그 뭐지", "맞아요 맞아요", "아 잠시만", "응 응"];
const STT_SUBS: [string, string][] = [["클로바노트", "클로버 노트"], ["깃허브", "기트 허브"], ["디스코드", "디스 코드"], ["회의록", "회의 록"], ["맥락", "매락"], ["녹취", "녹치"], ["전사", "전사"], ["서비스", "써비스"], ["발표", "발포"], ["결정", "겨정"]];

// 오탈자 5% (STT가 흔히 틀리는 단어 치환 + 음절 흔들기), 화자 10% 뒤섞음, 15% 추임새 삽입
function noisy(utts: { speaker: string; text: string }[]) {
  const speakers = [...new Set(utts.map((u) => u.speaker))];
  const out: { speaker: string; text: string }[] = [];
  for (const u of utts) {
    let text = u.text;
    for (const [a, b] of STT_SUBS) if (text.includes(a) && rnd() < 0.5) text = text.replace(a, b);
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      if (!isHangul(chars[i]) || rnd() > 0.05) continue;
      const code = chars[i].charCodeAt(0) - 0xac00;
      const cho = Math.floor(code / 588);
      const jung = Math.floor((code % 588) / 28);
      // 받침만 바꾸거나(ㅇ↔ㄴ 등) 모음을 비슷한 걸로
      const jong = Math.floor(rnd() * 28);
      chars[i] = String.fromCharCode(0xac00 + cho * 588 + jung * 28 + jong);
    }
    text = chars.join("");
    if (rnd() < 0.2) text = `${pick(FILLERS)} ${text}`;
    const speaker = rnd() < 0.1 ? pick(speakers.filter((s) => s !== u.speaker)) : u.speaker;
    if (rnd() < 0.15) out.push({ speaker: pick(speakers), text: pick(FILLERS) });
    out.push({ speaker, text });
  }
  return out;
}

const CHATTER = [
  "잠깐 화면 공유할게요.", "아 마이크 꺼져 있었네요.", "커피 사 올 사람?", "다음 수업이 세 시라 그 전엔 끝내야 해요.", "그거 노션에 적어 놨어요.", "잠시만요, 카톡 하나만 보고요.", "화면 보이세요?", "네 잘 보여요.", "어제 밤새서 좀 멍해요.", "그 얘기는 이따 하고요.",
  "자료는 디스코드에 올려 둘게요.", "교수님이 지난주에 뭐라고 하셨죠?", "그건 평가 기준에 있었어요.", "회의 끝나고 밥 먹을까요?", "녹음 돌아가고 있죠?", "네 돌아가요.", "아까 어디까지 했죠?", "다시 돌아가서요.", "그 부분은 제가 적어 둘게요.", "질문 있어요.",
  "아 그렇구나.", "오케이.", "그렇게 가죠.", "일단 넘어가요.", "이건 나중에 다시 얘기해요.", "정리하면요.", "한 번 더 말해 줄래요?", "소리가 끊겼어요.", "다시요.", "넵.",
];

// 회의 1을 약 400마디로: 문장을 하나씩 떼고, 사이사이에 잡담을 끼운다. 결정은 그대로라 기대 결과도 같다.
function long(utts: { speaker: string; text: string }[], target = 400) {
  const speakers = [...new Set(utts.map((u) => u.speaker))];
  const base: { speaker: string; text: string }[] = [];
  for (const u of utts) {
    const sents = u.text.split(/(?<=[.?!])\s+/).filter(Boolean);
    for (const s of sents) base.push({ speaker: u.speaker, text: s });
  }
  const need = Math.max(0, target - base.length);
  const per = need / base.length;
  const out: { speaker: string; text: string }[] = [];
  let acc = 0;
  for (const b of base) {
    out.push(b);
    acc += per;
    while (acc >= 1) {
      out.push({ speaker: pick(speakers), text: pick(CHATTER) });
      acc -= 1;
    }
  }
  return out;
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".md")).sort();
files.forEach((f, i) => {
  const { front, utts } = parse(path.join(SRC, f));
  const n = noisy(utts);
  fs.writeFileSync(path.join(OUT, `noisy-0${i + 1}.md`), `---\n${front}\n---\n${n.map((u) => `${u.speaker}: ${u.text}`).join("\n")}\n`);
  console.log(`noisy-0${i + 1}.md: ${utts.length} → ${n.length}마디`);
});
{
  const { front, utts } = parse(path.join(SRC, files[0]));
  const l = long(utts);
  fs.writeFileSync(path.join(OUT, "long-01.md"), `---\n${front.replace(/title: .*/, "title: 회의 1 (긴 버전) — 주제 정하기")}\n---\n${l.map((u) => `${u.speaker}: ${u.text}`).join("\n")}\n`);
  console.log(`long-01.md: ${utts.length} → ${l.length}마디`);
}
