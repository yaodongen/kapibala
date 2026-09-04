/**
 * 渲染进程：纯投影。真相在主进程的 core 里，这里只画和发命令。
 * 看不到 op，也看不到 HLC。
 */
import type { Task } from '@kapibala/core'
// 只从子路径引这个纯函数：渲染进程是 browser 目标，不能碰 core 里用到 node:crypto 的部分
import { notePreview, renderMarkdown } from '@kapibala/core/markdown'
import { describeRepeat, describeRrule, presetsFor } from '@kapibala/core/rrule'
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
/**
 * <input type=time> 的 value 只认 24 小时制的 HH:mm。给人看的格式（英文是
 * "7:30 PM"）塞进去会被浏览器判成非法值、整个框变空 —— 于是详情栏看不到时间，
 * 一改日期还会被当成"没填时间"存成全天。两种格式必须分开。
 */
const hhmm24 = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 列表里给人看的时间：中文 24 小时制，英文跟英文的习惯 */
const hhmm = (ts: number) => lang === 'en'
  ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  : hhmm24(ts)
const dayLabel = (ts: number) => {
  const t = today()
  if (ts === t) return S.dayToday
  if (ts === t + DAY) return S.dayTomorrow
  return S.dayLabel(new Date(ts))
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** 不做清单，所以就这 6 项。名字和副标题都从字典取，键名和视图 id 对齐 */
const VIEWS = [
  { id: 'today', ico: '☀', sub: () => S.todaySub(dayLabel(today()), weekday(today())) },
  { id: 'next7', ico: '▤', sub: () => S.next7Sub },
  { id: 'next30', ico: '▦', sub: () => S.next30Sub },
  { id: 'all',   ico: '≡', sub: () => S.allSub },
  { id: 'done',  ico: '✓', sub: () => S.doneSub },
  { id: 'trash', ico: '␥', sub: () => S.trashSub },
] as const
type ViewId = typeof VIEWS[number]['id']

let tasks: Task[] = []
let vault: VaultState | null = null
/** 打开就停在这个视图：只看今天容易漏掉马上要到的事，一周的视野更实用 */
const DEFAULT_VIEW: ViewId = 'next7'
let view: ViewId = DEFAULT_VIEW
/** 右侧详情栏选中的任务；备注是否处于编辑态 */
let selected: string | null = null
let editing = false
let query = ''            // 搜索词，非空时列表切成搜索结果
let titleEditing: string | null = null   // 列表里正在就地改标题的那条
/** 选了"自定义天数…"之后，在哪个下拉旁边展开输入框 */
let customFor: 'detail' | 'new' | null = null
/** 点开备注时算好的光标位置，交给 focusEditor 用一次 */
let pendingNoteCaret: number | null = null
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

/**
 * 刚勾完的那条先留一秒再消失：一是看得清"确实勾上了"，二是手滑点错还来得及
 * 再点一下退回去。留在这个表里的任务，视图筛选时当作"还没变"处理。
 */
const LINGER = 450
const leaving = new Map<string, ReturnType<typeof setTimeout>>()
// 淡出动画的时长跟着这个常量走，免得两边各写一个数、改一处忘一处
document.documentElement.style.setProperty('--linger', `${LINGER}ms`)
function linger(id: string) {
  clearTimeout(leaving.get(id))
  leaving.set(id, setTimeout(() => { leaving.delete(id); render() }, LINGER))
}

const alive = () => tasks.filter(t => !t.deleted)
const undone = () => alive().filter(t => !t.completedAt || leaving.has(t.id))

function pick(v: ViewId): Task[] {
  const t0 = today()
  if (v === 'today') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY)
  if (v === 'next7') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY * 7)
  if (v === 'next30') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY * 30)
  if (v === 'all') return undone()
  // 已完成视图里取消勾选也一样，先留一秒
  if (v === 'done') return alive().filter(t => t.completedAt || leaving.has(t.id))
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
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
    ['synctitle', S.syncTitle], ['syncsub', S.syncSub],
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
/** 选中它就展开一个输入框，让用户自己填天数 —— "每 17 天"这种预设列不完 */
const CUSTOM = '__custom__'
const dailyEvery = (n: number) => `FREQ=DAILY;INTERVAL=${n}`
/** 已经是"每 N 天"的规则，把 N 取出来当输入框的默认值 */
function everyDays(rrule: string | undefined): number | null {
  const m = /^FREQ=DAILY;INTERVAL=(\d+)$/.exec(rrule ?? '')
  return m ? Number(m[1]) : null
}

