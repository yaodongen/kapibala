#!/usr/bin/env bash
# 打包桌面版。electron-builder 会直接 spawn `pnpm`，但我们用的是 corepack，
# PATH 里没有 pnpm 这个可执行文件 —— 所以先在构建目录里放一个 corepack 生成的 shim。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/apps/desktop"

SHIM="$PWD/.build-bin"
mkdir -p "$SHIM"
corepack enable pnpm --install-directory "$SHIM"
export PATH="$SHIM:$PATH"

node build.mjs
exec corepack pnpm exec electron-builder "$@"
