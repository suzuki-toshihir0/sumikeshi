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

npx tsx tests/pbt/make-fixtures.ts
npm run build >/dev/null
mkdir -p "$(dirname "$out")"
npx vite preview --port "$port" --strictPort >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:$port/sumikeshi/" && break
  sleep 0.2
done

npx bombadil browser test --headless --exit-on-violation --time-limit "$limit" \
  --output-path "$out" --output-path-overwrite \
  "http://localhost:$port/sumikeshi/" tests/pbt/spec.ts
