/**
 * 渲染进程：纯投影。真相在主进程的 core 里，这里只画和发命令。
 * 看不到 op，也看不到 HLC。
 */
import type { Task } from '@kapibala/core'
// 只从子路径引这个纯函数：渲染进程是 browser 目标，不能碰 core 里用到 node:crypto 的部分
import { notePreview, renderMarkdown } from '@kapibala/core/markdown'
import { describeRepeat, presetsFor } from '@kapibala/core/rrule'
import { matchContext, searchTasks } from '@kapibala/core/search'
import type { Api, VaultState } from '@kapibala/ipc'
import { t as dict, type Lang, type Strings } from '../i18n.ts'

declare global { interface Window { kapi: Api } }
const kapi = window.kapi

/**
 * 界面语言。主进程说了算（它知道系统语言，也存着用户改过的选择），
 * 这里只是拿到手就用。所有文案都在 render() 时取，切换语言不用重启窗口。
 */
let lang: Lang = 'zh'
let S: Strings = dict('zh')

const DAY = 86400000
const dayStart = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return +d }
const today = () => dayStart(Date.now())
const weekday = (ts: number) => S.weekdays[new Date(ts).getDay()]!
/** 中文界面用 24 小时制；英文界面跟英文的习惯，交给 Intl 去排 */
const hhmm = (ts: number) => {
  const d = new Date(ts)
  if (lang === 'en') return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dayLabel = (ts: number) => {
  const t = today()
  if (ts === t) return S.dayToday
  if (ts === t + DAY) return S.dayTomorrow
  return S.dayLabel(new Date(ts))
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** 不做清单，所以是 5 项。名字和副标题都从字典取，键名和视图 id 对齐 */
const VIEWS = [
  { id: 'today', ico: '☀', sub: () => S.todaySub(dayLabel(today()), weekday(today())) },
  { id: 'next7', ico: '▤', sub: () => S.next7Sub },
  { id: 'all',   ico: '≡', sub: () => S.allSub },
  { id: 'done',  ico: '✓', sub: () => S.doneSub },
  { id: 'trash', ico: '␥', sub: () => S.trashSub },
] as const
type ViewId = typeof VIEWS[number]['id']

let tasks: Task[] = []
let vault: VaultState | null = null
let view: ViewId = 'today'
/** 右侧详情栏选中的任务；备注是否处于编辑态 */
let selected: string | null = null
let editing = false
let query = ''            // 搜索词，非空时列表切成搜索结果
let titleEditing: string | null = null   // 列表里正在就地改标题的那条
/**
 * boot() 拿到库状态之前不许画。主进程在 did-finish-load 时就推了一次任务，
 * 那时 vault 还是 null，"上次选中的任务"读不出来，会选错成列表第一条 ——
 * 而 ensureSelection 之后就不会再改主意了。
 */
let ready = false

/**
 * 上次选中的任务由主进程存在 userData 里（不用 localStorage：Chromium 的刷盘时机
 * 不可控，退出得快就丢了）。这是本机的界面状态，不进库目录、不跟着 iCloud 同步。
 */
function remember(id: string) {
  if (vault) vault = { ...vault, lastTask: id }
  void kapi['ui:lastTask'](id)
}
const recall = (): string | null => vault?.lastTask ?? null

/** 备注栏常驻，所以永远要有个选中项：优先上次选中的，否则当前视图的第一条 */
function ensureSelection(visible: Task[]) {
  if (selected && tasks.some(t => t.id === selected)) return
  const last = recall()
  const chosen = (last ? tasks.find(t => t.id === last) : undefined) ?? visible[0]
  selected = chosen?.id ?? null
  editing = false        // 自动选中不该直接进编辑，否则一启动就抢走输入焦点
}

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
  if (over.length) out.push({ label: S.overdue, wd: '', items: byTime(over), overdue: true })
  for (const d of [...byDay.keys()].sort((a, b) => a - b))
    out.push({ label: dayLabel(d), wd: weekday(d), items: byTime(byDay.get(d)!) })
  if (none.length) out.push({ label: S.unscheduled, wd: '', items: none })
  return out
}

const $ = (id: string) => document.getElementById(id)!

/**
 * index.html 里写死的那几十个字。语言一变就整块重刷，
 * 否则会留下半中半英的界面。
 */
function applyStatic() {
  document.documentElement.lang = S.htmlLang
  const text: Array<[string, string]> = [
    ['brandname', S.brand], ['logbtn', S.viewLog], ['langbtn', S.langOther],
    ['welcomelang', S.langOther],
    ['welcometitle', S.welcomeTitle], ['pick', S.welcomePick],
    ['welcomehint', S.welcomeHint], ['welcomelog', S.welcomeLog],
    ['dlabel', S.notesLabel],
    ['vaultsheettitle', S.vaultSheetTitle], ['vaultadd', S.vaultOpenOther],
    ['vaultforgetnote', S.vaultForgetNote], ['vaultclose', S.close],
    ['logsheettitle', S.logTitle], ['logcopy', S.logCopy],
    ['logreveal', S.logReveal], ['logclose', S.close],
  ]
  for (const [id, v] of text) $(id).textContent = v
  // 这三句里有 <b>，是字典里写好的、不含用户输入的片段
  for (const [id, v] of [['welcomesync', S.welcomeSync], ['welcomelocal', S.welcomeLocal],
                         ['welcomeundo', S.welcomeUndo]] as Array<[string, string]>)
    $(id).innerHTML = v
  ;($('search') as HTMLInputElement).placeholder = S.searchPlaceholder
  ;($('newTitle') as HTMLInputElement).placeholder = S.addPlaceholder
  ;($('dtitle') as HTMLInputElement).placeholder = S.titlePlaceholder
  document.querySelectorAll<HTMLElement>('[data-lang]').forEach(el => { el.title = S.langSwitchTip })
  // 空备注的占位文字在 CSS 的 ::before 里，只能靠变量递进去
  document.documentElement.style.setProperty('--md-empty', JSON.stringify(S.notesEmpty))
}

/** 换语言不用重启窗口：文案都是 render() 时才取的 */
function setLang(next: Lang) {
  lang = next
  S = dict(next)
  applyStatic()
  syncNewRepeat()
}

/**
 * 重复规则的下拉。选项由日期推出来 —— "每月第二个周二""每年 8 月 26 日"
 * 这些描述离开具体日期就没法生成。
 */
function repeatSelect(id: string, at: number, current?: Task['repeat']): string {
  const cur = current?.rrule ?? (current ? describeRepeat(current, lang) : '')
  const opts = presetsFor(at, lang)
  const known = opts.some(o => o.rrule === cur)
  return `<select id="${id}">` +
    `<option value="">${esc(S.noRepeat)}</option>` +
    // 旧数据（0.0.x 的 {freq} 形状）或手写的规则：原样列出来，别把它悄悄改掉
    (current && !known ? `<option value="${esc(cur)}" selected>${esc(describeRepeat(current, lang))}</option>` : '') +
    opts.map(o => `<option value="${esc(o.rrule)}"${o.rrule === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('') +
    `</select>`
}

function render() {
  $('nav').innerHTML = VIEWS.map((v, i) => {
    const n = pick(v.id).length
    return (i === 3 ? '<div class="sep"></div>' : '') +
      `<button class="nav ${v.id === view ? 'on' : ''}" data-view="${v.id}">` +
      `<span class="ico">${v.ico}</span>${esc(S[v.id])}${n ? `<span class="n">${n}</span>` : ''}</button>`
  }).join('')

  const v = VIEWS.find(x => x.id === view)!
  const results = query.trim() ? searchTasks(alive(), query) : null
  $('vtitle').textContent = results ? S.searchTitle : S[v.id]
  $('vsub').textContent = results ? S.searchSub(query.trim(), results.length) : v.sub()
  ;($('addbar') as HTMLElement).style.display = view === 'done' || view === 'trash' ? 'none' : 'flex'

  // 默认只显示库名。路径和设备信息挪到 hover 的提示里，不必常驻占三行
  $('vault').innerHTML = vault ? `<b>${esc(vault.name)}</b><span class="swap">⇅</span>` : ''
  ;($('vault') as HTMLElement).title = vault
    ? S.vaultTip(vault.path, vault.deviceLabel, vault.health.devices)
    : S.vaultSwitch

  const notes: string[] = []
  if (vault?.readOnly) notes.push(`<div class="banner warn">${esc(S.bannerReadOnly)}</div>`)
  if (vault?.forked) notes.push(`<div class="banner">${esc(S.bannerForked)}</div>`)
  if (vault?.health.incomplete) notes.push(`<div class="banner">${esc(S.bannerIncomplete)}</div>`)
  if (vault?.health.badLines) notes.push(`<div class="banner">${esc(S.bannerBadLines(vault.health.badLines))}</div>`)
  $('banner').innerHTML = notes.join('')

  const visible = results ?? pick(view)
  ensureSelection(visible)
  const groups = results
    ? [{ label: '', wd: '', items: results }]     // 搜索结果按相关度排，不按日期分组
    : group(visible, view)
  if (!groups.reduce((n, g) => n + g.items.length, 0)) {
    $('list').innerHTML = `<div class="empty"><span class="big">🌿</span>${esc(
      results ? S.emptySearch
      : view === 'trash' ? S.emptyTrash : view === 'done' ? S.emptyDone : S.emptyList)}</div>`
    renderDetail()
    return
  }
  renderDetail()
  $('list').innerHTML = groups.map(g => `<section class="group">${
    g.label ? `<div class="ghead ${g.overdue ? 'overdue' : ''}">${g.label}${
      g.wd ? `<span class="wd">${g.wd}</span>` : ''}</div>` : ''
  }${g.items.map(row).join('')}</section>`).join('')
}

function row(t: Task): string {
  // 有具体时间就带上周几："周三 18:00"。列表里不分组的视图（全部/搜索）尤其需要
  const time = t.startAt !== undefined && !t.isAllDay
    ? `${weekday(t.startAt)} ${hhmm(t.startAt)}` : ''
  const rep = t.repeat ? describeRepeat(t.repeat, lang) : ''
  const first = query.trim()
    ? (t.notes?.trim() ? matchContext(t, query, 46) : '')
    : (t.notes?.trim() ? notePreview(t.notes, 46) : '')
  return `<div class="task ${t.completedAt ? 'is-done' : ''} ${t.id === selected ? 'sel' : ''}"
               data-task="${t.id}">
    <button class="box ${t.completedAt ? 'done' : ''}"
            data-act="${t.completedAt ? 'task:uncomplete' : 'task:complete'}" data-id="${t.id}"></button>
    <div class="body">${titleEditing === t.id
      ? `<input class="titleedit" data-titleedit="${t.id}" value="${esc(t.title)}">`
      : `<div class="title">${esc(t.title)}</div>`}${
      rep ? `<div class="meta"><span class="tag">↻ ${rep}</span></div>` : ''}${
      first ? `<div class="notefirst">${esc(first)}</div>` : ''}</div>${
    time ? `<div class="when">${time}</div>` : ''}
  </div>`
}

/** 右侧详情栏。点任务打开，展示标题、时间和备注 */
function renderDetail() {
  const t = selected ? tasks.find(x => x.id === selected) : undefined
  if (!t) { selected = null; editing = false }
  if (!t) {                                   // 备注栏常驻，没选中就显示提示
    $('dtitle').textContent = ''
    $('dmeta').innerHTML = ''
    $('dbody').innerHTML = `<div class="dempty">${S.notesNoSelection}</div>`
    return
  }

  ;($('dtitle') as HTMLInputElement).value = t.title
  const d = t.startAt !== undefined ? new Date(t.startAt) : null
  const iso = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''
  const bits: string[] = []
  // 重复规则做成下拉，已创建的任务也能改
  if (t.completedAt) bits.push(S.isDone)
  if (t.deleted) bits.push(S.isTrashed)
  // 日期和时间可以直接改；清空日期就是"未安排"
  $('dmeta').innerHTML =
    `<input type="date" id="ddate" value="${iso}">` +
    `<input type="time" id="dtime" value="${d && !t.isAllDay ? hhmm(t.startAt!) : ''}">` +
    (d ? `<button class="dclear" id="dclear" title="${esc(S.clearTip)}">${esc(S.clear)}</button>` : '') +
    repeatSelect('drepeat', t.startAt ?? today(), t.repeat) +
    bits.map(b => `<span>${esc(b)}</span>`).join('')

  $('dbody').innerHTML = editing
    ? `<textarea class="noteedit" data-noteedit="${t.id}"
         placeholder="${esc(S.notesEditPlaceholder)}">${esc(t.notes ?? '')}</textarea>
       <div class="notehint">${esc(S.notesHint)}</div>`
    : `<div class="md" data-noteview="${t.id}">${renderMarkdown(t.notes ?? '')}</div>`
}

document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement
  const nav = target.closest<HTMLElement>('[data-view]')
  if (nav) { view = nav.dataset['view'] as ViewId; render(); return }
  if (target.id === 'dclear' && selected) {
    void kapi['task:setField'](selected, 'startAt', null); return
  }
  const noteview = target.closest<HTMLElement>('[data-noteview]')
  if (noteview && !(target instanceof HTMLAnchorElement)) {
    editing = true; render(); focusEditor(); return
  }
  const taskRow = target.closest<HTMLElement>('[data-task]')
  if (taskRow && !target.closest('[data-act]')) {
    const id = taskRow.dataset['task']!
    selected = id
    remember(id)
    if (target.closest('.title')) {
      // 点标题就地改标题，此时别把焦点让给备注编辑框
      titleEditing = id
      editing = false
      render()
      const el = document.querySelector<HTMLInputElement>('[data-titleedit]')
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
      return
    }
    titleEditing = null
    // 还没写过备注就直接进编辑，省一次点击
    editing = !tasks.find(t => t.id === id)?.notes?.trim()
    render(); focusEditor(); return
  }
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

function focusEditor() {
  const el = document.querySelector<HTMLTextAreaElement>('[data-noteedit]')
  if (!el) return
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
}

async function saveNote(el: HTMLTextAreaElement) {
  // render() 把 textarea 从 DOM 摘掉时会再触发一次 focusout，
  // 不打标记的话"取消"会被当成"保存"写进日志
  if (el.dataset['closed']) return
  el.dataset['closed'] = '1'
  const id = el.dataset['noteedit']!
  const next = el.value
  const prev = tasks.find(t => t.id === id)?.notes ?? ''
  editing = false
  if (next !== prev) await kapi['task:setField'](id, 'notes', next)   // 不变就不写 op
  else render()
}

document.addEventListener('keydown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLTextAreaElement>('[data-noteedit]')
  if (!el) return
  if (e.key === 'Escape') { e.preventDefault(); el.dataset['closed'] = '1'; editing = false; render() }
  // ⌘↩ 保存。单独的回车留给换行，备注是多行的
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveNote(el) }
})
// 点到别处也保存，别让用户白写一段
document.addEventListener('focusout', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLTextAreaElement>('[data-noteedit]')
  if (el) void saveNote(el)
})

/** 添加栏的重复下拉：选项跟着所选日期走，没选就按今天 */
function syncNewRepeat() {
  const at = di.value ? +new Date(`${di.value}T00:00`) : today()
  const keep = ri.value
  ri.innerHTML = `<option value="">${esc(S.noRepeat)}</option>` +
    presetsFor(at, lang).map(o => `<option value="${o.rrule}">${esc(o.label)}</option>`).join('')
  ri.value = keep && Array.from(ri.options).some(o => o.value === keep) ? keep : ''
}

const ti = $('newTitle') as HTMLInputElement
const di = $('newDate') as HTMLInputElement
const ri = $('newRepeat') as HTMLSelectElement
ti.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !ti.value.trim()) return
  const at = di.value ? +new Date(`${di.value}T00:00`) : today()   // 没选日期就是今天
  await kapi['task:create']({
    title: ti.value.trim(),
    startAt: at,
    ...(ri.value ? { repeat: { rrule: ri.value } } : {}),
  })
  ti.value = ''; di.value = ''; ri.value = ''
  syncNewRepeat()
})

/* ── 切换库 ── */
async function openVaultList() {
  const list = await kapi['vault:list']()
  $('vlist').innerHTML = list.map(v => `
    <button class="vrow ${v.available ? '' : 'off'}" data-vault="${v.id}">
      <span class="dot">${v.current ? '●' : ''}</span>
      <span><span class="nm">${esc(v.name)}</span>
        <span class="pt">${esc(v.path.replace(/^\/Users\/[^/]+/, '~'))}</span></span>
      ${v.available ? '' : `<span class="miss">${esc(S.vaultMissing)}</span>`}
      <span class="forget" data-forget="${v.id}" role="button"
            aria-label="${esc(S.vaultForget)}" title="${esc(S.vaultForgetTip)}">✕</span>
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
    if (pt) pt.textContent = S.vaultCantOpen((e as Error).message)
  }
}

async function forgetVault(id: string) {
  const state = await kapi['vault:forget'](id)
  vault = state
  tasks = state ? await kapi['task:list']() : []
  if (!state) {                       // 一个库都不剩了，回到引导页
    ;($('vaultsheet') as HTMLElement).hidden = true
    showWelcome(true)
    return
  }
  await openVaultList()               // 重新拉一次列表，标记也跟着更新
  render()
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

/** 详情栏里的标题就地编辑。回车或失焦保存，esc 还原；不接受清空 */
async function saveTitle() {
  const el = $('dtitle') as HTMLInputElement
  const id = selected
  if (!id) return
  const t = tasks.find(x => x.id === id)
  const next = el.value.trim()
  if (!t || next === t.title) return
  if (!next) { el.value = t.title; return }     // 没有标题的任务只会让人困惑
  await kapi['task:setField'](id, 'title', next)
}

$('dtitle').addEventListener('keydown', (e) => {
  const el = e.target as HTMLInputElement
  // 回车直接保存，不绕 blur —— 那条路依赖焦点状态，边界情况下会静默不保存
  if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void saveTitle(); el.blur() }
  if ((e as KeyboardEvent).key === 'Escape') {
    const t = tasks.find(x => x.id === selected)
    if (t) el.value = t.title
    el.blur()
  }
})
$('dtitle').addEventListener('blur', () => void saveTitle())

/** 列表里就地改标题。和详情栏那个走同一条写入路径，规则也一样：不接受清空 */
async function saveRowTitle(el: HTMLInputElement) {
  if (el.dataset['closed']) return          // render() 摘掉元素时会再触发一次 blur
  el.dataset['closed'] = '1'
  const id = el.dataset['titleedit']!
  const next = el.value.trim()
  const t = tasks.find(x => x.id === id)
  titleEditing = null
  if (!t || !next || next === t.title) { render(); return }
  await kapi['task:setField'](id, 'title', next)
}

document.addEventListener('keydown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('[data-titleedit]')
  if (!el) return
  if (e.key === 'Enter') { e.preventDefault(); void saveRowTitle(el) }
  if (e.key === 'Escape') { e.preventDefault(); el.dataset['closed'] = '1'; titleEditing = null; render() }
})
document.addEventListener('focusout', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('[data-titleedit]')
  if (el) void saveRowTitle(el)
})

