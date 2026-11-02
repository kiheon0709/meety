#!/usr/bin/env bash
# Qwen3-TTS 작업자 venv를 공유 자리(~/.cache/meety/venvs/mlx)에 한 번 만든다 — 워크트리마다 다시 깔지 않는다. 모델은 HF 캐시를 같이 쓴다.
# 사용: bash voice/setup_mlx.sh   (npm run meeting이 없으면 알아서 부른다). 다른 자리: MEETY_MLX_VENV=경로
set -euo pipefail
DIR=${MEETY_MLX_VENV:-$HOME/.cache/meety/venvs/mlx}
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -x "$DIR/bin/python" ] && "$DIR/bin/python" -c "import mlx_audio" 2>/dev/null; then
  echo "$DIR"; exit 0
fi
PY=${MEETY_MLX_BASE_PYTHON:-/opt/homebrew/bin/python3.12}
mkdir -p "$(dirname "$DIR")"
if command -v uv >/dev/null; then
  uv venv -q -p "$PY" "$DIR" >&2
  VIRTUAL_ENV="$DIR" uv pip install -q -r "$HERE/requirements-mlx.txt" >&2
else
  "$PY" -m venv "$DIR" >&2
  "$DIR/bin/pip" install -q -r "$HERE/requirements-mlx.txt" >&2
fi
echo "$DIR"
