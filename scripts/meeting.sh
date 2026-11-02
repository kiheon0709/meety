#!/usr/bin/env bash
# 한 명령으로 실제 회의 열기: npm run meeting
#   ① 메인 저장소 DB를 복사본(data/meeting-YYYYMMDD.db)으로 — 원본은 읽기만 (해시로 확인)
#   ② 음성 서버(받아쓰기·미티 목소리)  ③ 자료 읽기(기획서·결정 기록·제출 안내, MEETING_DOCS로 바꿈)  ④ 앱(복사본 DB로)  ⑤ 데우기 → 주소 출력
# Ctrl+C 하면 둘 다 끈다.
# 환경변수: PORT(기본 3100) VOICE_PORT(기본 8765) GALPI_SOURCE_DB(복사할 원본) MEETING_DB(복사본 경로)
#           MEETING_LIVE=1(복사본 대신 원본에 바로 기록, 켜기 전 data/backup-YYYYMMDD-HHMM/에 백업)
#           MEETING_FRESH=1(오늘 복사본이 있어도 새로 복사) MEETING_DOCS(읽을 자료, 공백으로 여러 개) MEETY_TTS(목소리 엔진)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-3100}
VOICE_PORT=${VOICE_PORT:-8765}
DAY=$(date +%Y%m%d)
LOG_DIR="$ROOT/data/meeting-logs"
mkdir -p "$LOG_DIR"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── ⓪ 모델 키 ─────────────────────────────────────────────
# 키가 없으면 자료 묶기가 "Could not resolve authentication method"로 조용히 실패하고, 회의 중 미티는 판단을 못 한다
if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! grep -qE '^\s*ANTHROPIC_API_KEY\s*=\s*\S' .env.local 2>/dev/null; then
  die "모델 키(ANTHROPIC_API_KEY)가 없어요. 이 폴더에 .env.local을 두세요:
   cp <원래 쓰던 곳>/.env.local .env.local   (RUNBOOK 0절)"
fi

# ── 포트: 먼저 확인 (DB 복사·자료 읽기 전에) ──────────────────────
port_busy() { # 포트, 이름, 바꿀 변수
  local pid
  pid=$(lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  [ -z "$pid" ] && return 0
  local what
  what=$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-80 || true)
  die "$2 포트 ${1}를 다른 프로그램이 쓰고 있어요 (pid $pid: $what)
   전에 켠 npm run meeting이 남아 있으면 그 터미널에서 Ctrl+C, 아니면 ${3}=다른번호 npm run meeting"
}
port_busy "$VOICE_PORT" "음성" VOICE_PORT
port_busy "$PORT" "앱" PORT

# ── ① DB 복사 ─────────────────────────────────────────────
# 원본: 메인 체크아웃의 data/ctxgit.db (워크트리에서 돌려도 메인 것을 찾는다)
MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
SRC=${GALPI_SOURCE_DB:-$MAIN_ROOT/data/ctxgit.db}
DB=${MEETING_DB:-$ROOT/data/meeting-$DAY.db}
[ -f "$SRC" ] || die "원본 DB가 없어요: $SRC (GALPI_SOURCE_DB로 지정)"
[ "${MEETING_LIVE:-0}" = 1 ] || [ "$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")" != "$(cd "$(dirname "$DB")" 2>/dev/null && pwd)/$(basename "$DB")" ] || die "복사본 경로가 원본과 같아요 (원본에 바로 쓰려면 MEETING_LIVE=1)"
# -wal이 없을 수도 있다 (pipefail이라 cat이 실패하면 스크립트가 조용히 죽는다)
hash_src() {
  local f=("$SRC")
  [ -f "$SRC-wal" ] && f+=("$SRC-wal")
  cat "${f[@]}" | shasum | cut -c1-12
}
SRC_HASH=$(hash_src)
LIVE=${MEETING_LIVE:-0}
if [ "$LIVE" = 1 ]; then
  # 원본에 바로 기록하는 모드: 켜기 전에 원본을 통째로 백업해 둔다 (되돌리려면 이 폴더의 파일을 원본 자리에 복사)
  BACKUP="$(dirname "$SRC")/backup-$(date +%Y%m%d-%H%M)"
  mkdir -p "$BACKUP"
  cp "$SRC" "$BACKUP/"
  [ -f "$SRC-wal" ] && cp "$SRC-wal" "$BACKUP/"
  [ -f "$SRC-shm" ] && cp "$SRC-shm" "$BACKUP/"
  DB="$SRC"
  say "① 원본 기록에 바로 남겨요: $SRC"
  echo "   켜기 전 백업: $BACKUP  (되돌리려면 그 안의 파일을 원본 자리로 복사)"