/** 详情栏里改日期/时间。空日期 = 未安排；没填时间 = 全天 */
async function saveWhen() {
  if (!selected) return
  const date = ($('ddate') as HTMLInputElement).value
  const time = ($('dtime') as HTMLInputElement).value
  if (!date) { await kapi['task:setField'](selected, 'startAt', null); return }
  const at = +new Date(`${date}T${time || '00:00'}`)
  await kapi['task:setField'](selected, 'startAt', at)
  await kapi['task:setField'](selected, 'isAllDay', !time)
}

document.addEventListener('change', (e) => {
  const el = e.target as HTMLElement
  if (el.id === 'ddate' || el.id === 'dtime') void saveWhen()
  if (el.id === 'drepeat' && selected) {
    const v = (el as HTMLSelectElement).value
    void kapi['task:setField'](selected, 'repeat', v ? { rrule: v } : null)
  }
  if (el.id === 'newDate') syncNewRepeat()      // 换了日期，预设跟着变
})

/* ── 日志 ── */
async function openLog() {
  const { text, path } = await kapi['log:read']()
  $('logtext').textContent = text
  $('logpath').textContent = path.replace(/^\/Users\/[^/]+/, '~')
  ;($('logsheet') as HTMLElement).hidden = false
}
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  if (t.closest('[data-log]')) { void openLog(); return }
  const forget = t.closest<HTMLElement>('[data-forget]')
  if (forget) { void forgetVault(forget.dataset['forget']!); return }   // 别顺带触发切换
  const vrow = t.closest<HTMLElement>('[data-vault]')
  if (vrow) { void switchVault(vrow.dataset['vault']!); return }
  if (t.id === 'logclose' || t.id === 'logsheet') ($('logsheet') as HTMLElement).hidden = true
  if (t.id === 'vaultclose' || t.id === 'vaultsheet') ($('vaultsheet') as HTMLElement).hidden = true
})
$('logcopy').addEventListener('click', async () => {
  await kapi['log:copy']()
  const b = $('logcopy'); const old = b.textContent
  b.textContent = S.logCopied; setTimeout(() => { b.textContent = old }, 1200)
})
$('logreveal').addEventListener('click', () => void kapi['log:reveal']())

