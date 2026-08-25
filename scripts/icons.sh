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

# dmg 的图标（app 图标 + 装入角标），同时也是挂载后桌面上那个卷的图标
rm -rf dmg.iconset && mkdir -p dmg.iconset
for sz in 16 32 128 256 512; do
  rsvg-convert -w "$sz" -h "$sz" dmg-icon.svg -o "dmg.iconset/icon_${sz}x${sz}.png"
  rsvg-convert -w "$((sz*2))" -h "$((sz*2))" dmg-icon.svg -o "dmg.iconset/icon_${sz}x${sz}@2x.png"
done
rm -f dmg.icns && iconutil -c icns dmg.iconset -o dmg.icns && rm -rf dmg.iconset

# dmg 窗口的拖拽引导背景。电子构建要的是多分辨率 tiff，放进 buildResources
rsvg-convert -w 540  -h 380 dmg-background.svg -o /tmp/kapi-bg-1x.png
rsvg-convert -w 1080 -h 760 dmg-background.svg -o /tmp/kapi-bg-2x.png
tiffutil -cathidpicheck /tmp/kapi-bg-1x.png /tmp/kapi-bg-2x.png -out ../apps/desktop/build/background.tiff
rm -f /tmp/kapi-bg-1x.png /tmp/kapi-bg-2x.png

echo "已导出 Kapibala.icns / dmg.icns / icon-512.png / icon-1024.png / build/background.tiff"
