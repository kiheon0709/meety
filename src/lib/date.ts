// 사용자 기준 오늘 날짜(YYYY-MM-DD). toISOString()은 UTC라 한국에선 아침 9시 전까지 하루 전 날짜가 나온다.
export function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 발화 속 요일·상대 날짜를 회의 날짜로 계산해 덧붙인다: "리허설은 일요일 저녁에" → "… [일요일 = 11/1(일)]".
// 정리 모델이 "일요일(11/1)"이라고 쓰면 근거 확인 모델이 녹취에서 11/1을 못 찾아 버리던 문제(시나리오 A 리허설) —
// 날짜 계산을 모델에 맡기지 않고 코드가 해서 두 단계가 같은 표시를 본다.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const DATE_WORD = /(지난주|저번 ?주|이번 ?주|다음 ?주|다다음 ?주)?\s*([일월화수목금토])요일|(오늘|내일|모레|글피)/g;

export function annotateDates(text: string, heldAt: string): string {
  const base = new Date(`${heldAt.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return text;
  const notes: string[] = [];
  for (const m of text.matchAll(DATE_WORD)) {
    const d = new Date(base);
    if (m[3]) {
      d.setUTCDate(d.getUTCDate() + { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[3] as "오늘"]);
    } else {
      // 주는 월요일 시작. 그냥 "일요일"은 오늘 포함 다가오는 그 요일, "이번 주"는 이번 주(월~일) 안의 그 요일
      const want = WEEKDAYS.indexOf(m[2]);
      const week = (m[1] ?? "").replace(/\s/g, "");
      const mon = new Date(base);
      mon.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7));
      const inWeek = (offsetWeeks: number) => {
        const x = new Date(mon);
        x.setUTCDate(mon.getUTCDate() + offsetWeeks * 7 + ((want + 6) % 7));
        return x;
      };
      if (!week) d.setUTCDate(base.getUTCDate() + ((want - base.getUTCDay() + 7) % 7));
      else d.setTime(inWeek({ 지난주: -1, 저번주: -1, 이번주: 0, 다음주: 1, 다다음주: 2 }[week as "이번주"]).getTime());
    }
    const note = `${m[0].trim()} = ${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
    if (!notes.includes(note)) notes.push(note);
  }
  return notes.length ? `${text} [${notes.join(", ")}]` : text;
}
