// 사람이 한 번 돌리는 것: 노션 원격 MCP 서버에 미티를 OAuth 클라이언트로 등록(동적 등록, RFC 7591)하고
// 나온 client_id를 .env.local에 넣으라고 알려 준다. 코드가 저절로 등록하지 않는다(바깥 서비스에 무언가를 만드는 일).
//   npx tsx scripts/notion-register.ts            (APP_URL 기본 http://localhost:3100)
import { discover } from "../src/lib/integrations/oauth";
import { safeFetch } from "../src/lib/integrations/http";
import { NOTION_MCP_URL, NOTION_REDIRECT } from "../src/lib/integrations/notion";

async function main() {
  const as = await discover("notion", NOTION_MCP_URL);
  if (!as.registration_endpoint) throw new Error("이 서버는 동적 등록을 안 받아요. 노션 개발자 화면에서 직접 등록해 주세요.");
  const r = await safeFetch("notion", as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "미티", redirect_uris: [NOTION_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const j = (await r.json()) as { client_id?: string };
  if (!r.ok || !j.client_id) throw new Error(`등록 실패 (${r.status})`);
  console.log(`등록됐어요. .env.local에 이 줄을 넣고 앱을 다시 켜 주세요:\nNOTION_MCP_CLIENT_ID=${j.client_id}\n(리다이렉트 주소: ${NOTION_REDIRECT})`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