/** 「每 [17] 天」这一小段。中英文里数字的位置不一样，所以前后缀都从字典取 */
function customDays(id: string, value: number | null): string {
  return `<span class="customdays">${esc(S.customEvery)}` +
    `<input type="number" min="1" max="999" id="${id}" title="${esc(S.customDaysTip)}"` +
    ` placeholder="17" value="${value ?? ''}">${esc(S.customDaysUnit)}</span>`
}

function repeatSelect(id: string, at: number, current?: Task['repeat']): string {
  const cur = current?.rrule ?? (current ? describeRepeat(current, lang) : '')
  const opts = presetsFor(at, lang)
  const known = opts.some(o => o.rrule === cur)
  return `<select id="${id}">` +
    `<option value="">${esc(S.noRepeat)}</option>` +
    // 旧数据（0.0.x 的 {freq} 形状）、手写的规则、自己填的天数：原样列出来，别把它悄悄改掉
    (current && !known ? `<option value="${esc(cur)}" selected>${esc(describeRepeat(current, lang))}</option>` : '') +
    opts.map(o => `<option value="${esc(o.rrule)}"${o.rrule === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('') +
    `<option value="${CUSTOM}">${esc(S.repeatCustom)}</option>` +
    `</select>`
}

/**
 * 列表一重建，正在就地编辑的那个标题框就会被换掉 —— 打了一半的字、光标位置全没。
 * 重建前先记下来，重建后补回去。（触发重建的可能是自己的保存、别的 Mac 同步过来的
 * 改动、勾完那一秒的定时器……不能指望"重建不会发生"）
 */
function keepTitleEdit(): (() => void) {
  const el = document.querySelector<HTMLInputElement>('[data-titleedit]')
  if (!el || el.dataset['titleedit'] !== titleEditing) return () => {}
  const value = el.value
  const at = el.selectionStart ?? value.length
  const focused = document.activeElement === el
  // 这一次消失是重画造成的，不是用户离开输入框 —— 打上标记，别让 focusout
  // 把它当成"编辑结束"（那会顺手把 titleEditing 清掉，编辑框当场没）。
  // 内容和光标都会原样搬到新的输入框里，什么都不会丢
  el.dataset['closed'] = '1'
  return () => {
    const next = document.querySelector<HTMLInputElement>(`[data-titleedit="${titleEditing}"]`)
    if (!next) return
    next.value = value
    if (focused) { next.focus(); next.setSelectionRange(at, at) }
  }
}

function render() {
  const restoreTitleEdit = keepTitleEdit()
  $('nav').innerHTML = VIEWS.map((v, i) => {
    const n = pick(v.id).length
    return (i === 4 ? '<div class="sep"></div>' : '') +
      `<button class="nav ${v.id === view ? 'on' : ''}" data-view="${v.id}">` +
      `<span class="ico">${v.ico}</span>${esc(S[v.id])}${n ? `<span class="n">${n}</span>` : ''}</button>`
  }).join('')

  const v = VIEWS.find(x => x.id === view)!
  const results = query.trim() ? searchTasks(alive(), query) : null
  $('vtitle').textContent = results ? S.searchTitle : S[v.id]
  $('vsub').textContent = results ? S.searchSub(query.trim(), results.length) : v.sub()
  ;($('addbar') as HTMLElement).style.display = view === 'done' || view === 'trash' ? 'none' : 'flex'
  // 清空按钮：只在垃圾桶里、且真有东西可清的时候才出现
  const purge = $('purgeall') as HTMLButtonElement
  purge.textContent = S.purgeAll
  purge.hidden = view !== 'trash' || !!results || pick('trash').length === 0

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
    restoreTitleEdit()
    return
  }
  renderDetail()
  $('list').innerHTML = groups.map(g => `<section class="group">${
    g.label ? `<div class="ghead ${g.overdue ? 'overdue' : ''}">${g.label}${
      g.wd ? `<span class="wd">${g.wd}</span>` : ''}</div>` : ''
  }${g.items.map(row).join('')}</section>`).join('')
  restoreTitleEdit()
}

function row(t: Task): string {
  // 行末那一小段时间：
  //   今天以后的，日期已经写在分组标题上了，所以只补"周三 18:00"
  //   逾期的，分组标题只有"已逾期"三个字 —— 不带上原来的日期就不知道拖了多久
  const time = (() => {
    if (t.startAt === undefined) return ''
    const clock = t.isAllDay ? '' : hhmm(t.startAt)
    if (dayStart(t.startAt) < today()) return [dayLabel(t.startAt), clock].filter(Boolean).join(' ')
    return clock ? `${weekday(t.startAt)} ${clock}` : ''
  })()
  const rep = t.repeat ? describeRepeat(t.repeat, lang) : ''
  const first = query.trim()
    ? (t.notes?.trim() ? matchContext(t, query, 46) : '')
    : (t.notes?.trim() ? notePreview(t.notes, 46) : '')
  return `<div class="task ${t.completedAt ? 'is-done' : ''} ${t.id === selected ? 'sel' : ''} ${
               leaving.has(t.id) ? 'leaving' : ''}" data-task="${t.id}">
    <button class="box ${t.completedAt ? 'done' : ''}"
            data-act="${t.completedAt ? 'task:uncomplete' : 'task:complete'}" data-id="${t.id}"></button>
    <div class="body">${titleEditing === t.id
      ? `<input class="titleedit" data-titleedit="${t.id}" value="${esc(t.title)}">`
      : `<div class="title">${esc(t.title)}</div>`}${
      first ? `<div class="notefirst">${esc(first)}</div>` : ''}</div>${
    time ? `<div class="when">${time}</div>` : ''}${
    rep ? `<span class="tag rep">↻ ${esc(rep)}</span>` : ''}
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

  // 正在打字的那个框不能重建：innerHTML 一换，焦点和光标位置就全没了。
  // 边打边存必须配这个，否则每存一次就把用户从输入框里踢出来
  const focused = document.activeElement as HTMLElement | null
  const typingTitle = focused?.id === 'dtitle'
  // 加上 editing：saveNote 把 editing 关掉之后，这里必须重建，
  // 否则光标还留在那个框里、编辑器就收不起来（按 esc/⌘↩ 看着像没反应）
  const typingNote = editing && !!focused?.closest?.('[data-noteedit]')
  const typingCustom = !!focused?.closest?.('.customdays')

  if (!typingTitle) ($('dtitle') as HTMLInputElement).value = t.title
  const d = t.startAt !== undefined ? new Date(t.startAt) : null
  const iso = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''
  const bits: string[] = []
  // 重复规则做成下拉，已创建的任务也能改
  if (t.completedAt) bits.push(S.isDone)
  if (t.deleted) bits.push(S.isTrashed)
  // 日期和时间可以直接改；清空日期就是"未安排"。
  // 叉号只在真有具体时间时出现，贴在时间框右边 —— 它只去掉时间，日期留着
  const timed = d !== null && !t.isAllDay
  if (!typingCustom) $('dmeta').innerHTML =
    `<input type="date" id="ddate" value="${iso}">` +
    `<span class="dtimebox">` +
      `<input type="time" id="dtime" value="${timed ? hhmm24(t.startAt!) : ''}">` +
      (timed ? `<button class="dclear" id="dclear" title="${esc(S.clearTime)}"
                        aria-label="${esc(S.clearTime)}">✕</button>` : '') +
    `</span>` +
    repeatSelect('drepeat', t.startAt ?? today(), t.repeat) +
    (customFor === 'detail' ? customDays('dcustom', everyDays(t.repeat?.rrule)) : '') +
    bits.map(b => `<span>${esc(b)}</span>`).join('')

  if (!typingNote) $('dbody').innerHTML = editing
    ? `<textarea class="noteedit" data-noteedit="${t.id}"
         placeholder="${esc(S.notesEditPlaceholder)}">${esc(t.notes ?? '')}</textarea>
       <div class="notehint">${esc(S.notesHint)}</div>`
    : `<div class="md" data-noteview="${t.id}">${renderMarkdown(t.notes ?? '')}</div>`
}

