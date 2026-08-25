#!/usr/bin/env bash
# 从 ui/icon.svg 重新导出 PNG 和 macOS 的 .icns
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../ui"
command -v rsvg-convert >/dev/null || { echo "需要 rsvg-convert：brew install librsvg"; exit 1; }

rm -rf icon.iconset && mkdir -p icon.iconset
for sz in 16 32 128 256 512; do
  rsvg-convert -w "$sz" -h "$sz" icon.svg -o "icon.iconset/icon_${sz}x${sz}.png"
  rsvg-convert -w "$((sz*2))" -h "$((sz*2))" icon.svg -o "icon.iconset/icon_${sz}x${sz}@2x.png"
done
rm -f Kapibala.icns
iconutil -c icns icon.iconset -o Kapibala.icns
rm -rf icon.iconset
rsvg-convert -w 512  -h 512  icon.svg -o icon-512.png
rsvg-convert -w 1024 -h 1024 icon.svg -o icon-1024.png
echo "已导出 Kapibala.icns / icon-512.png / icon-1024.png"
