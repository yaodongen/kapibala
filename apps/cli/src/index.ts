#!/usr/bin/env node
import { Store, describeRepeat, readRegistry, searchTasks, writeRegistry, type Task } from '@kapibala/core'
import { nodeEnv, withLock } from '@kapibala/adapters-node'
import { resolve } from 'node:path'
import { dayStart, hhmm, labelOf, parseWhen, today, weekday } from './dates.ts'

const DAY = 86400000
const env = nodeEnv()
// 管道和重定向里不该出现转义符；NO_COLOR 是通行约定
const color = !!process.stdout.isTTY && !process.env['NO_COLOR']
const C = color
  ? { dim: '\x1b[2m', b: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', brown: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', b: '', red: '', green: '', brown: '', off: '' }
const short = (id: string) => id.slice(-6).toLowerCase()

const HELP = `${C.b}kapi${C.off} —— 卡皮巴拉命令行

  ${C.b}库${C.off}
    kapi vault create <目录>     在空目录里新建一个库
    kapi vault open <目录>       打开已有的库并设为当前库
    kapi vault list              列出所有库
    kapi vault use <名字|路径>    切换当前库
    kapi vault forget <名字|路径> 从列表移出（不删除目录）

  ${C.b}任务${C.off}
    kapi add <标题> [--at 时间] [--repeat daily|weekly|monthly] [--after]
    kapi today                   今天（含逾期）
    kapi ls [--all]              最近 7 天，--all 看全部
    kapi done <id>               完成（周期任务自动生成下一次）
    kapi undone <id>             取消完成
    kapi rm <id>                 删除到垃圾桶
    kapi trash                   看垃圾桶
    kapi restore <id>            从垃圾桶恢复
    kapi purge <id>              彻底删除（列表里不再出现；日志里仍留有痕迹）
    kapi search <关键词>         搜索标题和备注（空格分隔多个词按全部命中）
    kapi doctor                  库和同步状态

  ${C.b}--at 支持${C.off}  today / tomorrow / 明天 / fri / 周五 / +3d / 2026-08-28 / 2026-08-28T19:30 / 19:30
`

function flags(argv: string[]) {
  const out: Record<string, string | true> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const nx = argv[i + 1]
      if (nx && !nx.startsWith('--')) { out[k] = nx; i++ } else out[k] = true
    } else rest.push(a)
  }
  return { flags: out, rest }
}

async function currentVaultPath(): Promise<string> {
  const reg = await readRegistry(env)
  const e = reg.vaults.find(v => v.id === reg.lastVaultId) ?? reg.vaults[0]
  if (!e) throw new Error(`还没有库。先建一个：\n  kapi vault create ~/Library/Mobile\\ Documents/com~apple~CloudDocs/Kapibala`)
  return e.path
}

async function open(): Promise<Store> {
  const s = await Store.open(env, await currentVaultPath())
  if (s.vault.forked)
    console.error(`${C.dim}提示：这个设备目录不属于本机（库被复制或整机迁移过），已换用新的设备身份${C.off}`)
  if (s.vault.readOnly) console.error(`${C.red}这个库的格式比当前版本新，已按只读打开${C.off}`)
  return s
}

/** 逾期置顶，其余按日期升序，未安排垫底 */
function render(list: Task[], opts: { showDone?: boolean; flat?: boolean } = {}) {
  if (!list.length) { console.log(`${C.dim}（空）${C.off}`); return }
  const t0 = today()
  const over: Task[] = [], none: Task[] = [], byDay = new Map<number, Task[]>()
  for (const t of list) {
    if (t.startAt === undefined) { none.push(t); continue }
    const d = dayStart(t.startAt)
    if (d < t0 && !t.completedAt) { over.push(t); continue }
    ;(byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t)
  }
  const groups: Array<[string, Task[], boolean]> = []
  if (over.length) groups.push(['已逾期', over, true])
  for (const d of [...byDay.keys()].sort((a, b) => a - b)) groups.push([labelOf(d), byDay.get(d)!, false])
  if (none.length) groups.push(['未安排', none, false])

  for (const [label, items, danger] of groups) {
    console.log(`\n${danger ? C.red : C.brown}${C.b}${label}${C.off}`)
    for (const t of items.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0))) {
      const box = t.completedAt ? `${C.green}✓${C.off}` : '○'
      const time = t.startAt !== undefined && !t.isAllDay ? ` ${C.dim}${hhmm(t.startAt)}${C.off}` : ''
      const rep = t.repeat ? ` ${C.dim}↻${describeRepeat(t.repeat)}${C.off}` : ''
      const title = t.completedAt && opts.showDone ? `${C.dim}${t.title}${C.off}` : t.title
      console.log(`  ${box} ${title}${time}${rep}  ${C.dim}${short(t.id)}${C.off}`)
    }
  }
  console.log()
}