/**
 * 圆圈的完成/取消完成在 mousedown 就执行，不等 click。
 *
 * 因为 mousedown 会把焦点从就地编辑的输入框里挪走 → focusout → 保存 → render()，
 * 而 render() 重建整个列表，被按下的那个圆圈在 mouseup 之前就已经从 DOM 里消失了，
 * click 事件因此根本不会落到它身上 —— 表现就是"第一下没反应，得点第二下"。
 * 已经在 mousedown 里做过的事，随后的 click 要跳过，否则会连着切换两次。
 */
let actedOnMousedown = false
/**
 * 点标题进入就地编辑。光标落在点中的那个字旁边 —— 想改中间一个字，
 * 不用先跳到末尾再按一路左键。
 */
function beginTitleEdit(id: string, x: number, y: number) {
  const caret = caretOffsetAt(x, y)
  selected = id
  remember(id)
  titleEditing = id
  editing = false        // 改标题时别把焦点让给备注编辑框
  render()
  const el = document.querySelector<HTMLInputElement>('[data-titleedit]')
  if (!el) return
  const at = Math.min(caret ?? el.value.length, el.value.length)
  el.focus()
  el.setSelectionRange(at, at)
}

document.addEventListener('mousedown', (e) => {
  actedOnMousedown = false
  const target = e.target as HTMLElement
  const btn = target.closest<HTMLElement>('[data-act]')
  if (btn) {
    const act = btn.dataset['act'] as 'task:complete' | 'task:uncomplete'
    const id = btn.dataset['id']!
    if (act === 'task:complete' || act === 'task:uncomplete') linger(id)
    void kapi[act](id)
    actedOnMousedown = true
    return
  }
  // 改标题同样要在 mousedown 做：mousedown 会把焦点从上一个输入框挪走，
  // 那一次 focusout 保存会重建列表，click 就落不到这行标题上了（点了没反应）
  // 点渲染好的备注 → 展开编辑器，光标落在点中的那个字上。
  // 同样必须在 mousedown 做并拦下默认行为，理由和改标题一样
  const md = target.closest<HTMLElement>('[data-noteview]')
  if (md && !(target instanceof HTMLAnchorElement)) {
    e.preventDefault()
    const t = tasks.find(x => x.id === md.dataset['noteview'])
    pendingNoteCaret = noteCaretAt(e.clientX, e.clientY, md, t?.notes ?? '')
    editing = true
    render()
    focusEditor()
    actedOnMousedown = true
    return
  }

  const row = target.closest<HTMLElement>('[data-task]')
  if (!row || !target.closest('.title')) return
  // 拦下默认行为：否则浏览器会在 mousedown 之后把焦点移到"被点的那个元素"上，
  // 而那个元素刚被 render() 换掉了 —— 焦点落到 body，输入框当场又被 focusout 关掉
  e.preventDefault()
  beginTitleEdit(row.dataset['task']!, e.clientX, e.clientY)
  actedOnMousedown = true
})

