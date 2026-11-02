// 가짜 두뇌만 띄우기 (화면을 두뇌 없이 실제 연결로 시험할 때): npx tsx scripts/e2e-fake-brain.ts [포트=3199]
// 화면은 /live/{아무 id}?brain=http://127.0.0.1:3199 로 연다.
import { startFakeBrain } from "../tests/e2e/fake-brain";

const port = Number(process.argv[2] ?? 3199);
startFakeBrain(port).then((b) => {
  console.log(`가짜 두뇌: ${b.url}`);
  setInterval(() => {}, 1 << 30);
});
