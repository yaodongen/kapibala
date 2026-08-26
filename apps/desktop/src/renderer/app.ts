/**
 * 渲染进程：纯投影。真相在主进程的 core 里，这里只画和发命令。
 * 看不到 op，也看不到 HLC。
 */
import type { Task } from '@kapibala/core'
import type { Api, VaultState } from '@kapibala/ipc'

declare global { interface Window { kapi: Api } }
const kapi = window.kapi

const DAY = 86400000
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const dayStart = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return +d }
const today = () => dayStart(Date.now())
const weekday = (ts: number) => WD[new Date(ts).getDay()]!
const hhmm = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dayLabel = (ts: number) => {
  const t = today()
  if (ts === t) return '今天'
  if (ts === t + DAY) return '明天'
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** 不做清单，所以是 5 项 */
const VIEWS = [
  { id: 'today', ico: '☀', name: '今天',      sub: () => `${dayLabel(today())} ${weekday(today())}` },
  { id: 'next7', ico: '▤', name: '最近 7 天', sub: () => '按日期分组，逾期置顶' },
  { id: 'all',   ico: '≡', name: '全部任务',  sub: () => '所有未完成的任务' },
  { id: 'done',  ico: '✓', name: '已完成',    sub: () => '最近完成的排在前面' },
  { id: 'trash', ico: '␥', name: '垃圾桶',    sub: () => '删除的任务，可以恢复' },
] as const
type ViewId = typeof VIEWS[number]['id']

let tasks: Task[] = []
let vault: VaultState | null = null
let view: ViewId = 'today'

const alive = () => tasks.filter(t => !t.deleted)
const undone = () => alive().filter(t => !t.completedAt)

function pick(v: ViewId): Task[] {
  const t0 = today()
  if (v === 'today') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY)
  if (v === 'next7') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY * 7)
  if (v === 'all') return undone()
  if (v === 'done') return alive().filter(t => t.completedAt).sort((a, b) => b.completedAt! - a.completedAt!)
  return tasks.filter(t => t.deleted)
}

type Group = { label: string; wd: string; items: Task[]; overdue?: boolean }
function group(list: Task[], v: ViewId): Group[] {
  if (v === 'done' || v === 'trash') return [{ label: '', wd: '', items: list }]
  const t0 = today(), byDay = new Map<number, Task[]>(), over: Task[] = [], none: Task[] = []
  for (const t of list) {
    if (t.startAt === undefined) { none.push(t); continue }
    const d = dayStart(t.startAt)
    if (d < t0) { over.push(t); continue }
    const arr = byDay.get(d) ?? []
    arr.push(t); byDay.set(d, arr)
  }
  const byTime = (a: Task[]) => a.sort((x, y) => (x.startAt ?? 0) - (y.startAt ?? 0))
  const out: Group[] = []
  if (over.length) out.push({ label: '已逾期', wd: '', items: byTime(over), overdue: true })
  for (const d of [...byDay.keys()].sort((a, b) => a - b))
    out.push({ label: dayLabel(d), wd: weekday(d), items: byTime(byDay.get(d)!) })
  if (none.length) out.push({ label: '未安排', wd: '', items: none })
  return out
}

const $ = (id: string) => document.getElementById(id)!

