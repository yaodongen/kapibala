# Kapibala 一键部署
#
#   make            看有哪些命令
#   make deploy     装依赖 + 自检 + 把 kapi 放进 PATH
#   make desktop    启动桌面版
#
# 变量：PREFIX=装到哪（默认 ~/.local/bin）

SHELL   := /bin/bash
REPO    := $(shell pwd)
PREFIX  ?= $(HOME)/.local/bin
BIN     := $(PREFIX)/kapi
PNPM    := corepack pnpm
CLI     := $(REPO)/apps/cli/src/index.ts
VERSION := $(shell node -p "require('./package.json').version")
ICLOUD  := $(HOME)/Library/Mobile Documents/com~apple~CloudDocs

.DEFAULT_GOAL := help
.PHONY: help desktop app dmg install-app tag run check test e2e deploy doctor install unlink \
        watch icons clean distclean typecheck link desktop-build

help:
	@echo ""
	@echo "  Kapibala · 卡皮巴拉"
	@echo ""
	@echo "  日常"
	@echo "    make desktop     构建并启动桌面版"
	@echo "    make run ARGS=   跑 CLI，例：make run ARGS=\"add 买菜 --at today\""
	@echo "    make check       类型检查 + 全部测试"
	@echo "    make test        只跑测试"
	@echo "    make e2e         真实文件系统上模拟两台 Mac 同步并断言结果"
	@echo ""
	@echo "  打包"
	@echo "    make app         打出 Kapibala.app（本机直接双击就能跑）"
	@echo "    make install-app 打包并装进 /Applications"
	@echo "    make dmg         打出可以发给别人的 dmg"
	@echo "    make tag         打 v$(VERSION) 标签并推送，触发 release 构建"
	@echo ""
	@echo "  安装"
	@echo "    make deploy      装依赖 + 自检 + 把 kapi 装进 $(PREFIX)"
	@echo "    make doctor      只检查环境（node / corepack / PATH）"
	@echo "    make install     只装依赖"
	@echo "    make unlink      卸载 kapi 命令"
	@echo ""
	@echo "  偶尔"
	@echo "    make watch       测试 watch 模式"
	@echo "    make icons       从 ui/icon.svg 重新导出 png 和 icns"
	@echo "    make clean       清理临时产物"
	@echo "    make distclean   连 node_modules 一起删"
	@echo ""


# ─────────────────────────────────────────────────────────────
#  日常
# ─────────────────────────────────────────────────────────────

# 标签名取自 package.json，避免 tag 与包里的版本号对不上 ——
# workflow 里那道断言拦的就是这种情况
tag:
	@test -z "$$(git status --porcelain)" || { echo "工作区不干净，先提交"; exit 1; }
	@git fetch -q origin
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/$$(git branch --show-current))" || \
	  { echo "当前提交还没推上去。release 的代码要和标签一致，先 git push"; exit 1; }
	@git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null && \
	  { echo "本地已有 v$(VERSION)：git tag -d v$(VERSION)"; exit 1; } || true
	@git ls-remote --exit-code --tags origin "v$(VERSION)" >/dev/null 2>&1 && \
	  { echo "远端已有 v$(VERSION)：git push origin :refs/tags/v$(VERSION)"; exit 1; } || true
	@git tag "v$(VERSION)"
	@git push -q origin "v$(VERSION)"
	@echo "已推送 v$(VERSION)，release 构建开始了："
	@echo "    $$(git remote get-url origin | sed -E 's|git@github.com:|https://github.com/|; s|\.git$$||')/actions"

install-app: app
	@rm -rf /Applications/Kapibala.app
	@cp -R "$(APP)" /Applications/
	@echo "→ /Applications/Kapibala.app"


desktop: desktop-build
	@cd apps/desktop && $(PNPM) exec electron .

run:
	@node "$(CLI)" $(ARGS)

check: typecheck test

test:
	@echo "→ 测试"
	@$(PNPM) test

e2e:
	@bash scripts/e2e.sh


# ─────────────────────────────────────────────────────────────
#  打包
# ─────────────────────────────────────────────────────────────

