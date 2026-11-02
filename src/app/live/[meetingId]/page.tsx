import { LiveMeeting } from "@/components/live/LiveMeeting";
import { getSpace, listDemoSpaces, listMembers } from "@/lib/service";

export const dynamic = "force-dynamic";

// 회의 중 미티. ?mock=A|B 목업 재생(&speed=2 빠르게, &barge=1 말 끊김 장면, &clean=1 조작 막대 숨김), ?present=1 발표 옆 작은 창,
// ?ui=classic 미티 전용 화면 전의 회의 화면
export default async function LivePage({ params, searchParams }: PageProps<"/live/[meetingId]">) {
  const { meetingId } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const mock = one("mock") === "A" || one("mock") === "B" ? (one("mock") as "A" | "B") : undefined;
  const speed = Math.min(8, Math.max(0.25, Number(one("speed")) || 1));
  // 목업은 예시 스페이스, 실제는 시작할 때 넘긴 ?space=
  const space = mock ? listDemoSpaces()[0] : one("space") ? getSpace(one("space")!) : undefined;
  const colors = Object.fromEntries((space ? listMembers(space.id) : []).map((m) => [m.name, m.color]));
  return (
    <LiveMeeting
      meetingId={meetingId}
      mock={mock}
      speed={speed}
      present={one("present") === "1"}
      barge={one("barge") === "1"}
      clean={one("clean") === "1"}
      debug={one("debug") === "1"}
      space={space ? { id: space.id, name: space.name } : undefined}
      colors={colors}
      classic={one("ui") === "classic"}
    />
  );
}