function render() {
  $('nav').innerHTML = VIEWS.map((v, i) => {
    const n = pick(v.id).length
    return (i === 3 ? '<div class="sep"></div>' : '') +
      `<button class="nav ${v.id === view ? 'on' : ''}" data-view="${v.id}">` +
      `<span class="ico">${v.ico}</span>${v.name}${n ? `<span class="n">${n}</span>` : ''}</button>`
  }).join('')

  const v = VIEWS.find(x => x.id === view)!
  $('vtitle').textContent = v.name
  $('vsub').textContent = v.sub()
  ;($('addbar') as HTMLElement).style.display = view === 'done' || view === 'trash' ? 'none' : 'flex'

  $('vault').innerHTML = vault
    ? `<span class="swap">⇅</span><b>${esc(vault.name)}</b><br>` +
      `${esc(vault.path.replace(/^\/Users\/[^/]+/, '~'))}<br>` +
      `${esc(vault.deviceLabel)} · 共 ${vault.health.devices} 台设备`
    : ''

  const notes: string[] = []
  if (vault?.readOnly) notes.push('<div class="banner warn">这个库的格式比当前版本新，已按只读打开</div>')
  if (vault?.forked) notes.push('<div class="banner">这个设备目录不属于本机（库被复制或迁移过），已换用新的设备身份</div>')
  if (vault?.health.incomplete) notes.push('<div class="banner">有文件还没从 iCloud 下载下来，任务可能显示不全，落地后会自动补上</div>')
  if (vault?.health.badLines) notes.push(`<div class="banner">跳过了 ${vault.health.badLines} 行坏数据</div>`)
  $('banner').innerHTML = notes.join('')

  const groups = group(pick(view), view)
  if (!groups.reduce((n, g) => n + g.items.length, 0)) {
    $('list').innerHTML = `<div class="empty"><span class="big">🌿</span>${
      view === 'trash' ? '垃圾桶是空的' : view === 'done' ? '还没有完成的任务' : '没有任务，去泡个澡'}</div>`
    return
  }
  $('list').innerHTML = groups.map(g => `<section class="group">${
    g.label ? `<div class="ghead ${g.overdue ? 'overdue' : ''}">${g.label}${
      g.wd ? `<span class="wd">${g.wd}</span>` : ''}</div>` : ''
  }${g.items.map(row).join('')}</section>`).join('')
}

function row(t: Task): string {
  const time = t.startAt !== undefined && !t.isAllDay ? hhmm(t.startAt) : ''
  const rep = t.repeat ? ({ DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月' })[t.repeat.freq] : ''
  const acts = t.deleted
    ? `<button data-act="task:restore" data-id="${t.id}">恢复</button>`
    : `<button class="del" data-act="task:trash" data-id="${t.id}">删除</button>`
  return `<div class="task ${t.completedAt ? 'is-done' : ''}">
    <button class="box ${t.completedAt ? 'done' : ''}"
            data-act="${t.completedAt ? 'task:uncomplete' : 'task:complete'}" data-id="${t.id}"></button>
    <div class="body"><div class="title">${esc(t.title)}</div>${
      time || rep ? `<div class="meta">${time ? `<span>${time}</span>` : ''}${
        rep ? `<span class="tag">↻ ${rep}</span>` : ''}</div>` : ''}</div>
    <div class="acts">${acts}</div></div>`
}

document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement
  const nav = target.closest<HTMLElement>('[data-view]')
  if (nav) { view = nav.dataset['view'] as ViewId; render(); return }
  const btn = target.closest<HTMLElement>('[data-act]')
  if (!btn) return
  const act = btn.dataset['act'] as 'task:complete' | 'task:uncomplete' | 'task:trash' | 'task:restore'
  await kapi[act](btn.dataset['id']!)
})

// 右键任务：交给主进程弹原生菜单
document.addEventListener('contextmenu', (e) => {
  const box = (e.target as HTMLElement).closest<HTMLElement>('.task')?.querySelector<HTMLElement>('[data-id]')
  if (!box) return
  e.preventDefault()
  void kapi['task:menu'](box.dataset['id']!)
})

const ti = $('newTitle') as HTMLInputElement
const di = $('newDate') as HTMLInputElement
const ri = $('newRepeat') as HTMLSelectElement
ti.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !ti.value.trim()) return
  const at = di.value ? +new Date(`${di.value}T00:00`) : view === 'today' ? today() : undefined
  await kapi['task:create']({
    title: ti.value.trim(),
    ...(at !== undefined ? { startAt: at } : {}),
    ...(ri.value ? { repeat: { freq: ri.value as 'DAILY' } } : {}),
  })
  ti.value = ''; di.value = ''; ri.value = ''
})