/**
 * 渲染出来的第 n 个字，对应 Markdown 源码里的哪个位置。
 *
 * 渲染只会去掉标记（`**`、`- `、`[]()` 里的地址、`#`），不会凭空加字，
 * 所以渲染文本一定是源码的子序列 —— 双指针扫一遍就能对上，不用给渲染器
 * 埋一套源码位置的元信息。对不齐的极端情况最多差几个字，也好过一律跳到末尾。
 */
function sourceOffset(source: string, rendered: string, n: number): number {
  let i = 0, matched = 0
  while (i < source.length && matched < n) {
    if (source[i] === rendered[matched]) matched++
    i++
  }
  // 再往前走到"点中的那个字"正前面。不走这一步，光标会停在它前面的换行和
  // "> "、"- "、"## " 这些标记之前，在那儿打字会把标记挤坏
  const next = rendered[n]
  if (next !== undefined) while (i < source.length && source[i] !== next) i++
  return i
}

/** 点在渲染后的备注上 → Markdown 源码里的下标 */
function noteCaretAt(x: number, y: number, md: HTMLElement, source: string): number | null {
  const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
  const r = doc.caretRangeFromPoint?.(x, y)
  if (!r || !md.contains(r.startContainer)) return null
  // 按文档顺序数一遍：点击处之前有多少个字
  let n = 0
  const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === r.startContainer) return sourceOffset(source, md.textContent ?? '', n + r.startOffset)
    n += node.textContent?.length ?? 0
  }
  return null
}

