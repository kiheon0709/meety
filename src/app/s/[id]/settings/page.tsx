import { getSpace } from "@/lib/service";
import { discordStatus, getConnection } from "@/lib/integrations/connections";
import { disconnectNotionAction, importNotionAction, updateSettingsAction } from "@/lib/actions";
import { APPROVAL_MODE_LABEL, type ApprovalMode } from "@/lib/types";
import { SectionTitle } from "@/components/ui";
import { PageHead } from "@/components/PageHead";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

export default async function SettingsPage({ params }: PageProps<"/s/[id]/settings">) {
  const { id } = await params;
  const space = getSpace(id)!;
  const discord = discordStatus(id);
  const notion = getConnection(id, "notion");
  const notionPages = Object.values((notion?.root.imported ?? {}) as Record<string, { title: string; url: string; fetchedAt: string }>);
  const modes: { v: ApprovalMode; desc: string }[] = [
    { v: "any", desc: "누구든 한 명이 동의하면 바로 반영. 작은 팀, 서로 다 아는 사이." },
    { v: "deciders", desc: "팀장이 동의해야 확정. 나머지는 의견만." },
    { v: "count", desc: "정한 인원 이상 동의해야 반영. 반대가 있으면 '엇갈림'으로 남음." },
  ];

  return (
    <div className="max-w-3xl space-y-8">
      <PageHead title="설정" sub="확인 방식과 연동이에요. 팀원·초대는 팀원 화면으로 옮겼어요." />
      {/* 결정 방식 */}
      <section className="fade-up" style={S(4)}>
        <SectionTitle>결정 방식</SectionTitle>
        <form action={updateSettingsAction} className="card p-6 space-y-4">
          <input type="hidden" name="space_id" value={id} />
          <p className="text-[13.5px] text-ink-2">
            미티는 같이 정한 걸 바꾸는 업데이트만 &ldquo;한 번 봐주세요&rdquo;로 물어봐요. <b>반대가 없으면 기한이 지난 뒤 그대로 확정</b>하고, 반대가 있을 때만 아래 방식대로 결론을 내요. 누가 언제 동의·반대했는지는 항상 남아요.
          </p>
          <label className="flex items-center gap-2 text-[13.5px] card-tinted p-4">
            <span>반대가 없으면</span>
            <select name="review_hours" defaultValue={String(space.review_hours ?? 48)} className="input !w-auto !py-1">
              <option value="24">하루(24시간)</option>
              <option value="48">이틀(48시간)</option>
              <option value="72">사흘(72시간)</option>
              <option value="168">일주일</option>
              <option value="0">자동 확정 안 함</option>
            </select>
            <span>뒤에 미티가 확정해요</span>
          </label>
          <p className="text-[12.5px] text-ink-3">반대가 있을 때 결론 내는 방식</p>
          <div className="space-y-2">
            {modes.map((m) => (
              <label key={m.v} className="flex items-start gap-3 card-tinted p-4 cursor-pointer has-[:checked]:ring-2 has-[:checked]:ring-blue/40 has-[:checked]:bg-blue/5 transition">
                <input type="radio" name="approval_mode" value={m.v} defaultChecked={space.approval_mode === m.v} className="mt-1 accent-[var(--agent-1)]" />
                <span className="flex-1">
                  <span className="font-semibold text-[15px]">{APPROVAL_MODE_LABEL[m.v]}</span>
                  <span className="block text-[13px] text-ink-2 mt-0.5">{m.desc}</span>
                  {m.v === "count" && (
                    <span className="mt-2 inline-flex items-center gap-2 text-[13px]">
                      <input name="approval_count" type="number" min={1} max={20} defaultValue={space.approval_count} className="input !w-16 !py-1 text-center" /> 명 이상
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between pt-1 flex-wrap gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <span className="text-ink-3">프로젝트 이름</span>
              <input name="name" defaultValue={space.name} className="input !w-64" />
            </label>
            <button className="btn btn-md btn-primary">저장</button>
          </div>
        </form>
      </section>

      {/* 연동 */}
      <section id="integrations" className="fade-up scroll-mt-20" style={S(5)}>
        <SectionTitle>연동</SectionTitle>
        <form action={updateSettingsAction} className="card p-6 mb-3">
          <input type="hidden" name="space_id" value={id} />
          <div className="font-semibold text-[15px]">디스코드 채널에 먼저 말하기</div>
          <p className="text-[13px] text-ink-2 mt-1 leading-relaxed">
            채널 설정 → 연동 → 웹후크에서 만든 URL을 붙여넣으면, 회의를 정리했을 때 달라진 점, 브리핑이 새로 써졌을 때 요약, 의견이 엇갈렸을 때 한 줄을 미티가 채널에 올려요. 봇 설치는 필요 없어요.
          </p>
          <div className="mt-3 flex gap-2">
            <input name="discord_webhook" placeholder={discord.connected ? "새 주소로 바꾸려면 붙여넣기" : "https://discord.com/api/webhooks/…"} className="input flex-1 font-mono text-[12.5px]" />
            <button className="btn btn-md btn-secondary shrink-0">저장</button>
          </div>
          {discord.connected && (
            <p className="mt-2 text-[12px] text-green-ink">
              연결돼 있어요 <span className="font-mono">{discord.hint}</span>. 주소는 암호화해 두고 다시 보여 주지 않아요.
              <button name="discord_disconnect" value="1" className="ml-2 underline text-ink-2">
                연결 끊기
              </button>
            </p>
          )}
        </form>
        <div className="card p-6 mb-3">
          <div className="font-semibold text-[15px]">노션 페이지를 미티 자료로</div>
          <p className="text-[13px] text-ink-2 mt-1 leading-relaxed">
            노션 공식 연결(MCP)로 고른 페이지만 읽어서 사실로 만들어요. 회의 중 미티가 근거로 보여 줄 때 노션 링크를 같이 붙여요. 미티가 노션에 써 넣은 페이지는 다시 읽지 않아요.
          </p>
          {!notion ? (
            <a href={`/api/integrations/notion/connect?spaceId=${encodeURIComponent(id)}`} className="btn btn-md btn-secondary mt-3">
              노션 연결하기
            </a>
          ) : (
            <>
              {notion.status !== "ok" && <p className="mt-2 text-[12px] text-red">연결이 만료됐어요. 끊고 다시 연결해 주세요.</p>}
              <form action={importNotionAction} className="mt-3 flex gap-2">
                <input type="hidden" name="space_id" value={id} />
                <input name="page" placeholder="https://www.notion.so/… 페이지 주소" className="input flex-1 text-[12.5px]" />
                <button className="btn btn-md btn-secondary shrink-0">가져오기</button>
              </form>
              {notionPages.length > 0 && (
                <ul className="mt-3 space-y-1 text-[13px]">
                  {notionPages.map((p) => (
                    <li key={p.url}>
                      <a href={p.url} className="underline" target="_blank" rel="noreferrer">
                        {p.title}
                      </a>{" "}
                      <span className="text-ink-3">· {p.fetchedAt.slice(0, 10)} 기준</span>
                    </li>
                  ))}
                </ul>
              )}
              <form action={disconnectNotionAction} className="mt-2">
                <input type="hidden" name="space_id" value={id} />
                <button className="text-[12px] underline text-ink-2">노션 연결 끊기 (가져온 자료도 이 프로젝트에서 빠져요)</button>
              </form>
            </>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { name: "디스코드 봇", desc: "동의 버튼, 채팅 읽기, 음성 채널 녹음 (2단계)" },
            { name: "클로바노트", desc: "녹취가 생기면 자동으로 가져오기" },
            { name: "피그마", desc: "디자인 변경을 맥락에 반영" },
          ].map((x) => (
            <div key={x.name} className="card-flat p-5 opacity-70">
              <div className="font-semibold text-[15px]">{x.name}</div>
              <p className="text-[13px] text-ink-2 mt-1 leading-relaxed">{x.desc}</p>
              <span className="btn btn-sm btn-secondary mt-3 opacity-60 pointer-events-none">준비 중</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