elif [ -f "$DB" ] && [ "${MEETING_FRESH:-0}" != 1 ]; then
  say "① 오늘 복사본을 이어서 써요: $DB  (새로 복사하려면 MEETING_FRESH=1)"
else
  # 파일 복사만 한다 (원본을 sqlite로 열지 않는다). -wal에 최근 기록이 있어 같이 복사
  rm -f "$DB" "$DB-wal" "$DB-shm"
  cp "$SRC" "$DB"
  [ -f "$SRC-wal" ] && cp "$SRC-wal" "$DB-wal"
  [ -f "$SRC-shm" ] && cp "$SRC-shm" "$DB-shm"
  say "① 원본 DB를 복사했어요: $SRC → $DB"
fi
[ "$LIVE" = 1 ] || echo "   원본 해시 $SRC_HASH (끝날 때 다시 확인)"
# 복사본에서만: 옛 서비스 이름 "갈피"를 "미티"로 — 스페이스 이름(scripts/seed.ts)·회의 3 이름 정하기 녹취와 그 결정·기획 자료 (10/31 기헌 결정, S10과 같은 낱말).
# 원본 DB는 옛 이름 그대로라 시연 영상에 "갈피"가 보였다. 원본에 쓰는 모드(MEETING_LIVE=1)에선 안 한다
[ "$LIVE" = 1 ] || GALPI_SOURCE_DB="$SRC" npx tsx scripts/rename-copy.ts "$DB" || die "복사본 이름 바꾸기 실패"
export GALPI_DB_PATH="$DB"
# 화면 위에 어느 쪽에 기록하는지 보여 준다
export NEXT_PUBLIC_MEETING_DB=$([ "$LIVE" = 1 ] && echo live || echo copy)

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo
  say "끄는 중…"
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true; done
  AFTER=$(hash_src)
  if [ "$LIVE" = 1 ]; then echo "   원본 기록에 남겼어요: $SRC (켜기 전 백업: $BACKUP)"
  elif [ "$AFTER" = "$SRC_HASH" ]; then echo "   원본 DB 그대로예요 (해시 $AFTER)"; else echo "   ⚠️ 원본 DB 해시가 바뀌었어요: $SRC_HASH → $AFTER (다른 프로그램이 원본을 쓰고 있을 수 있어요)"; fi
  echo "   오늘 회의 기록: $DB"
}
trap cleanup INT TERM EXIT

# ── ② 음성 서버 ──────────────────────────────────────────
PY=${VOICE_PYTHON:-$ROOT/voice/.venv/bin/python}
# 다른 워크트리의 venv를 가리키는 링크면 그 폴더가 지워질 때 같이 깨진다 → 알려만 준다
[ -L "$ROOT/voice/.venv" ] && echo "   ⚠️ voice/.venv가 링크예요 ($(readlink "$ROOT/voice/.venv")). 이 폴더 안에 진짜 venv를 만드는 게 안전해요 (RUNBOOK 0절)"
[ -x "$PY" ] || die "음성 서버 파이썬이 없어요: $PY
   처음 한 번: /opt/homebrew/bin/python3.12 -m venv voice/.venv && voice/.venv/bin/pip install -r voice/requirements.txt -r voice/requirements-tts.txt
   (기본 python3는 3.8이라 안 돼요. docs/agent/RUNBOOK.md 0절)"
say "② 음성 서버 켜는 중 (포트 $VOICE_PORT, 받아쓰기·목소리 모델 데우기)…"
"$PY" -m uvicorn server:app --app-dir voice --host 127.0.0.1 --port "$VOICE_PORT" >>"$LOG_DIR/voice-$DAY.log" 2>&1 &
PIDS+=($!)

# ── ③ 자료 읽기 + 스페이스에 묶기 (같은 내용이면 캐시라 비용 0) ──────────
# 두뇌는 스페이스에 묶인 자료만 쓴다 (scripts/live-docs.ts). 복사본 DB의 모든 스페이스에 묶는다
DOCS=${MEETING_DOCS-docs/agent/scenarios/B-plan.md}   # 회의에 묶을 예시 자료. MEETING_DOCS= (빈 값)이면 자료 없이
export GALPI_EMBED=${GALPI_EMBED-0}   # 이 자료 세트는 낱말 검색만으로 충분 (S4 측정). 임베딩 쓰려면 GALPI_EMBED=1
say "③ 자료 읽는 중: ${DOCS:-(없음)}"
[ -z "$DOCS" ] && SPACES_SKIP=1
SPACES=$(node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});console.log(db.prepare("select id from spaces").all().map(r=>r.id).join(" "))' "$DB" 2>/dev/null || true)
[ -n "$SPACES" ] || echo "   (스페이스를 못 읽었어요 — 자료 없이 진행돼요)"
[ -n "${SPACES_SKIP:-}" ] && SPACES=""
for sp in $SPACES; do
  # shellcheck disable=SC2086
  # --replace: 원본 DB에서 따라온 예전 묶음(시험용 가짜 기획·옛 기획)은 풀고 이 목록만 남긴다
  if ! out=$(npx tsx scripts/live-docs.ts "$sp" $DOCS --replace 2>&1); then
    printf '%s\n' "$out" | tail -3 | sed 's/^/   /'
    die "자료를 못 읽었어요 ($sp). 키·인터넷을 확인하세요. 자료 없이 열려면 MEETING_DOCS= npm run meeting"
  fi
  printf '%s\n' "$out" | grep -E "→|✕|자료" | sed 's/^/   /' || true