/**
 * 点击坐标 → 文本里的第几个字。标题和就地编辑的输入框字体、起点都一样，
 * 所以按"字符下标"换算，比按像素靠谱。拿不到就返回 null，调用方退回光标放末尾。
 */
function caretOffsetAt(x: number, y: number): number | null {
  const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
  const r = doc.caretRangeFromPoint?.(x, y)
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null
  return r.startOffset
}

document.addEventListener('click', async (e) => {
  // mousedown 里已经处理完的（勾选、进入改标题），click 不要再来一遍
  if (actedOnMousedown) { actedOnMousedown = false; return }
  const target = e.target as HTMLElement
  const nav = target.closest<HTMLElement>('[data-view]')
  if (nav) { view = nav.dataset['view'] as ViewId; render(); return }
  if (target.id === 'dclear' && selected) {
    // 走和"手动把时间框清空"完全同一条路：日期不动，任务变成全天
    ;($('dtime') as HTMLInputElement).value = ''
    void saveWhen(); return
  }
  const noteview = target.closest<HTMLElement>('[data-noteview]')
  if (noteview && !(target instanceof HTMLAnchorElement)) {
    editing = true; render(); focusEditor(); return
  }
  const taskRow = target.closest<HTMLElement>('[data-task]')
  if (taskRow && !target.closest('[data-act]')) {
    // 点在正在编辑的标题框里 = 想挪一下光标，不是要换选中项。
    // 不挡住的话这一下会走到下面的"选中"分支，把编辑态关掉、还顺手打开备注
    if (target.closest('[data-titleedit]')) return
    const id = taskRow.dataset['task']!
    selected = id
    remember(id)
    if (target.closest('.title')) { beginTitleEdit(id, e.clientX, e.clientY); return }
    titleEditing = null
    // 还没写过备注就直接进编辑，省一次点击
    editing = !tasks.find(t => t.id === id)?.notes?.trim()
    render(); focusEditor(); return
  }
  const btn = target.closest<HTMLElement>('[data-act]')
  if (!btn) return
  const act = btn.dataset['act'] as 'task:complete' | 'task:uncomplete' | 'task:trash' | 'task:restore'
  if (act === 'task:complete' || act === 'task:uncomplete') linger(btn.dataset['id']!)
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
  // 点开的那一下算出了位置就用它，否则（右键"备注"、新建任务这些）放末尾
  const at = Math.min(pendingNoteCaret ?? el.value.length, el.value.length)
  pendingNoteCaret = null
  el.focus()
  el.setSelectionRange(at, at)
}

/** 收起编辑器并落盘。没有"取消"这条路 —— 打过的字一律留下 */
async function saveNote(el: HTMLTextAreaElement) {
  // render() 把 textarea 从 DOM 摘掉时会再触发一次 focusout，标记一下别重复走
  if (el.dataset['closed']) return
  el.dataset['closed'] = '1'
  const id = el.dataset['noteedit']!
  const next = el.value
  const prev = tasks.find(t => t.id === id)?.notes ?? ''
  editing = false
  if (next !== prev) await kapi['task:setField'](id, 'notes', next)   // 不变就不写 op
  else render()
}

/** 边打字边存：编辑器不关、焦点不动。renderDetail 会避开正在打字的那个框 */
async function autosaveNote(el: HTMLTextAreaElement) {
  if (el.dataset['closed']) return
  const id = el.dataset['noteedit']!
  const prev = tasks.find(t => t.id === id)?.notes ?? ''
  if (el.value === prev) return
  await kapi['task:setField'](id, 'notes', el.value)
}

document.addEventListener('keydown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLTextAreaElement>('[data-noteedit]')
  if (!el) return
  // esc 也是保存 —— 编辑器里没有"白打一段"这种结局
  if (e.key === 'Escape') { e.preventDefault(); void saveNote(el) }
  // ⌘↩ 保存并收起。单独的回车留给换行，备注是多行的
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveNote(el) }
})

