#!/usr/bin/env bash
# 画面の性質の試験（Bombadil）を走らせる。
#   tests/pbt/run.sh [時間（既定 3m）] [トレースの書き出し先（既定 test-results/pbt.bin）]
# 素材を作り、本番ビルドを vite preview で配り、Chrome（CHROME か PATH の google-chrome など）で走らせる。
# 性質が破れたら終了コード 2。トレースは `npx bombadil browser inspect <トレース>` で見られる
set -euo pipefail
cd "$(dirname "$0")/../.."
limit="${1:-3m}"
out="${2:-test-results/pbt.bin}"
port=5199

# ほかのサーバー（前に走らせた preview の残りなど）が答えるなら止める（今回のビルドを試さずに通ってしまう）
if curl -s -o /dev/null "http://localhost:$port/"; then
  echo "ポート $port で、すでに何かが動いています。止めてから走らせてください" >&2
  exit 1
fi

npx tsx tests/pbt/make-fixtures.ts
npm run build >/dev/null
mkdir -p "$(dirname "$out")"
npx vite preview --port "$port" --strictPort >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
ready=false
for _ in $(seq 1 50); do
  # 起動に失敗していたら止める
  kill -0 "$server" 2>/dev/null || { echo "vite preview の起動に失敗しました" >&2; exit 1; }
  if curl -sf -o /dev/null "http://localhost:$port/sumikeshi/"; then
    ready=true
    break
  fi
  sleep 0.2
done
$ready || { echo "vite preview が答えません" >&2; exit 1; }

# CI（GitHub Actions の Ubuntu 24.04 以降）では、権限の無い利用者の名前空間が制限されていて、Chrome のサンドボックスが
# 起動できないことがあるので外す（Playwright は自分で外すが、Bombadil は外さない）
extra=()
if [ -n "${CI:-}" ]; then extra+=(--no-sandbox); fi

npx bombadil browser test --headless --exit-on-violation --time-limit "$limit" "${extra[@]}" \
  --output-path "$out" --output-path-overwrite \
  "http://localhost:$port/sumikeshi/" tests/pbt/spec.ts