done

# ── ④ 앱 ────────────────────────────────────────────────
say "④ 앱 켜는 중 (포트 $PORT, DB $DB)…"
start_app() {
  # Next 16은 AI 에이전트가 켠 것으로 보이면(환경변수) 업그레이드 안내를 띄우고 첫 실행을 멈춘다.
  # 사람이 터미널에서 켜면 안 생기는 일이라, 앱에는 그 표시 변수를 넘기지 않는다 (업그레이드 여부는 관리 세션 판단)
  env -u AI_AGENT -u CLAUDECODE -u CLAUDE_CODE -u CLAUDE_CODE_IS_COWORK -u CODEX_CI -u CODEX_SANDBOX -u CODEX_THREAD_ID -u CURSOR_AGENT -u CURSOR_TRACE_ID -u GEMINI_CLI -u OPENCODE_CLIENT \
    NEXT_PUBLIC_VOICE_PORT="$VOICE_PORT" npx next dev -p "$PORT" >>"$LOG_DIR/app-$DAY.log" 2>&1 &
  APP_PID=$!
  PIDS+=("$APP_PID")
}
start_app

wait_for() { # url, 초, [지켜볼 pid]
  for _ in $(seq 1 "$2"); do
    curl -s -o /dev/null --max-time 2 "$1" && return 0
    [ -n "${3:-}" ] && ! kill -0 "$3" 2>/dev/null && return 2
    sleep 1
  done
  return 1
}
wait_for "http://127.0.0.1:$VOICE_PORT/speakers" 420 || die "음성 서버가 안 떠요. 로그: $LOG_DIR/voice-$DAY.log"
echo "   음성 서버 준비됨 (등록된 목소리: $(curl -s "http://127.0.0.1:$VOICE_PORT/speakers"))"
echo "   $(curl -s "http://127.0.0.1:$VOICE_PORT/status" | "$PY" -c 'import json,sys; d=json.load(sys.stdin); print(f"목소리: {d[\"voice\"]} · 받아쓰기: {d[\"stt\"]}")' 2>/dev/null)"
# Next가 처음 한 번 "업그레이드 권장" 안내를 띄우고 멈출 때가 있다 → 한 번 더 켠다
for try in 1 2; do
  rc=0
  wait_for "http://127.0.0.1:$PORT/" 120 "$APP_PID" || rc=$?
  [ $rc = 0 ] && break
  if [ $rc = 2 ] && [ $try = 1 ]; then
    echo "   앱이 바로 멈춰서 한 번 더 켜요 (로그: $LOG_DIR/app-$DAY.log)"
    start_app
  else
    die "앱이 안 떠요. 로그: $LOG_DIR/app-$DAY.log"
  fi
done

# ── ⑤ 데우기: 처음 여는 화면·API를 미리 한 번 열어 컴파일해 둔다 ─────────
say "⑤ 화면 데우는 중…"
for u in /live/new /live/warmup "/live/demo-a?mock=A"; do
  curl -s -o /dev/null --max-time 120 "http://127.0.0.1:$PORT$u" || true
done
curl -s -o /dev/null --max-time 30 -X POST -H 'content-type: application/json' -d '{"texts":["안녕하세요, 미티예요. 지금부터 회의 녹음과 기록을 시작할게요."]}' "http://127.0.0.1:$VOICE_PORT/tts/prefetch" || true

LAN=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo
say "준비됐어요 ✨"
echo "   회의 시작:   http://localhost:$PORT/live/new"
[ -n "$LAN" ] && echo "   다른 기기:   http://$LAN:$PORT  (같은 와이파이. 휴대폰은 화면 보기만 — 마이크는 https가 필요해요)"
echo "   목업 보기:   http://localhost:$PORT/live/demo-a?mock=A"
echo "   로그:        $LOG_DIR/"
echo "   끄기:        Ctrl+C"
wait