/**
 * 每 5 秒看一眼编辑中的内容变没变，变了就存一次。
 *
 * 不做"每敲一个字存一次"：每次写入都是日志里的一条 op，还要跨 iCloud 同步到别的
 * Mac，按键存会把日志灌满。存的时候不重画正在打字的那个框（见 renderDetail），
 * 所以光标不会跳。标题空着先不存 —— 那通常是"清空了准备重打"，不是想删掉标题。
 */
setInterval(() => {
  const note = document.querySelector<HTMLTextAreaElement>('[data-noteedit]')
  if (note) void autosaveNote(note)
  const dt = $('dtitle') as HTMLInputElement
  if (document.activeElement === dt && dt.value.trim()) void saveTitle()
}, 5000)
// 点到别处也保存，别让用户白写一段
document.addEventListener('focusout', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLTextAreaElement>('[data-noteedit]')
  if (el) void saveNote(el)
})

/** 添加栏的重复下拉：选项跟着所选日期走，没选就按今天 */
function syncNewRepeat() {
  const at = di.value ? +new Date(`${di.value}T00:00`) : today()
  const keep = ri.value
  const presets = presetsFor(at, lang)
  // 自己填的天数不在预设里，换日期重建选项时要原样带回来，否则会被悄悄清成"不重复"
  const extra = keep && keep !== CUSTOM && !presets.some(o => o.rrule === keep)
    ? `<option value="${esc(keep)}">${esc(describeRrule(keep, lang))}</option>` : ''
  ri.innerHTML = `<option value="">${esc(S.noRepeat)}</option>` + extra +
    presets.map(o => `<option value="${o.rrule}">${esc(o.label)}</option>`).join('') +
    `<option value="${CUSTOM}">${esc(S.repeatCustom)}</option>`
  ri.value = keep && Array.from(ri.options).some(o => o.value === keep) ? keep : ''
}

/** 添加栏那个"每 [ ] 天"：null 表示收起来 */
function renderNewCustom(value: number | null) {
  $('newcustom').innerHTML = customFor === 'new' ? customDays('newcustom-input', value) : ''
}

function focusCustom(id: string) {
  const el = document.getElementById(id === 'newcustom' ? 'newcustom-input' : id) as HTMLInputElement | null
  el?.focus()
}

/**
 * 自定义天数落地。回车或失焦时读一次：填了合法数字就写 FREQ=DAILY;INTERVAL=N，
 * 没填就当作没选过，退回原来的规则（renderDetail / syncNewRepeat 会照原值重画）。
 */
