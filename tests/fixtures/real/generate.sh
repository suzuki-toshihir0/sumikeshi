#!/usr/bin/env bash
# 実在の作り方に近い PDF の試験用の素材を作る（中身はすべて架空）。
# NixOS なら: nix shell nixpkgs#jbig2enc nixpkgs#imagemagick nixpkgs#img2pdf -c ./generate.sh
# その後 `npx tsx tests/fixtures/real/build-pdfs.ts` で PDF にまとめる。
set -euo pipefail
cd "$(dirname "$0")"
FONT=$(fc-match -f '%{file}' 'Noto Serif CJK JP')

# スキャンした紙の代わり: 白地に黒の文字（1bit、800x300 画素）
magick -size 800x300 xc:white -font "$FONT" -fill black -pointsize 30 \
  -annotate +20+60 '建物賃貸借契約書' \
  -annotate +20+130 '賃借人氏名：見本 花子' \
  -annotate +20+200 '住所：架空県見本市一丁目二番三号' \
  -annotate +20+270 '賃料：月額 100,000 円' \
  -threshold 50% -type bilevel scan.png
magick scan.png scan.pbm

# JBIG2（共通の記号辞書あり。スキャナーの PDF でよくある形）
rm -f jb2.sym jb2.0000
jbig2 -s -p -b jb2 scan.pbm >/dev/null

# CCITT G4（FAX 形式。古いスキャナーの PDF でよくある形）
magick scan.pbm -compress Group4 scan-g4.tif
img2pdf scan-g4.tif -o ccitt.pdf

# JPEG（カメラで撮った書類の形）。灰色
magick scan.png -colorspace Gray -quality 90 scan.jpg

rm -f scan.pbm scan-g4.tif

# Chrome（Skia）で印刷した PDF。頁の座標を上下反転・縮小し、1 文字ずつ Td で進める形
if command -v google-chrome-stable >/dev/null; then
  PROFILE=$(mktemp -d)
  google-chrome-stable --headless=new --no-sandbox --disable-gpu --user-data-dir="$PROFILE" \
    --no-pdf-header-footer --print-to-pdf="$PWD/chrome.pdf" "file://$PWD/chrome.html" 2>/dev/null
  rm -rf "$PROFILE"
fi
