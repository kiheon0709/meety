// 가짜 회의 녹음(voice/fake_meeting.py가 만든 PCM16 wav + .turns.json)의 한 틈에 조용함을 끼워 넣은 판을 만든다.
// 시나리오 A 녹음은 미티 자리 틈이 0.7초뿐이라(사람이 미티 말을 안 기다림) 미티가 말할 틈을 준 A2를 만들 때 쓴다. 원본은 그대로 둔다.
//   npx tsx scripts/widen-gap.ts --src A-meeting --out A2-meeting --after 준영@21.31 --add 3
//   --after 이름@끝시각: 그 말(turns.json에서 끝 시각이 가장 가까운 그 사람 말)과 다음 말 사이 한가운데에 --add초를 끼운다
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) throw new Error(`--${k}가 필요해요 (파일 맨 위 설명)`);
  return argv[i + 1];
};
const DIR = path.resolve("voice/recordings");
const src = opt("src");
const out = opt("out");
const [who, at] = opt("after").split("@");
const add = Number(opt("add"));

type Turn = { speaker: string; t0: number; t1: number; text: string };
const turns = JSON.parse(fs.readFileSync(path.join(DIR, `${src}.turns.json`), "utf8")) as Turn[];
const i = turns.map((t, k) => [k, Math.abs(t.t1 - Number(at))] as const).filter(([k]) => turns[k].speaker === who).sort((a, b) => a[1] - b[1])[0]?.[0];
if (i === undefined || i + 1 >= turns.length) throw new Error(`${who}@${at} 뒤에 다음 말이 없어요`);
const cut = (turns[i].t1 + turns[i + 1].t0) / 2;

const wav = fs.readFileSync(path.join(DIR, `${src}.wav`));
// RIFF 안에서 fmt·data 덩어리를 찾는다 (PCM16만)
let off = 12;
let rate = 0;
let bits = 0;
let ch = 0;
let data: [number, number] | null = null;
while (off + 8 <= wav.length) {
  const id = wav.toString("ascii", off, off + 4);
  const size = wav.readUInt32LE(off + 4);
  if (id === "fmt ") {
    ch = wav.readUInt16LE(off + 10);
    rate = wav.readUInt32LE(off + 12);
    bits = wav.readUInt16LE(off + 22);
  }
  if (id === "data") data = [off + 8, size];
  off += 8 + size + (size & 1);
}
if (!data || bits !== 16) throw new Error("PCM16 wav가 아니에요");
const frame = ch * 2;
const at0 = data[0] + Math.round(cut * rate) * frame;
const pcm = Buffer.concat([wav.subarray(data[0], at0), Buffer.alloc(Math.round(add * rate) * frame), wav.subarray(at0, data[0] + data[1])]);
const h = Buffer.from(wav.subarray(0, 44));
h.write("RIFF", 0);
h.writeUInt32LE(36 + pcm.length, 4);
h.write("WAVEfmt ", 8);
h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20);
h.writeUInt16LE(ch, 22);
h.writeUInt32LE(rate, 24);
h.writeUInt32LE(rate * frame, 28);
h.writeUInt16LE(frame, 32);
h.writeUInt16LE(16, 34);
h.write("data", 36);
h.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(path.join(DIR, `${out}.wav`), Buffer.concat([h, pcm]));
const r2 = (x: number) => Math.round(x * 100) / 100;
const moved = turns.map((t) => (t.t0 >= cut ? { ...t, t0: r2(t.t0 + add), t1: r2(t.t1 + add) } : t));
fs.writeFileSync(path.join(DIR, `${out}.turns.json`), JSON.stringify(moved, null, 1));
console.log(`${src} → ${out}: ${turns[i].speaker} ${turns[i].t1}초 끝 ~ ${turns[i + 1].speaker} ${turns[i + 1].t0}초 사이(${r2(cut)}초)에 ${add}초 → 틈 ${r2(turns[i + 1].t0 - turns[i].t1 + add)}초, 길이 ${r2(pcm.length / frame / rate)}초`);
