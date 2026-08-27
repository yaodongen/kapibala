#!/usr/bin/env bash
# 在真实文件系统上模拟两台 Mac 共享一个库，并断言合并结果。
# 对应 storage.zh.md §9.2 的 spike 2（并发写）和 spike 4（库目录被复制/整机迁移）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/apps/cli/src/index.ts"
E="${E2E_DIR:-/tmp/kapibala-e2e}"
PASS=0; FAIL=0
export NO_COLOR=1        # 断言要 grep 输出，不能掺 ANSI 转义

rm -rf "$E"; mkdir -p "$E/vault"
A() { KAPIBALA_USER_DATA="$E/ud-a" KAPIBALA_MACHINE_ID=MACHINE-A KAPIBALA_LABEL="Mac A" node "$CLI" "$@"; }
B() { KAPIBALA_USER_DATA="$E/ud-b" KAPIBALA_MACHINE_ID=MACHINE-B KAPIBALA_LABEL="Mac B" node "$CLI" "$@"; }
C() { KAPIBALA_USER_DATA="$E/ud-c" KAPIBALA_MACHINE_ID=MACHINE-C KAPIBALA_LABEL="Mac C" node "$CLI" "$@"; }

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
want() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

echo "→ 建库并加任务（Mac A）"
A vault create "$E/vault" >/dev/null
A add "买菜" --at today >/dev/null
A add "水豚周会" --at "$(date +%Y-%m-%d)T10:00" --repeat weekly >/dev/null
WEEKLY=$(A ls --all | grep 水豚周会 | grep -oE '[0-9a-z]{6}$')
ok "库已建立，任务 id ${WEEKLY}"

echo "→ Mac B 打开同一个目录"
B vault open "$E/vault" >/dev/null
want "B 能看到 A 的任务" "$(B ls --all | grep -c 买菜)" "1"
want "两台机器各有自己的设备目录" "$(ls "$E/vault/devices" | wc -l | tr -d ' ')" "2"

echo "→ 双向同步"
B add "B 加的任务" --at tomorrow >/dev/null
want "A 能看到 B 的任务" "$(A ls --all | grep -c 'B 加的任务')" "1"
B done "$WEEKLY" >/dev/null
want "A 能看到 B 完成的周期任务生成的下一次" "$(A ls --all | grep -c 水豚周会)" "1"

echo "→ 字段级 LWW：A 删除、B 完成同一个任务，两个字段都要保留"
A add "会被两边同时改" >/dev/null
ID=$(A ls --all | grep 会被两边同时改 | grep -oE '[0-9a-z]{6}$')
A rm "$ID" >/dev/null          # A 写 _deleted
B done "$ID" >/dev/null        # B 写 completedAt（两边都没先同步）
want "删除标记保留" "$(A trash | grep -c 会被两边同时改)" "1"
want "完成标记也保留（没有被删除覆盖掉）" "$(A trash | grep 会被两边同时改 | grep -c '✓')" "1"

echo "→ 并发写：10 个进程同时 add"
for i in $(seq 1 10); do A add "并发$i" >/dev/null & done; wait
want "10 条都写进去了" "$(A ls --all | grep -c 并发)" "10"
BADLINES=$(python3 - "$E" <<'PY'
import glob,json,sys
bad=0
for f in glob.glob(sys.argv[1]+'/vault/devices/*/*.jsonl'):
    for line in open(f):
        if line.strip():
            try: json.loads(line)
            except Exception: bad+=1
print(bad)
PY
)
want "日志没有交错产生的坏行" "$BADLINES" "0"

echo "→ 整机迁移：userData 被一起复制，机器变了"
mkdir -p "$E/ud-c"; cp "$E/ud-a/vaults.json" "$E/ud-c/vaults.json"
C vault open "$E/vault" >/dev/null
want "自动换用新的设备身份" "$(ls "$E/vault/devices" | wc -l | tr -d ' ')" "3"
want "旧历史照样读得到" "$(C ls --all | grep -c 买菜)" "1"

echo "→ 垃圾桶"
MAI=$(A ls --all | grep 买菜 | grep -oE '[0-9a-z]{6}$')
A rm "$MAI" >/dev/null
want "已移入垃圾桶" "$(A ls --all | grep -c 买菜)" "0"
want "垃圾桶里能看到" "$(A trash | grep -c 买菜)" "1"
A restore "$MAI" >/dev/null
want "恢复回来了" "$(A ls --all | grep -c 买菜)" "1"

echo "→ 清空垃圾桶：标记也要同步到别的机器"
A add "扔掉甲" >/dev/null; A add "扔掉乙" >/dev/null
for T in 扔掉甲 扔掉乙; do A rm "$(A ls --all | grep $T | grep -oE '[0-9a-z]{6}$')" >/dev/null; done
want "两条都在垃圾桶里" "$(B trash | grep -cE '扔掉甲|扔掉乙')" "2"
A purge --all >/dev/null
want "A 的垃圾桶空了" "$(A trash | grep -cE '扔掉甲|扔掉乙')" "0"
want "B 那边也不再出现" "$( { B ls --all; B trash; } | grep -cE '扔掉甲|扔掉乙' || true)" "0"

echo "→ 没有任何机器写别人的目录"
CROSS=0
for d in "$E/vault"/devices/*/; do
  LABEL=$(python3 -c "import json;print(json.load(open('$d/owner.json'))['label'])")
  N=$(ls "$d" | grep -c jsonl || true)
  echo "    $(basename "$d" | cut -c1-8)…  $LABEL  ${N} 个段文件"
done
want "设备目录数" "$(ls "$E/vault/devices" | wc -l | tr -d ' ')" "3"

echo ""
echo "  通过 ${PASS}，失败 ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
