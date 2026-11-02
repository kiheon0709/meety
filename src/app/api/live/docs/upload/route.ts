import { NextResponse } from "next/server";
import { canAccessSpace } from "@/lib/auth";
import { saveUpload, UPLOAD_MAX_BYTES, UploadError } from "@/lib/integrations/upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/live/docs/upload (multipart: spaceId, file) → 그 스페이스에 묶인 DocInfo.
// 사실 뽑기(모델)가 끝날 때까지 기다린다. 같은 내용이면 캐시라 바로 끝난다.
export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > UPLOAD_MAX_BYTES + 64 * 1024) return NextResponse.json({ error: "10MB까지 받아요" }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "파일을 받지 못했어요" }, { status: 400 });
  }
  const spaceId = String(form.get("spaceId") ?? "");
  const file = form.get("file");
  if (!spaceId || !(file instanceof File)) return NextResponse.json({ error: "프로젝트와 파일이 필요해요" }, { status: 400 });
  if (!(await canAccessSpace(spaceId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const doc = await saveUpload(spaceId, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json(doc);
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("자료 올리기 실패", e);
    return NextResponse.json({ error: "파일을 읽지 못했어요" }, { status: 500 });
  }
}
