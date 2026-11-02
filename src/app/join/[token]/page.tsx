import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getInvite, getSpace, listMembers, memberForUser } from "@/lib/service";
import { joinAction } from "@/lib/actions";
import { AvatarStack } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const inv = getInvite(token);
  const space = inv ? getSpace(inv.space_id) : undefined;
  if (!inv || !space) {
    return (
      <div className="mx-auto max-w-sm px-5 py-20 text-center">
        <h1 className="text-[24px] font-bold tracking-[-0.03em]">초대 링크가 유효하지 않아요</h1>
        <p className="text-ink-2 mt-2 text-[14px]">팀원에게 새 링크를 받아주세요.</p>
      </div>
    );
  }
  const user = await getUser();
  if (user && memberForUser(space.id, user.id)) redirect(`/s/${space.id}`);
  const members = listMembers(space.id);
  const next = `/join/${token}`;

  return (
    <div className="mx-auto max-w-sm px-5 py-16 text-center">
      <div className="fade-up">
        <AvatarStack members={members} size={36} max={5} />
        <h1 className="mt-4 text-[26px] font-bold tracking-[-0.03em] leading-tight">
          <span className="text-blue">{space.name}</span>에<br />초대받았어요
        </h1>
        <p className="text-[14px] text-ink-2 mt-2">회의 녹취, 결정, 안건이 여기에 쌓여요. 합류하면 바로 볼 수 있어요.</p>
      </div>
      <div className="fade-up mt-7" style={{ "--i": 1 } as React.CSSProperties}>
        {user ? (
          <form action={joinAction}>
            <input type="hidden" name="token" value={token} />
            <button className="btn btn-lg btn-primary w-full">{user.name}(으)로 합류하기</button>
          </form>
        ) : (
          <div className="space-y-2">
            <Link href={`/signup?next=${encodeURIComponent(next)}`} className="btn btn-lg btn-primary w-full">
              가입하고 합류하기
            </Link>
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn btn-lg btn-secondary w-full">
              이미 계정이 있어요
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