/* ── 切换库 ── */
async function openVaultList() {
  const list = await kapi['vault:list']()
  $('vlist').innerHTML = list.map(v => `
    <button class="vrow ${v.available ? '' : 'off'}" data-vault="${v.id}">
      <span class="dot">${v.current ? '●' : ''}</span>
      <span><span class="nm">${esc(v.name)}</span>
        <span class="pt">${esc(v.path.replace(/^\/Users\/[^/]+/, '~'))}</span></span>
      ${v.available ? '' : '<span class="miss">找不到</span>'}
    </button>`).join('')
  ;($('vaultsheet') as HTMLElement).hidden = false
}

async function switchVault(id: string) {
  try {
    vault = await kapi['vault:open'](id)
    tasks = await kapi['task:list']()
    ;($('vaultsheet') as HTMLElement).hidden = true
    view = 'today'
    render()
  } catch (e) {
    // 失败就把原因写在那一行上，别把面板关掉
    const pt = document.querySelector(`[data-vault="${id}"] .pt`) as HTMLElement | null
    if (pt) pt.textContent = `打不开：${(e as Error).message}`
  }
}

$('vault').addEventListener('click', () => void openVaultList())
$('vaultadd').addEventListener('click', async () => {
  const v = await kapi['vault:pick']()
  if (!v) return
  vault = v
  tasks = await kapi['task:list']()
  ;($('vaultsheet') as HTMLElement).hidden = true
  view = 'today'
  render()
})

/* ── 错误日志 ── */
async function openLog() {
  const { text, path } = await kapi['log:read']()
  $('logtext').textContent = text
  $('logpath').textContent = path.replace(/^\/Users\/[^/]+/, '~')
  ;($('logsheet') as HTMLElement).hidden = false
}
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  if (t.closest('[data-log]')) { void openLog(); return }
  const vrow = t.closest<HTMLElement>('[data-vault]')
  if (vrow) { void switchVault(vrow.dataset['vault']!); return }
  if (t.id === 'logclose' || t.id === 'logsheet') ($('logsheet') as HTMLElement).hidden = true
  if (t.id === 'vaultclose' || t.id === 'vaultsheet') ($('vaultsheet') as HTMLElement).hidden = true
})
$('logcopy').addEventListener('click', async () => {
  await kapi['log:copy']()
  const b = $('logcopy'); const old = b.textContent
  b.textContent = '已复制'; setTimeout(() => { b.textContent = old }, 1200)
})
$('logreveal').addEventListener('click', () => void kapi['log:reveal']())

// 渲染进程自己的报错也要进同一份日志，否则用户看到的日志里没有真正的原因
window.addEventListener('error', (e) => {
  void kapi['log:renderer'](`${e.message} @ ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  void kapi['log:renderer'](`未处理的拒绝：${String((e as PromiseRejectionEvent).reason)}`)
})

kapi.onTasksChanged((t) => { tasks = t; render() })

/** 没有库时先讲清楚为什么要选文件夹，再由用户点按钮触发系统对话框 */
function showWelcome(on: boolean) {
  ;($('welcome') as HTMLElement).hidden = !on
  ;(document.querySelector('.app') as HTMLElement).style.visibility = on ? 'hidden' : 'visible'
}

$('pick').addEventListener('click', async () => {
  const hint = $('welcome').querySelector('.hint') as HTMLElement
  const btn = $('pick') as HTMLButtonElement
  try {
    const v = await kapi['vault:pick']()
    // 从 iCloud 同步过来的库可能要等文件落地，这里必须有反馈，否则看着像死了
    btn.disabled = true
    btn.textContent = '正在打开…' 
    if (!v) return                      // 用户取消或选了不能用的目录，留在引导页
    vault = v
    tasks = await kapi['task:list']()
    showWelcome(false)
    render()
    ti.focus()
  } catch (e) {
    // 整段都要包住：不 catch 的话异常烂在这里，用户只看到点了没反应
    hint.textContent = `打不开这个文件夹：${(e as Error).message}`
  } finally {
    btn.disabled = false
    btn.textContent = '选择文件夹…'
  }
})

async function boot() {
  vault = await kapi['vault:state']()
  if (!vault) { showWelcome(true); return }
  tasks = await kapi['task:list']()
  render()
  ti.focus()
}
boot()