APP := apps/desktop/release/mac-arm64/Kapibala.app

# 本地只出本机架构。CI 里不带 --arm64，两个架构都出
app:
	@bash scripts/pack.sh --dir --arm64
	@echo "→ $(APP)"

dmg:
	@bash scripts/pack.sh --mac dmg --arm64
	@ls apps/desktop/release/*.dmg



# ─────────────────────────────────────────────────────────────
#  安装
# ─────────────────────────────────────────────────────────────

deploy: doctor install check link
	@echo ""
	@echo "→ 验证"
	@"$(BIN)" --help >/dev/null && echo "  ✓ kapi 能跑"
	@echo ""
	@echo "装好了。下一步："
	@echo "    kapi vault create ~/Library/Mobile\\ Documents/com~apple~CloudDocs/Kapibala"
	@echo "    kapi add \"买菜\" --at today"
	@echo "    kapi today"
	@echo ""

doctor:
	@echo "→ 环境检查"
	@command -v node >/dev/null || { echo "  ✗ 没有 node。装一个 22.18 以上的版本"; exit 1; }
	@node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a>22||(a===22&&b>=18)) process.exit(0); console.error("  ✗ node "+process.versions.node+" 太老，需要 22.18+（要直接跑 .ts 不做编译）"); process.exit(1)'
	@echo "  ✓ node $$(node -v)"
	@command -v corepack >/dev/null || { echo "  ✗ 没有 corepack。node 自带，检查安装"; exit 1; }
	@echo "  ✓ pnpm $$($(PNPM) --version 2>/dev/null)"
	@case ":$$PATH:" in *":$(PREFIX):"*) echo "  ✓ $(PREFIX) 在 PATH 里";; \
	  *) echo "  ! $(PREFIX) 不在 PATH 里，装完要加一行到 ~/.zshrc:"; \
	     echo "      export PATH=\"$(PREFIX):$$PATH\"";; esac
	@[ -d "$(ICLOUD)" ] && echo "  ✓ iCloud Drive 可用" || echo "  ! 没找到 iCloud Drive，库可以放别的地方"
	@command -v rsvg-convert >/dev/null && echo "  ✓ rsvg-convert（make icons 需要）" || echo "  ! 没有 rsvg-convert，make icons 会跳过（brew install librsvg）"

install:
	@echo "→ 装依赖"
	@$(PNPM) install

unlink:
	@rm -f "$(BIN)" && echo "已卸载 $(BIN)"


# ─────────────────────────────────────────────────────────────
#  偶尔
# ─────────────────────────────────────────────────────────────

watch:
	@$(PNPM) test:watch

icons:
	@bash scripts/icons.sh

clean:
	@rm -rf /tmp/kapibala-e2e ui/icon.iconset apps/desktop/dist \
	        apps/desktop/release apps/desktop/.build-bin
	@echo "已清理临时产物"

distclean: clean
	@rm -rf node_modules packages/*/node_modules apps/*/node_modules tsconfig.tsbuildinfo
	@echo "已删除 node_modules"


# ─────────────────────────────────────────────────────────────
#  下面这些一般不直接调用，是上面那些的依赖
# ─────────────────────────────────────────────────────────────

typecheck:
	@echo "→ 类型检查"
	@$(PNPM) typecheck

# deploy 的最后一步：生成指回仓库源码的 wrapper
link:
	@echo "→ 安装 kapi 到 $(BIN)"
	@mkdir -p "$(PREFIX)"
	@printf '#!/bin/sh\n# 由 make deploy 生成，指回仓库源码，改代码立刻生效\n# 换 node 版本时改这里，或设 KAPI_NODE 覆盖\nexec "$${KAPI_NODE:-%s}" "%s" "$$@"\n' "$$(command -v node)" "$(CLI)" > "$(BIN)"
	@chmod +x "$(BIN)"
	@echo "  ✓ $(BIN)"

# 三个 esbuild bundle：主进程 / preload / 渲染进程
desktop-build:
	@echo "→ 构建桌面版"
	@cd apps/desktop && $(PNPM) build