/**
 * 语言按钮上写的是"要切过去的那个语言"，一眼就知道点了会变成什么。
 * 引导页上也有一个 —— 还没选库的时候侧边栏是藏起来的，否则中文系统上的
 * 英文用户第一屏就没有出路。
 */
document.addEventListener('click', async (e) => {
  if (!(e.target as HTMLElement).closest('[data-lang]')) return
  setLang(await kapi['ui:setLang'](lang === 'zh' ? 'en' : 'zh'))
  render()
})

// 渲染进程自己的报错也要进同一份日志，否则用户看到的日志里没有真正的原因
window.addEventListener('error', (e) => {
  void kapi['log:renderer'](`${e.message} @ ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  void kapi['log:renderer'](`未处理的拒绝：${String((e as PromiseRejectionEvent).reason)}`)   // 日志是给开发者看的，不翻译
})

const si = $('search') as HTMLInputElement
si.addEventListener('input', () => { query = si.value; render() })
si.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { si.value = ''; query = ''; render() }
})

kapi.onTasksChanged((t) => { tasks = t; if (ready) render() })
kapi.onShowTask((id) => {                       // 右键菜单里选了"备注"
  selected = id
  remember(id)
  editing = !tasks.find(t => t.id === id)?.notes?.trim()
  render(); focusEditor()
})

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
    btn.textContent = S.welcomeOpening
    if (!v) return                      // 用户取消或选了不能用的目录，留在引导页
    vault = v
    tasks = await kapi['task:list']()
    showWelcome(false)
    render()
    ti.focus()
  } catch (e) {
    // 整段都要包住：不 catch 的话异常烂在这里，用户只看到点了没反应
    hint.textContent = S.welcomeFailed((e as Error).message)
  } finally {
    btn.disabled = false
    btn.textContent = S.welcomePick
  }
})

async function boot() {
  setLang(await kapi['ui:lang']())
  vault = await kapi['vault:state']()
  ready = true
  if (!vault) { showWelcome(true); return }
  tasks = await kapi['task:list']()
  render()
  ti.focus()
}
boot()
