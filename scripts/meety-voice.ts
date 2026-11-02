// 대비용 미티 대사를 미티 목소리(후보 6: Qwen3 Sohee 1.2배, 온도 0.5·top_k 20·씨앗 7)로 문장마다 wav로 만든다.
// 목소리 작업자(S2 voice/tts_worker.py, 앱이 쓰는 것과 같은 것)를 따로 띄워 두고 그 /stream을 부른다 — 앱 목소리와 같은 소리.
//
//   voice/cache/venvs/mlx/bin/python voice/tts_worker.py 8797      (먼저)
//   npx tsx scripts/meety-voice.ts docs/presentation/video/scenarios/meety-lines.json --out docs/presentation/video/scenarios/voice [--worker 8797]
//
// meety-lines.json: [{ "id": "s1-1", "text": "…", "say"?: "소리용 글(영어 이름·기호를 읽기 좋게, 없으면 text)" }, …] — 대사가 여러 문장이면 문장마다 s1-1.1.wav, s1-1.2.wav…와 이어 붙인 s1-1.wav를 같이 남긴다.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SR = 24000;
const GAP = 0.25; // 문장 사이 쉼(초) — 앱의 문장 사이 빈틈(실측 20~50ms)보다 조금 길게, 들을 때 자연스럽게

function wav(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
// 문장으로 나눈다: . ? ! 뒤에 띄어쓰기나 끝이 올 때만 ("2.3%" 같은 소수점은 안 나눔)
const sentences = (t: string) => t.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);

async function main() {
  const file = argv[0];
  const out = opt("out", "voice-out");
  const base = `http://127.0.0.1:${opt("worker", "8797")}`;
  const health = await (await fetch(`${base}/health`)).json();
  console.log(`목소리: ${health.voice}`);
  fs.mkdirSync(out, { recursive: true });
  const lines = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; text: string; say?: string }[];
  const list: { id: string; file: string; text: string; say?: string; sec: number }[] = [];
  for (const l of lines) {
    const parts = sentences(l.say ?? l.text);
    const pcms: Buffer[] = [];
    for (const [k, s] of parts.entries()) {
      const r = await fetch(`${base}/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: s }) });
      const pcm = Buffer.from(await r.arrayBuffer());
      pcms.push(pcm);
      if (parts.length > 1) {
        const f = `${l.id}.${k + 1}.wav`;
        fs.writeFileSync(path.join(out, f), wav(pcm));
        list.push({ id: `${l.id}.${k + 1}`, file: f, text: s, sec: pcm.length / 2 / SR });
      }
    }
    const gap = Buffer.alloc(Math.round(GAP * SR) * 2);
    const all = Buffer.concat(pcms.flatMap((p, i) => (i ? [gap, p] : [p])));
    fs.writeFileSync(path.join(out, `${l.id}.wav`), wav(all));
    list.push({ id: l.id, file: `${l.id}.wav`, text: l.text, ...(l.say ? { say: l.say } : {}), sec: all.length / 2 / SR });
    console.log(`${l.id}.wav ${(all.length / 2 / SR).toFixed(2)}초  ${l.text}`);
  }
  fs.writeFileSync(path.join(out, "list.json"), JSON.stringify({ voice: health.voice, files: list }, null, 1) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
