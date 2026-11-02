import { getUser } from "@/lib/auth";
import { getHead } from "@/lib/head";
import { getOrCreateInvite, listMembers, listSessions, liveRecordOf, memberForUser } from "@/lib/service";
import { addMemberAction, claimMemberAction, removeMemberAction } from "@/lib/actions";
import { PageHead } from "@/components/PageHead";
import { VoiceStatus } from "@/components/VoiceStatus";
import { CopyField } from "@/components/CopyField";
import { Avatar } from "@/components/ui";

export const dynamic = "force-dynamic";

// 팀원 (uiux-redesign.md §6): 이름·팀장(= 결정권자, 기헌 10/31)·목소리 등록 상태·온 회의·열린 할 일. 초대도 여기
export default async function MembersPage({ params }: PageProps<"/s/[id]/members">) {
  const { id } = await params;
  const members = listMembers(id);
  const user = await getUser();
  const mine = user ? memberForUser(id, user.id) : undefined;
  const inviteToken = getOrCreateInvite(id, user?.id);
  const sessions = listSessions(id, "meeting");
  const came = (name: string) => sessions.filter((s) => (liveRecordOf(s)?.participants ?? s.participants.split(",").map((x) => x.trim())).includes(name)).length;
  const solo = sessions.filter((s) => liveRecordOf(s)?.participants.length === 1).length;
  const openTodos = getHead(id).filter((n) => n.type === "action" && n.status === "open");

  return (
    <div className="max-w-[920px] space-y-6">
      <PageHead title="팀원" sub={`${members.length}명 · 회의 ${sessions.length}번${solo ? ` (1:1 ${solo}번)` : ""}. 미티는 목소리로 누가 말했는지 알아들어요.`} />

      <section className="fade-up card overflow-hidden" style={{ "--i": 1 } as React.CSSProperties}>
        <ul className="divide-hair">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-4">
              <Avatar name={m.name} color={m.color} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[15.5px] flex flex-wrap items-center gap-2">
                  {m.name}
                  {m.role === "owner" && <span className="rounded-full bg-black/5 text-ink-2 text-[11px] font-medium px-2 py-0.5">팀장</span>}
                  {mine?.id === m.id && <span className="rounded-full bg-[var(--agent-soft)] text-agent text-[11px] px-2 py-0.5">나</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
                  <VoiceStatus name={m.name} />
                  <span>회의 {came(m.name)}번</span>
                  <span>열린 할 일 {openTodos.filter((n) => n.owner === m.name).length}개</span>
                  {!m.user_id && <span className="text-ink-3">계정 연결 안 됨</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {user && !m.user_id && mine?.id !== m.id && (
                  <form action={claimMemberAction}>
                    <input type="hidden" name="space_id" value={id} />
                    <input type="hidden" name="member_id" value={m.id} />
                    <button className="btn btn-sm btn-ghost">이게 나예요</button>
                  </form>
                )}
                {mine?.id !== m.id && (
                  <form action={removeMemberAction}>
                    <input type="hidden" name="space_id" value={id} />
                    <input type="hidden" name="member_id" value={m.id} />
                    <button className="btn btn-sm btn-ghost !text-ink-3 hover:!text-red">빼기</button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
        <form action={addMemberAction} className="flex gap-2 px-4 sm:px-5 py-4 bg-surface-2 [box-shadow:inset_0_0.5px_0_var(--line)]">
          <input type="hidden" name="space_id" value={id} />
          <input name="name" placeholder="이름만 먼저 추가해도 돼요" className="input flex-1" required />
          <button className="btn btn-md btn-secondary">추가</button>
        </form>
      </section>

      <section className="fade-up grid gap-4 md:grid-cols-2" style={{ "--i": 2 } as React.CSSProperties}>
        <div className="card p-5">
          <div className="font-semibold text-[15px]">초대 링크</div>
          <p className="text-[13px] text-ink-2 mt-1">보내면 가입하고 바로 이 프로젝트에 들어와요.</p>
          <CopyField value={`/join/${inviteToken}`} className="mt-3" />
        </div>
        <div className="card p-5">
          <div className="font-semibold text-[15px]">목소리 등록</div>
          <p className="text-[13px] text-ink-2 mt-1 leading-relaxed">
            회의 화면에서 이름을 누르고 5초쯤 말하면 등록돼요. 등록하면 받아쓰기에 이름이 붙고, 미티가 말하다 누가 끊었는지 알아요. 혼자 미티와 하는 1:1 회의는 등록 없이도 돼요.
          </p>
        </div>
      </section>
    </div>
  );
}