function commitCustomDays(el: HTMLInputElement) {
  const n = Math.floor(Number(el.value))
  const ok = Number.isFinite(n) && n >= 1 && n <= 999
  const where = customFor
  customFor = null
  if (where === 'detail') {
    if (ok && selected) void kapi['task:setField'](selected, 'repeat', { rrule: dailyEvery(n) })
    else renderDetail()
    return
  }
  if (ok) {
    const rrule = dailyEvery(n)
    ri.value = ''                       // 先清掉"自定义…"，再把新选项塞进去选上
    ri.innerHTML += `<option value="${esc(rrule)}">${esc(describeRrule(rrule, lang))}</option>`
    ri.value = rrule
  } else ri.value = ''
  renderNewCustom(null)
}

document.addEventListener('keydown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('.customdays input')
  if (!el) return
  if (e.key === 'Enter') { e.preventDefault(); commitCustomDays(el) }
  if (e.key === 'Escape') { e.preventDefault(); el.value = ''; commitCustomDays(el) }
})
document.addEventListener('focusout', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('.customdays input')
  if (el && customFor) commitCustomDays(el)
})

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
    view = DEFAULT_VIEW
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
  view = DEFAULT_VIEW
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
  // esc 同样是保存后收起，不还原
  if ((e as KeyboardEvent).key === 'Escape') { e.preventDefault(); void saveTitle(); el.blur() }
})
$('dtitle').addEventListener('blur', () => void saveTitle())

/** 列表里就地改标题。和详情栏那个走同一条写入路径，规则也一样：不接受清空 */
async function saveRowTitle(el: HTMLInputElement) {
  if (el.dataset['closed']) return          // render() 摘掉元素时会再触发一次 blur
  el.dataset['closed'] = '1'
  const id = el.dataset['titleedit']!
  const next = el.value.trim()
  const t = tasks.find(x => x.id === id)
  // 只关掉自己这一条：直接点另一行的标题时，编辑权已经交给那一行了
  // （这次 focusout 正是那次交接触发的），这里一刀切会把新开的编辑框也关掉
  if (titleEditing === id) titleEditing = null
  if (!t || !next || next === t.title) { render(); return }
  await kapi['task:setField'](id, 'title', next)
}

document.addEventListener('keydown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('[data-titleedit]')
  if (!el) return
  // 回车和 esc 都是保存 —— 详情栏那边没有"取消"，这里也不该有
  if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); void saveRowTitle(el) }
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
    if (v === CUSTOM) { customFor = 'detail'; renderDetail(); focusCustom('dcustom'); return }
    customFor = null
    void kapi['task:setField'](selected, 'repeat', v ? { rrule: v } : null)
  }
  if (el.id === 'newRepeat') {
    const v = ri.value
    if (v === CUSTOM) { customFor = 'new'; renderNewCustom(null); focusCustom('newcustom'); return }
    customFor = null
    renderNewCustom(null)
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

// 清空垃圾桶。确认对话框在主进程弹，这里只等结果（改动会由 tasks:changed 推回来）
$('purgeall').addEventListener('click', () => void kapi['task:purgeAll']())

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

/**
 * 同步中的挡板。
 *
 * 读盘通常只要几毫秒，所以 200ms 内读完的一律不弹 —— 否则对面每敲一下键，
 * 这边就闪一下挡板，比不挡还烦。真弹出来了就至少留 350ms，免得刚看见就消失。
 */
const SYNC_DELAY = 200, SYNC_MIN = 350
let syncTimer: ReturnType<typeof setTimeout> | null = null
let syncShownAt = 0

function showSync(on: boolean) {
  const el = $('syncsheet') as HTMLElement
  if (on) {
    if (syncTimer || !el.hidden) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      syncShownAt = Date.now()
      // 挡板一盖上就不能编辑了，所以先让正在编辑的框失焦 ——
      // 走它自己的保存路径，打了一半的字不会白打
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      el.hidden = false
    }, SYNC_DELAY)
    return
  }
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; return }   // 还没弹就结束了
  if (el.hidden) return
  const left = SYNC_MIN - (Date.now() - syncShownAt)
  if (left > 0) setTimeout(() => { el.hidden = true }, left)
  else el.hidden = true
}

kapi.onSyncBusy(showSync)
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