function resolveId(s: Store, q: string): Task {
  const all = s.tasks()
  const hit = all.filter(t => t.id.toLowerCase().endsWith(q.toLowerCase()) || t.id === q)
  if (!hit.length) throw new Error(`找不到任务：${q}`)
  if (hit.length > 1) throw new Error(`${q} 匹配到 ${hit.length} 个任务，请多给几位`)
  return hit[0]!
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2)
  const { flags: F, rest } = flags(argv)

  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return }

  if (cmd === 'vault') {
    const sub = rest[0]
    if (sub === 'create' || sub === 'open') {
      const dir = resolve(rest[1] ?? '.')
      const s = await Store.open(env, dir, sub === 'create')
      console.log(`${sub === 'create' ? '已新建' : '已打开'}库 ${C.b}${s.vault.entry.name}${C.off}`)
      console.log(`${C.dim}${dir}\n设备 ${short(s.vault.device.deviceId)} · ${s.vault.device.label}${C.off}`)
      return
    }
    if (sub === 'list') {
      const reg = await readRegistry(env)
      if (!reg.vaults.length) { console.log(`${C.dim}还没有库${C.off}`); return }
      for (const v of reg.vaults)
        console.log(`${v.id === reg.lastVaultId ? `${C.green}●${C.off}` : ' '} ${C.b}${v.name}${C.off}  ${C.dim}${v.path}${C.off}`)
      return
    }
    if (sub === 'forget') {
      const q = rest[1] ?? ''
      const reg = await readRegistry(env)
      const v = reg.vaults.find(x => x.name === q || x.path === resolve(q) || x.id.endsWith(q.toUpperCase()))
      if (!v) throw new Error(`找不到库：${q}`)
      reg.vaults = reg.vaults.filter(x => x.id !== v.id)
      if (reg.lastVaultId === v.id) reg.lastVaultId = reg.vaults[0]?.id
      await writeRegistry(env, reg)
      console.log(`已从列表移出 ${C.b}${v.name}${C.off}${C.dim}（目录还在：${v.path}）${C.off}`)
      return
    }
    if (sub === 'use') {
      const q = rest[1] ?? ''
      const reg = await readRegistry(env)
      const v = reg.vaults.find(x => x.name === q || x.path === resolve(q) || x.id.endsWith(q.toUpperCase()))
      if (!v) throw new Error(`找不到库：${q}`)
      reg.lastVaultId = v.id
      await writeRegistry(env, reg)
      console.log(`当前库 → ${C.b}${v.name}${C.off}`)
      return
    }
    console.log(HELP); return
  }

  const s = await open()
  const vaultId = s.vault.entry.id
  const alive = () => s.tasks().filter(t => !t.deleted)
  const undone = () => alive().filter(t => !t.completedAt)

  switch (cmd) {
    case 'add': {
      const title = rest.join(' ').trim()
      if (!title) throw new Error('要加什么？例：kapi add "买菜" --at tomorrow')
      const when = typeof F['at'] === 'string' ? parseWhen(F['at']) : null
      if (F['at'] && !when) throw new Error(`看不懂的时间：${F['at']}`)
      const freq = typeof F['repeat'] === 'string'
        ? ({ daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' } as const)[F['repeat'].toLowerCase()]
        : undefined
      if (F['repeat'] && !freq) throw new Error('--repeat 只支持 daily / weekly / monthly')
      const id = await withLock(vaultId, () => s.add({
        title,
        ...(when ? { startAt: when.at, isAllDay: when.allDay } : {}),
        ...(freq ? { repeat: { freq, mode: F['after'] ? 'afterCompletion' : 'fixed' } } : {}),
      }))
      const t = s.task(id)!
      console.log(`${C.green}+${C.off} ${t.title}${t.startAt !== undefined ? `  ${C.dim}${labelOf(t.startAt)}${t.isAllDay ? '' : ' ' + hhmm(t.startAt)}${C.off}` : ''}  ${C.dim}${short(id)}${C.off}`)
      return
    }
    case 'today':
      render(undone().filter(t => t.startAt !== undefined && t.startAt < today() + DAY))
      return
    case 'ls': {
      const list = F['all'] ? undone()
        : undone().filter(t => t.startAt !== undefined && t.startAt < today() + DAY * 7)
      render(list)
      return
    }
    case 'done': {
      const t = resolveId(s, rest[0] ?? '')
      const next = await withLock(vaultId, () => s.complete(t.id))
      console.log(`${C.green}✓${C.off} ${t.title}`)
      if (next) console.log(`${C.dim}↻ 下一次：${labelOf(next.startAt!)}  ${short(next.id)}${C.off}`)
      return
    }
    case 'undone': {
      const t = resolveId(s, rest[0] ?? '')
      await withLock(vaultId, () => s.uncomplete(t.id))
      console.log(`○ ${t.title}`)
      return
    }
    case 'rm': {
      const t = resolveId(s, rest[0] ?? '')
      await withLock(vaultId, () => s.trash(t.id))
      console.log(`${C.dim}已移入垃圾桶：${t.title}（kapi restore ${short(t.id)} 可恢复）${C.off}`)
      return
    }
    case 'purge': {
      const t = resolveId(s, rest[0] ?? '')
      await withLock(vaultId, () => s.purge(t.id))
      console.log(`${C.dim}已彻底删除：${t.title}（列表里不再出现，但日志里仍留有痕迹 —— 存储层永不物理删除）${C.off}`)
      return
    }
    case 'restore': {
      const t = resolveId(s, rest[0] ?? '')
      await withLock(vaultId, () => s.restore(t.id))
      console.log(`已恢复：${t.title}`)
      return
    }
    case 'trash': render(s.tasks().filter(t => t.deleted), { showDone: true }); return
    case 'done-list': render(alive().filter(t => t.completedAt), { showDone: true }); return
    case 'search': {
      const q = rest.join(' ').trim()
      if (!q) throw new Error('搜什么？例：kapi search 周报')
      const hit = searchTasks(alive(), q)
      console.log(`${C.dim}“${q}” 命中 ${hit.length} 条${C.off}`)
      render(hit, { showDone: true })
      return
    }
    case 'doctor': {
      const h = s.health
      console.log(`库    ${C.b}${s.vault.entry.name}${C.off}  ${C.dim}${s.vault.entry.path}${C.off}`)
      console.log(`设备  ${short(s.vault.device.deviceId)} · ${s.vault.device.label}  ${C.dim}(共 ${h.devices} 台)${C.off}`)
      console.log(`任务  ${alive().length} 个未删除，其中 ${undone().length} 个未完成`)
      console.log(`健康  ${h.badLines ? `${C.red}${h.badLines} 行坏数据${C.off}` : '日志正常'}` +
                  `${h.droppedTail ? `${C.dim}（丢弃了一行未写完的尾行）${C.off}` : ''}` +
                  `${h.incomplete ? ` ${C.red}有文件读不出来，历史可能不完整${C.off}` : ''}`)
      return
    }
    default:
      console.log(`未知命令：${cmd}\n`); console.log(HELP)
  }
}

main().catch(e => { console.error(`${C.red}${e.message}${C.off}`); process.exit(1) })
