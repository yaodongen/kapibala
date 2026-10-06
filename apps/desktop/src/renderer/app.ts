/**
 * 渲染进程：纯投影。真相在主进程的 core 里，这里只画和发命令。
 * 看不到 op，也看不到 HLC。
 */
import type { Task } from '@kapibala/core'
// 只从子路径引这个纯函数：渲染进程是 browser 目标，不能碰 core 里用到 node:crypto 的部分
import { notePreview, renderMarkdown } from '@kapibala/core/markdown'
import { describeRepeat, describeRrule, occurrencesBetween, parseRrule, presetsFor,
         toRruleString } from '@kapibala/core/rrule'
// 纯函数，和 markdown / rrule 一样只从子路径引：从标题里认日期和时间，给添加栏预填
import { parseWhenIn } from '@kapibala/core/when'
// 纯函数，和 markdown / rrule 一样只从子路径引。拖拽排序的落点算法在 core 里，有单测
import { compareOrder, orderBetween, spreadOrders } from '@kapibala/core/order'
import { matchContext, searchTasks } from '@kapibala/core/search'
import { addDays, DEFAULT_DETAIL_WIDTH, MONTH_CAL_COLS, viewSlot, WIN_SLOTS,
         type Api, type FieldOpIpc, type Theme,
         type VaultState, type ViewId, type WinSlot } from '@kapibala/ipc'
import { t as dict, type Lang, type Strings } from '../i18n.ts'

declare global { interface Window { kapi: Api } }
const kapi = window.kapi

/**
 * 运行平台。只为两件事存在：Windows 上标题栏右边要给系统那三个按钮让位
 * （见 index.html 里的 html[data-os=win]），以及快捷键提示该写 ⌘ 还是 Ctrl。
 * 别拿它去分叉界面逻辑 —— 那正是两个平台开始各长各的起点。
 */
const OS = kapi.platform
// 挂到 <html> 上给 CSS 用。必须在第一次画之前挂好，否则收起详情栏时右边会先画错一帧
document.documentElement.dataset['os'] = OS === 'darwin' ? 'mac' : 'win'

/**
 * 界面语言。主进程说了算（它知道系统语言，也存着用户改过的选择），
 * 这里只是拿到手就用。所有文案都在 render() 时取，切换语言不用重启窗口。
 */
let lang: Lang = 'zh'
let S: Strings = dict('zh')
/** 当前生效的亮/暗。配色是 CSS 的 prefers-color-scheme 在管，这个只喂开关 */
let theme: Theme = 'light'
/** 版本号，显示在左下角（点它就是看日志）。boot() 里拉到，之前先用"查看日志"兜底 */
let version = ''

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
  if (ts === t - DAY) return S.dayYesterday
  return S.dayLabel(new Date(ts))
}
/**
 * 只报"几月几日"，不说"今天/昨天"。连续日历格子的悬浮提示和格子里的日期用它 ——
 * 格子里只写日期数字，悬浮时把话说全，而"昨天"这种说法第二天就变意思了，
 * 提示里要说的是"这一格是哪天"，得是个不会变的写法。
 */
const absDay = (ts: number) => S.dayLabel(new Date(ts))
/**
 * "10月5日 周一" / "Oct 5, Mon"。连续日历格子的悬浮提示（title）用它 ——
 * 格子里只有一串日期数字，悬浮时把周几也说出来。
 * 拼法借 todaySub：中英文的分隔符（中文空格、英文逗号）在字典里只有那一处，
 * 不为了一个提示再写一份。
 */
const dayFull = (ts: number) => S.todaySub(absDay(ts), weekday(ts))
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/**
 * 不做清单，所以就这 9 项。名字和副标题都从字典取，键名和视图 id 对齐。
 * id 那一层在 ipc 里（主进程要拿它校验 ui.json、分窗口大小），这里只管怎么画。
 */
const VIEWS = [
  { id: 'today', ico: '☀', sub: () => S.todaySub(dayLabel(today()), weekday(today())) },
  { id: 'next7', ico: '▤', sub: () => S.next7Sub },
  { id: 'next30', ico: '▦', sub: () => S.next30Sub },
  { id: 'calendar7',  ico: '▥', sub: () => S.calendar7Sub },
  { id: 'calendar14', ico: '▩', sub: () => S.calendar14Sub },
  // 「连续日历」：日子一天接一天铺下去，上下无限滚，每行放几个由用户定（见 monthCols）。
  // 逾期不单独占一格（它们就在原来那天，往上滚就看见了），所以副标题只说怎么用
  { id: 'calendarFlow', ico: '▧', sub: () => S.calendarFlowSub },
  { id: 'all',   ico: '≡', sub: () => S.allSub },
  { id: 'done',  ico: '✓', sub: () => S.doneSub },
  { id: 'trash', ico: '␥', sub: () => S.trashSub },
] as const satisfies readonly { id: ViewId; ico: string; sub: () => string }[]

/**
 * 两个固定日历视图：铺几天（不含第一格"已逾期"）、一行放几列。
 * 7 天 = 逾期 + 7 = 8 格，铺成 4 列 × 2 行；14 天 = 15 格，铺成 5 列 × 3 行 ——
 * 都刚好铺满，不留半行。列数写进 --cal-cols，布局在 index.html 的 .list.cal 里。
 *
 * 连续日历不在这儿：它没有"铺几天"这回事（铺多久由滚动决定，见下面的 FLOW_*），
 * 列数也不是固定值（见 monthCols）。
 */
const CAL: Partial<Record<ViewId, { days: number; cols: number }>> = {
  calendar7: { days: 7, cols: 4 },
  calendar14: { days: 14, cols: 5 },
}
/**
 * 「连续日历」的视图 id。它不在 CAL 里 —— 那两个字段（days / cols）对它没意义：
 * 铺多久由滚动决定（见下面的 FLOW_*），列数由用户定（见 monthCols）。
 * 但"铺格子"这件事它和上面两屏是一路的，所以 isCalView 得把它算进去 ——
 * 点任务不自动展开详情栏那条规矩跟着它走。
 */
const CAL_FLOW: ViewId = 'calendarFlow'
/** 这一屏是不是"铺格子"的日历（7d / 14d / 连续日历）。它们点任务不自动展开详情栏 */
const isCalView = (v: ViewId) => !!CAL[v] || v === CAL_FLOW

let tasks: Task[] = []
let vault: VaultState | null = null
/**
 * 没记过偏好时的默认视图：只看今天容易漏掉马上要到的事，一周的视野更实用。
 * 平时打开会回到上次停的那一屏（ui.json 里的 view，见 boot 和 setView）。
 */
const DEFAULT_VIEW: ViewId = 'next7'
let view: ViewId = DEFAULT_VIEW
/**
 * 日历视图要不要显示已完成的任务（顶栏那个开关）。默认关 —— 日历首先是看安排的。
 * 打开后打过钩的也留在格子里，**仍然挂在原来安排的那天**（不是完成那天）——
 * 安排不该因为事情提前做完就挪位置，完成时间由行上那个 ✓ 说。状态存在 ui.json 里，
 * 和语言、主题一样是本机偏好，**四个日历视图共用这一个开关**（7d / 14d / 连续日历）。
 */
let showDone = false
/**
 * 连续日历要不要"推演"周期任务（把「每天读书 20 分钟」未来会排到哪几天也画出来）。
 * **默认开** —— 这一屏的看点是"往后怎么排"，不推演就只剩当前那一期孤零零一行。
 * 和 showDone 一样是本机的界面偏好，存在 ui.json 里（见 projectDays）。
 */
let projectRepeat = true
/**
 * 「连续日历」每行放几天（3~7，默认 5）。和 showDone 一样是本机的界面偏好，
 * 存在 ui.json 里（不进库目录、不跟 iCloud 同步）—— 下次打开还是这个摆法。
 *
 * 它只是"一行摆几个格子"，列数和星期没有任何关系（这一屏不分月、也不按周对齐，
 * 见 index.html 的 .calflowgrid）。为什么默认 5：1110 宽的窗口、两侧栏都开着时，
 * 7 列一格只剩 66px（连日期都写不下），5 列还有 95px —— 小屏幕上也读得全。
 */
let monthCols: number = MONTH_CAL_COLS.def
/**
 * 左右两侧栏收起没有。收起是为了把任务列表 / 日历铺满，专心看安排。
 * 和详情栏宽度、语言、主题一样是本机的界面偏好，存在 ui.json 里（不进库目录、
 * 不跟 iCloud 同步）—— 下次打开还是这个样子。布局由 .app 上的两个类管（见 index.html）
 */
let sideCollapsed = false
/**
 * 详情栏收起没有。按视图分组各记一份（键同窗口大小：其余视图 / 日历），
 * 在日历里收起详情看格子，切回列表再回来它还是收着的。
 * **三个日历视图共用日历那一份**：7d 里收起了详情，切到 14d、自定义也是收起的。
 * detailCollapsed 是**当前这一屏**的生效值，切视图时从 detailBySlot 里换一份。
 * 缓存在这里而不是每次问主进程：切视图要同步画，等一次往返会先闪一帧没收起的界面。
 */
let detailCollapsed = false
const detailBySlot = Object.fromEntries(WIN_SLOTS.map(s => [s, false])) as Record<WinSlot, boolean>
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
/**
 * 刚取消勾选那条**原来**的完成时间。取消之后 completedAt 就清掉了，
 * 可它还要在列表里淡出 450ms —— 没有这个记录，它会被归到"今天"那一组的最后一行，
 * 淡出期间整行看着往下跳。记着旧值，它就停在原地慢慢淡掉。
 */
const wasDoneAt = new Map<string, number>()
// 淡出动画的时长跟着这个常量走，免得两边各写一个数、改一处忘一处
document.documentElement.style.setProperty('--linger', `${LINGER}ms`)
function linger(id: string) {
  const prev = tasks.find(t => t.id === id)?.completedAt
  if (prev !== undefined && prev !== null) wasDoneAt.set(id, prev)
  clearTimeout(leaving.get(id))
  leaving.set(id, setTimeout(() => { leaving.delete(id); wasDoneAt.delete(id); render() }, LINGER))
}

/**
 * 勾选 / 取消勾选。完成必须在 mousedown 里就发出去（理由见文件头那段），
 * 所以这里只管写命令，不管是谁触发的。
 *
 * 周期任务完成后存储层会派生下一个实例。列表里刚完成的那条要淡出 LINGER 毫秒才消失，
 * 详情栏也等它消失之后再跟过去 —— 一勾就跳走的话，"到底勾上没有"反而看不清。
 */
async function setDone(id: string, done: boolean) {
  linger(id)
  if (!done) { await kapi['task:uncomplete'](id); return }
  const next = await kapi['task:complete'](id)
  if (!next) return
  setTimeout(() => {
    // 这 LINGER 毫秒里用户可能自己选了别的任务、或者又把这条点回未完成 —— 那就不切。
    // 下一个实例还没进 tasks（tasks:changed 慢了一拍）也先不切，别把详情栏甩空
    if (selected !== id) return
    if (!tasks.find(t => t.id === id)?.completedAt) return
    if (!tasks.some(t => t.id === next)) return
    selected = next
    remember(next)
    render()
  }, LINGER)
}

const alive = () => tasks.filter(t => !t.deleted)
const undone = () => alive().filter(t => !t.completedAt || leaving.has(t.id))
/** 这条任务算"什么时候完成的"：正在淡出的那条 completedAt 已经空了，退回记下来的旧值 */
const doneAtOf = (t: Task) => t.completedAt ?? wasDoneAt.get(t.id)

/**
 * 同一天里的先后：**手排的 order 说了算，时间只当标签**。日历格子和列表的日期分组
 * 共用这一个比较器，两处顺序才不会各走各的。order 相同时（两台机器同时往同一处拖）
 * 由 core 那边用 id 兜底，保证哪台机器上算出来都一样。
 *
 * 例外是"已逾期"那一格：它跨好几天，手排对它没意义，也当不了拖动落点，
 * 所以那边仍旧按原定时间排（最逾期的在最上面）。
 */
const byOrder = (a: Task, b: Task) => compareOrder(a, b)

/**
 * 重要置顶。**只用在"手排管不着"的那几处**：列表的「已逾期」「未安排」，日历的「已逾期」格。
 * 那几处按的都不是 order（逾期按原定时间、未安排干脆没排过），也拖不动 —— 想让重要的
 * 任务露头，就剩排序这一条路。
 *
 * 按 order 排的那几处（某一天的列表分组、日历的日期格）**不能**套这个：那里的位置归 order
 * 管，标记重要时已经顺手把 key 写到那一天最前了（见主进程的 importantOrder）。在这儿再压一层，
 * 用户把一条普通任务拖到重要任务上面就会被当场弹回去 —— 手排的位置必须说了算。
 */
const impFirst = (a: Task, b: Task) => Number(!!b.important) - Number(!!a.important)

function pick(v: ViewId): Task[] {
  const t0 = today()
  if (v === 'today') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY)
  if (v === 'next7') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY * 7)
  // 日历视图和"最近 N 天"是同一批任务：逾期 + 今天起 N 天。没定日期的挂不到日历上
  const cal = CAL[v]
  if (cal) {
    const t1 = t0 + DAY * cal.days
    /**
     * 开关打开：已完成的任务也进来，但**仍挂在原来安排的那天**（不是完成那天）——
     * 格子上的安排不该因为事情提前做完就挪位置；什么时候了结的，行上那个 ✓ 时间说得清。
     *
     * 排期在今天之前的已完成任务**不进日历**：它们唯一的落脚点是第一格"已逾期"，
     * 而那一格说的是"还没做完、拖着的事"；开关一开就把全部历史塞进去，那格就没法看了。
     * 例外是**刚勾完的那一条**（在 leaving 里留 LINGER 毫秒）：让它在逾期格里淡出再走，
     * 一勾就凭空消失会让人以为没勾上（见 calendarCells 和 calRow 的 fading）。
     */
    if (showDone) return alive().filter(t => {
      if (t.startAt === undefined || t.startAt >= t1) return false
      return t.completedAt === undefined || t.startAt >= t0 || leaving.has(t.id)
    })
    return undone().filter(t => t.startAt !== undefined && t.startAt < t1)
  }
  /**
   * 「连续日历」：**所有排过期的任务**都进来，逾期的也照旧待在自己那天 ——
   * 这一屏本来就该是这个样子：往上滚几天就看见拖了很久的事，不用另开一格收着
   *（7d / 14d 那种"逾期单独占一格"是给固定几天的小窗口用的，这一屏没有"第一格"）。
   *
   * 所以这里**不按铺出来的日子筛**：铺到哪一天是滚动的事（见 FLOW_MAX_DAYS），
   * 拿它筛的话侧栏那个条数会跟着滚动一路变；格子按天分桶，范围外的自然分不进去。
   * 没定日期的挂不到日历上（和 7d / 14d 一样），入口在别的视图。
   *
   * 「显示已完成」打开后，打过钩的也进来，仍然挂在**原来安排的那天**（同上）。
   */
  if (v === CAL_FLOW) return (showDone ? alive() : undone()).filter(t => t.startAt !== undefined)
  if (v === 'next30') return undone().filter(t => t.startAt !== undefined && t.startAt < t0 + DAY * 30)
  if (v === 'all') return undone()
  // 已完成视图里取消勾选也一样，先留一秒
  if (v === 'done') return alive().filter(t => t.completedAt || leaving.has(t.id))
    .sort((a, b) => (doneAtOf(b) ?? 0) - (doneAtOf(a) ?? 0))
  return tasks.filter(t => t.deleted)
}

/**
 * 一个分组。day 只有"某一天"那几组才有 —— 拖动排序靠它认落点：
 * "已逾期"跨好几天、"未安排"没有日期，都当不了落点（见 dropAt）。
 * 已完成视图按完成那天分组、搜索结果按相关度排，也都不带 day。
 */
type Group = { label: string; wd: string; items: Task[]; overdue?: boolean; day?: number }
function group(list: Task[], v: ViewId): Group[] {
  if (v === 'trash') return [{ label: '', wd: '', items: list }]
  // 已完成按"哪天完成的"分组，最近的一天在最前 —— 和"最近 7 天"同一套观感，
  // 一眼就能看出这些事是什么时候了结的
  if (v === 'done') {
    const byDay = new Map<number, Task[]>()
    for (const t of list) {
      // 刚取消勾选、正在淡出的那条用记下来的旧时间，整行原地不动（见 doneAtOf）
      const d = dayStart(doneAtOf(t) ?? Date.now())
      const arr = byDay.get(d) ?? []
      arr.push(t); byDay.set(d, arr)
    }
    return [...byDay.keys()].sort((a, b) => b - a).map(d => ({
      label: dayLabel(d), wd: weekday(d),
      // 同一天里也是最近完成的排前面
      items: byDay.get(d)!.sort((x, y) => (doneAtOf(y) ?? 0) - (doneAtOf(x) ?? 0)),
    }))
  }
  const t0 = today(), byDay = new Map<number, Task[]>(), over: Task[] = [], none: Task[] = []
  for (const t of list) {
    if (t.startAt === undefined) { none.push(t); continue }
    const d = dayStart(t.startAt)
    if (d < t0) { over.push(t); continue }
    const arr = byDay.get(d) ?? []
    arr.push(t); byDay.set(d, arr)
  }
  // 逾期那一组按原定时间排（最逾期的在最上面），重要的先露头；各天的分组按手排 order，
  // 和日历格子一致
  const byTime = (a: Task[]) => a.sort((x, y) => impFirst(x, y) || (x.startAt ?? 0) - (y.startAt ?? 0))
  const out: Group[] = []
  if (over.length) out.push({ label: S.overdue, wd: '', items: byTime(over), overdue: true })
  for (const d of [...byDay.keys()].sort((a, b) => a - b))
    out.push({ label: dayLabel(d), wd: weekday(d), items: byDay.get(d)!.sort(byOrder), day: d })
  // 未安排那一组没排过序（拖不动、也放不进去），只把重要的顶上去，其余保持原样
  if (none.length) out.push({ label: S.unscheduled, wd: '', items: none.sort(impFirst) })
  return out
}

/**
 * 日历视图的格子：第一格固定是"已逾期"，其余是今天起 days 天，一共 days + 1 格。
 * 逾期任务没有哪一天可归，只有单独一格才放得下；它排在前面，和列表视图的"逾期置顶"一个观感。
 *
 * 开关打开后，已完成的任务也进来，但**照样归在原来安排的那天**（哪些进得来由 pick 定，
 * 排期在今天之前的已完成任务在那一步就被挡掉了 —— 它们没有格子可落，"已逾期"格只放
 * 还没做完的事）。行上给的是完成时间，格子的位置说的却是"原本安排在哪天"。
 *
 * 格子按 CAL 里的列数铺成若干行（见 index.html 的 .list.cal），DOM 顺序就是阅读顺序。
 * 空格子也照画 —— 日历凭空少一天比空着更像坏了，而且格子位置固定，勾掉一条时
 * 后面的天数不会整体往前挪。
 */
/**
 * day 是"这一格是哪天"（那天的零点），只有真实的日期格才有；"已逾期"那格跨好几天，
 * 没有具体哪一天，所以是 undefined —— 行上要不要补完成日期就看它（见 calRow）。
 * compact 是"这格特别窄"（连续日历，7 列时一格才 66 像素）：行上的字要按最短的写法来，
 * 装不下的完整说法留给 hover 的 title（同样见 calRow）。7d / 14d 那两屏不设它。
 */
type CalCell = { key: string; label: string; wd: string; items: Task[]; overdue?: boolean;
                 today?: boolean; day?: number; compact?: boolean }
/**
 * 一格里的先后：未完成在上、已完成沉底（见下），未完成那一段按**手排的 order** ——
 * 时间只当标签，"9:00 也可能排在 14:00 下面"，这是拖动排序换来的代价。
 * 已完成内部反过来 —— **最后完成的排最前**，刚了结的事一眼就能看到。
 * 三个日历视图共用（7d / 14d 和自定义），三处的格子顺序才不会各走各的。
 *
 * `imp` 打开"重要置顶"，**只有「已逾期」那一格用**（见 calendarCells）：那格跨好几天，
 * 手排的 order 在那儿没有可比性、也当不了拖动落点（见上面 byOrder 那段）。日期格里
 * 不能开 —— 那里的位置归 order 管，开了之后把一条普通任务拖到重要任务上面会被弹回去。
 */
const isDoneCell = (t: Task) => showDone && t.completedAt !== undefined
const cellCmp = (imp: boolean) => (x: Task, y: Task) => {
  if (isDoneCell(x) !== isDoneCell(y)) return isDoneCell(x) ? 1 : -1
  if (imp) { const d = impFirst(x, y); if (d) return d }
  return isDoneCell(x) ? y.completedAt! - x.completedAt! : byOrder(x, y)
}
const byTime = (a: Task[]) => a.sort(cellCmp(false))
const byOverdue = (a: Task[]) => a.sort(cellCmp(true))

function calendarCells(list: Task[], days: number): CalCell[] {
  const t0 = today()
  const over: Task[] = []
  const byDay = new Map<number, Task[]>()
  for (const t of list) {
    // 一律按**原来安排的那天**归格（打过钩的也一样，见上面的说明）。
    // 没定日期的挂不到日历上，入口在别的视图
    if (t.startAt === undefined) continue
    const d = dayStart(t.startAt)
    if (d < t0) { over.push(t); continue }
    const arr = byDay.get(d) ?? []
    arr.push(t); byDay.set(d, arr)
  }
  const cells: CalCell[] = [{ key: 'overdue', label: S.overdue, wd: '', items: byOverdue(over), overdue: true }]
  for (let i = 0; i < days; i++) {
    const d = t0 + i * DAY
    cells.push({ key: String(d), label: dayLabel(d), wd: weekday(d), items: byTime(byDay.get(d) ?? []), today: i === 0, day: d })
  }
  return cells
}

const $ = (id: string) => document.getElementById(id)!

/**
 * index.html 里写死的那几十个字。语言一变就整块重刷，
 * 否则会留下半中半英的界面。
 */
function applyStatic() {
  document.documentElement.lang = S.htmlLang
  const text: Array<[string, string]> = [
    ['brandname', S.brand], ['langbtn', S.langOther],
    ['welcomelang', S.langOther],
    ['welcometitle', S.welcomeTitle], ['pick', S.welcomePick],
    ['welcomehint', S.welcomeHint], ['welcomelog', S.welcomeLog],
    ['dlabel', S.notesLabel],
    ['vaultsheettitle', S.vaultSheetTitle], ['vaultadd', S.vaultOpenOther],
    ['vaultforgetnote', S.vaultForgetNote], ['vaultclose', S.close],
    ['synctitle', S.syncTitle], ['syncsub', S.syncSub],
    ['logsheettitle', S.logTitle], ['logcopy', S.logCopy],
    ['logreveal', S.platform.logReveal(OS)], ['logclose', S.close],
  ]
  for (const [id, v] of text) $(id).textContent = v
  // 左下角显示当前的版本号；点它和"查看日志"是一回事，所以提示语沿用那句。
  // 版本号是语言无关的，不进字典；还没拉到就先用"查看日志"兜着
  const ver = $('verbtn')
  ver.textContent = version ? `v${version}` : S.viewLog
  ver.title = S.viewLog
  ver.setAttribute('aria-label', S.viewLog)
  // 这三句里有 <b>，是字典里写好的、不含用户输入的片段
  for (const [id, v] of [['welcomesync', S.welcomeSync], ['welcomelocal', S.welcomeLocal],
                         ['welcomeundo', S.welcomeUndo]] as Array<[string, string]>)
    $(id).innerHTML = v
  ;($('search') as HTMLInputElement).placeholder = S.searchPlaceholder
  ;($('newTitle') as HTMLInputElement).placeholder = S.addPlaceholder
  ;($('dtitle') as HTMLTextAreaElement).placeholder = S.titlePlaceholder
  // 添加栏那两个原生日期/时间框没有可见标签，靠 title + aria-label 说清楚留空是什么意思
  for (const [id, tip] of [['newDate', S.addDateTip], ['newTime', S.addTimeTip]] as Array<[string, string]>) {
    const el = $(id)
    el.title = tip
    el.setAttribute('aria-label', tip)
  }
  document.querySelectorAll<HTMLElement>('[data-lang]').forEach(el => { el.title = S.langSwitchTip })
  // 详情栏分隔线的提示写"它能干什么"，和语言/主题按钮一个规矩
  const sep = $('dresize')
  sep.title = S.detailResizeTip
  sep.setAttribute('aria-label', S.detailResizeTip)
  // 侧边栏那两枚"收起/展开"按钮的提示。它们的含义不随状态变（收起就是收起），
  // 而 #detailtoggle 一个按钮担两职、箭头和提示都随状态变，交给 applyPanes 管
  for (const [id, tip] of [['sidecollapse', S.sidebarCollapseTip],
                           ['sideexpand', S.sidebarExpandTip]] as Array<[string, string]>) {
    $(id).title = tip
    $(id).setAttribute('aria-label', tip)
  }
  // 空备注的占位文字在 CSS 的 ::before 里，只能靠变量递进去
  document.documentElement.style.setProperty('--md-empty', JSON.stringify(S.notesEmpty))
  // 已完成列表最左边那一列的宽度：英文写 "11:58 PM"，比中文的 "23:58" 宽不少
  document.documentElement.style.setProperty('--doneat-w', lang === 'en' ? '56px' : '44px')
  setThemeSwitch()
  setDoneSwitch()
  setProjectSwitch()
  applyPanes()
}

/**
 * 主题开关的状态。配色由 CSS 的 prefers-color-scheme 自己切（主进程改
 * nativeTheme.themeSource），这里只管滑块位置、aria 和提示语。
 * 提示语写"点了会变成什么"，和语言按钮一个规矩。
 */
function setThemeSwitch() {
  const dark = theme === 'dark'
  const tip = dark ? S.themeToLight : S.themeToDark
  document.querySelectorAll<HTMLElement>('[data-themesw]').forEach(el => {
    el.setAttribute('aria-checked', String(dark))
    el.title = tip
    el.setAttribute('aria-label', tip)
  })
}

/**
 * 日历视图的「显示已完成」开关。和主题开关一个规矩：提示语写"点了会变成什么"。
 * 显隐（哪个视图才显示它）由 render() 管，这里只刷状态和文案 —— 换语言时也要重刷。
 */
function setDoneSwitch() {
  const el = $('donesw')
  const tip = showDone ? S.showDoneOff : S.showDoneOn
  el.setAttribute('aria-checked', String(showDone))
  el.title = tip
  el.setAttribute('aria-label', tip)
}

/**
 * 连续日历的「推演」开关。同一个规矩：提示语写"点了会变成什么"。
 * 显隐（只有这一屏才推演）由 render() 管，这里只刷状态和文案。
 */
function setProjectSwitch() {
  const el = $('projectsw')
  const tip = projectRepeat ? S.projectOff : S.projectOn
  el.setAttribute('aria-checked', String(projectRepeat))
  el.title = tip
  el.setAttribute('aria-label', tip)
}

/**
 * 两侧栏的收起状态落到界面上。布局和显隐全在 .app 的两个类上（见 index.html），
 * 这里只刷那几个按钮自己的样子：
 *   #sideexpand  —— 只在侧边栏收起时出现。它是唯一的展开入口，那枚«跟着侧边栏一起没了
 *   #detailtoggle —— 箭头反过来、提示改写成"点了会变成什么"（和主题开关一个规矩）
 * 换语言时也要走一遍（applyStatic 会调），否则会留下上一种语言的提示语。
 *
 * 详情栏收起后**选中项不动**：列表里那条照旧高亮，只是详情栏不显示出来。
 * 普通视图里点任务会把详情栏拽回来（见下面 click 那段），日历视图不拽 ——
 * 日历里点一下往往只是换选中，展开详情会把格子挤小。
 */
function applyPanes() {
  const app = document.querySelector('.app') as HTMLElement
  app.classList.toggle('side-collapsed', sideCollapsed)
  app.classList.toggle('detail-collapsed', detailCollapsed)
  $('sideexpand').hidden = !sideCollapsed
  const det = $('detailtoggle')
  det.textContent = detailCollapsed ? '«' : '»'
  det.title = detailCollapsed ? S.detailExpandTip : S.detailCollapseTip
  det.setAttribute('aria-label', det.title)
  det.setAttribute('aria-expanded', String(!detailCollapsed))
}

/**
 * 收起/展开详情栏，状态按**当前视图分组**落进 ui.json（和详情栏宽度一样是本机界面偏好）。
 * 两个入口共用：详情栏那枚 »/« 按钮，和普通视图里点任务时的自动展开。
 * 收回时调用方要先把栏里的焦点交出去（见下面 click 那段），这里只管状态。
 */
async function setDetailCollapsed(on: boolean) {
  const slot = viewSlot(view)
  if (detailBySlot[slot] === on) return
  detailBySlot[slot] = await kapi['ui:setDetailCollapsed'](slot, on)
  detailCollapsed = detailBySlot[slot]
  applyPanes()
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

/**
 * 换掉整个列表时，滚动位置自己钉住，**不指望浏览器的 scroll anchoring**。
 *
 * 全量重建 innerHTML 时它会算歪锚点：内容一个字节没变，也把 scrollTop 往下推一行。
 * 用户看到的就是"点一下列表自己往上跑一行"，连点就一路往上（见 `.list` 上的
 * `overflow-anchor:none`）。所以这里自己锚：记住视口里最上面那条任务是谁、
 * 离列表顶边多远，重建完按同样的距离把它放回去；同步过来几条、上面少一条也照样钉得住。
 */
function keepScroll(): () => void {
  const list = $('list')
  const viewTop = list.getBoundingClientRect().top
  const rows = list.querySelectorAll<HTMLElement>('[data-task]')
  let anchor: HTMLElement | null = null
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i]!
    if (el.getBoundingClientRect().bottom > viewTop) { anchor = el; break }
  }
  const id = anchor?.dataset['task']
  const offset = anchor ? anchor.getBoundingClientRect().top - viewTop : 0
  return () => {
    // 锚那条没了（勾掉、删掉、换到别的视图）就不动它，退回浏览器的默认表现
    if (!id) return
    const next = list.querySelector<HTMLElement>(`[data-task="${id}"]`)
    if (!next) return
    // 用**当前**的列表顶边算，而不是记下来的那个：这次重画可能让顶栏的 banner
    // 出来或消失，列表整体上下挪了，锚点相对列表的位置才是要保住的东西
    list.scrollTop += next.getBoundingClientRect().top - list.getBoundingClientRect().top - offset
  }
}

function render() {
  const restoreTitleEdit = keepTitleEdit()
  const restoreScroll = keepScroll()
  $('nav').innerHTML = VIEWS.map(v => {
    const n = pick(v.id).length
    // 已完成 / 垃圾桶和前面那 7 个列表之间隔一条线（按 id 认，别数下标 —— 加一个视图就错位）
    return (v.id === 'done' ? '<div class="sep"></div>' : '') +
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
  /**
   * 这一屏是"已完成"列表（不是搜索、不是垃圾桶）。
   * 它两处特殊：行首多一列完成时间；整页任务都打了钩，标题不再划删除线 ——
   * 打钩本身就表示完成了（见 index.html 的 .list.alldone）
   */
  const doneList = view === 'done' && !results
  $('list').classList.toggle('alldone', doneList)
  /**
   * 日历视图：同一批任务（逾期 + 今天起 N 天）不走"分组标题 + 一列任务"那条路，
   * 摊成日期格子（7d 是 4 列 × 2 行，14d 是 5 列 × 3 行，列数写进 --cal-cols）。
   * 搜索时仍然回到普通列表 —— 搜索结果按相关度排，摊到日历上没意义。
   * 空库也不走下面那个"空状态"分支：日历把格子画出来本身就是有用的信息。
   */
  const cal = results ? undefined : CAL[view]
  /**
   * 「连续日历」：一条"铺格子"的路，日子一天接一天铺下去（见下面那一段）。
   * 搜索时和别处一样退回普通列表，所以也带 !results。
   */
  const flow = !results && view === CAL_FLOW
  // 「显示已完成」四个日历视图都有。7d / 14d 的格子是"逾期 + 未来 N 天"，连续日历是所有
  // 排过期的日子；打开后打过钩的都留在**原来安排的那天**（见 pick / calendarCells）。
  // 搜索结果是普通列表，这一处把它收起来
  $('donesw').hidden = !cal && !flow
  setDoneSwitch()
  // 「推演」只有连续日历这一屏有（另外两屏天数固定，铺不铺都行；见 projectDays）
  $('projectsw').hidden = !flow
  setProjectSwitch()
  $('list').classList.toggle('cal', !!cal)
  $('list').classList.toggle('calflow', flow)
  // 连续日历的顶栏（月份 / 每行几列 / 回到今天）。另外两屏没有这套东西，整块收起来
  const tools = $('caltools') as HTMLElement
  tools.innerHTML = flow ? calTools() : ''
  tools.hidden = !flow
  if (cal) {
    $('list').style.setProperty('--cal-cols', String(cal.cols))
    renderDetail()
    $('list').innerHTML = calendarGrid(calendarCells(visible, cal.days))
    restoreScroll()
    restoreTitleEdit()
    return
  }
  /**
   * 「连续日历」。两件事分开：
   *   刚进这一屏（flowFresh）、DOM 里还没有（切走过）、或者列数刚改过（一行几个格子变了，
   *     见 flowBuiltCols）—— 整套重铺并滚到今天那一格。
   *     这儿**不能走 restoreScroll**：keepScroll 那个锚点是从上一屏（普通列表）抓的，
   *     那条任务要是落在很远的某一天里，一锚就把刚滚好的"今天"顶走了。
   *   平时重画（勾完一条、别处同步过来）—— 只把已铺的那一段重画一遍，位置钉住。
   * 换语言不用另开一条路：重画每次都按当前语言生成（格子里的日期写法在里面）。
   * 搜索时这一屏退回普通列表（上面 flow 带 !results），DOM 里的格子就没了 ——
   * 清空搜索那一下因此也走"重铺"这条路，又落回今天那一格，和切进来时一致。
   */
  if (flow) {
    // 一行几个格子写进 --cal-cols，.calflowgrid 按它铺
    $('list').style.setProperty('--cal-cols', String(monthCols))
    renderDetail()
    const fresh = flowFresh || !flowBuilt() || flowBuiltCols !== monthCols
    flowFresh = false
    if (fresh) buildFlowSpan(visible)
    else {
      rebuildFlow(visible)
      restoreScroll()
    }
    restoreTitleEdit()
    return
  }
  const groups = results
    ? [{ label: '', wd: '', items: results }]     // 搜索结果按相关度排，不按日期分组
    : group(visible, view)
  if (!groups.reduce((n, g) => n + g.items.length, 0)) {
    $('list').innerHTML = `<div class="empty"><span class="big">🌿</span>${esc(
      results ? S.emptySearch
      : view === 'trash' ? S.emptyTrash : view === 'done' ? S.emptyDone : S.emptyList)}</div>`
    renderDetail()
    restoreScroll()
    restoreTitleEdit()
    return
  }
  renderDetail()
  // data-day：拖动的落点靠它认，和日历格子一套约定（逾期那格是 'overdue'）。
  // 只有"某一天"和"已逾期"这两类分组带它 —— "未安排"、搜索结果、已完成视图都没有，
  // 所以那些行既拖不动、也放不进去（见 dropAt）
  const dayAttr = (g: Group) => g.day !== undefined ? ` data-day="${g.day}"`
    : g.overdue ? ' data-day="overdue"' : ''
  $('list').innerHTML = groups.map(g => `<section class="group"${dayAttr(g)}>${
    g.label ? `<div class="ghead ${g.overdue ? 'overdue' : ''}">${g.label}${
      g.wd ? `<span class="wd">${g.wd}</span>` : ''}</div>` : ''
  }${g.items.map(t => row(t, doneList)).join('')}</section>`).join('')
  restoreScroll()
  restoreTitleEdit()
}

/**
 * 切视图。除换列表内容，还要把窗口大小在"哪一屏"之间换一下：日历视图和其余视图
 * 各记各的尺寸，切回去就是上次拖好的样子。主进程负责存取（见 window:switch）——
 * 先把当前大小记到离开的那一屏，再套上要进的那一屏的。同一个分组之间切就不折腾窗口。
 *
 * 顺便把这一屏记进 ui.json，下次打开就落在这儿。已完成 / 垃圾桶主进程不记
 * （见 ipc 的 RESTORABLE_VIEWS），所以退出时停在那两屏不会改掉落脚点。
 */
function setView(next: ViewId) {
  const from = viewSlot(view), to = viewSlot(next)
  view = next
  // 详情栏收没收起是**按视图分组**记的：切到日历就把这一屏上次的样子换回来，
  // 切回普通列表也换回普通列表那份。分组没变（今天 → 最近 7 天之间切）就不动它
  if (from !== to) { detailCollapsed = detailBySlot[to]; applyPanes() }
  // 连续日历：每次切进来都重铺一遍并回到今天那一格（见 flowFresh）
  if (next === CAL_FLOW) flowFresh = true
  render()
  void kapi['ui:setView'](next)
  if (from !== to) void kapi['window:switch'](to)
}

function row(t: Task, doneList = false): string {
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
               t.inProgress ? 'doing' : ''} ${
               t.important ? 'important' : ''} ${
               leaving.has(t.id) ? 'leaving' : ''}" data-task="${t.id}">
    ${doneList
      // 已完成列表：整行最左边是"几点几分完成的"，日期在分组标题上。
      // 刚取消勾选那条已经没时间了，照样占住这一格，免得整行往左跳一下
      ? `<span class="doneat">${t.completedAt ? hhmm(t.completedAt) : ''}</span>` : ''}
    <button class="box ${t.completedAt ? 'done' : ''}"
            data-act="${t.completedAt ? 'task:uncomplete' : 'task:complete'}" data-id="${t.id}"></button>
    <div class="body">${titleEditing === t.id
      ? `<input class="titleedit" data-titleedit="${t.id}" value="${esc(t.title)}">`
      : `<div class="title">${esc(t.title)}</div>`}${
      first ? `<div class="notefirst">${esc(first)}</div>` : ''}</div>${
    time ? `<div class="when">${time}</div>` : ''}${
    rep ? `<span class="tag rep">↻ ${esc(rep)}</span>` : ''}${
    t.inProgress ? `<span class="tag doing" title="${esc(S.inProgress)}">${esc(S.inProgress)}</span>` : ''}
  </div>`
}

/** 日历视图整块：格子按 --cal-cols 铺开。7d / 14d 的第一格是"已逾期"，自定义没有那格 */
function calendarGrid(cells: CalCell[]): string {
  return cells.map(c =>
    // data-day：拖动改期时的落点靠它认。逾期那格是 'overdue'，只能当起手、不能当落点
    `<section class="calcell${c.overdue ? ' overdue' : ''}${c.today ? ' today' : ''}" data-day="${c.key}">` +
    `<div class="calhead"><span class="dl">${esc(c.label)}</span>` +
    `<span class="ws">${c.wd ? `<span class="wd">${esc(c.wd)}</span>` : ''}` +
    `${c.items.length ? `<span class="n">${c.items.length}</span>` : ''}</span></div>` +
    (c.items.length
      ? c.items.map(t => calRow(t, c)).join('')
      // 空的一天给一道极淡的横杠：日历本来就常常是空的，别让人以为没画出来
      : `<div class="calempty">–</div>`) +
    `</section>`).join('')
}

/* ── 日历的顶栏 ──
 * 连续日历这一屏的控件都长在 #caltools 里（见 index.html）：
 *   当前滑到几月、每行放几列、回到今天
 * 用原生控件（select、button）就够，不自己画下拉 —— 那套在焦点和重画上最容易出岔子。
 */

/** 顶栏那块。月份 / 列数 / 回到今天，切语言时会跟着重刷（render 每次都重建） */
function calTools(): string {
  // 月份跟着滚动走（onFlowScroll 只换那一行字，不整块重画）。
  // flowLabel 是 buildFlowSpan 摆好的，而顶栏比那一步先画（render：先顶栏、再铺格子），
  // 所以第一帧它还是 0 —— 先报今天那个月，别让顶栏闪一下 NaN
  const cols = `<label class="calcolsel"><span>${esc(S.calendarColsLabel)}</span>` +
    `<select id="calcols">${Array.from({ length: MONTH_CAL_COLS.max - MONTH_CAL_COLS.min + 1 },
      (_, i) => MONTH_CAL_COLS.min + i).map(n =>
      `<option value="${n}"${n === monthCols ? ' selected' : ''}>${esc(S.calendarCols(n))}</option>`).join('')}` +
    `</select></label>`
  // 「回到今天」顶到最右边：左边是当前月份，两块分开摆才不显得挤在一起（见 .calnow）
  return `<div class="calpick">` +
    `<span class="calmonth">${esc(monthLabel(flowLabel || today()))}</span>` +
    `<button class="ghost calnow" data-caltoday>${esc(S.calendarToday)}</button>` +
    `</div>${cols}`
}

/** 顶栏上那个月份：中文 2026年9月，英文 September 2026 */
const monthLabel = (ts: number) => lang === 'en'
  ? new Date(ts).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  : `${new Date(ts).getFullYear()}年${new Date(ts).getMonth() + 1}月`

/* ── 「连续日历」：日子一天接一天铺下去，上下无限滚 ──
 * **不分月**：没有"一月一块"，也没有月初月末补出来的相邻月格子 —— 从今天起一天接一天，
 * 往前能一直看到几年前、往后一直看到几年后。逾期不单独占一格：它们就在自己原来那天，
 * 往上滚就看见了。
 *
 * 每行放几天由用户定（monthCols，3~7）—— 那只是"一行摆几个格子"，**7 列没有任何特殊含义**
 *（"周一到周日各占一列 + 顶上一条吸顶周几表头"是 7d / 14d 那两屏的事，这一屏列和星期
 * 本来就不对齐）。哪一天是几月几号，靠**每格自己带着的完整日期**认（见 dayCellHtml）。
 *
 * 不做"一次画十年"：每格都要装任务行，画十年就是几千个格子、上万个节点，进这一屏那一下
 * 就不轻了。所以按需接（见 extendFlow）。
 */

/** 一开始铺几行、滚到边再各接几行 */
const FLOW_INIT_ROWS = 8
const FLOW_STEP_ROWS = 4
/** 往前 / 往后最多各铺几年。按天算（闰年不差那一天），到边就停住 —— 是个靠山，不是墙 */
const FLOW_MAX_DAYS = 366 * 5
/** 离列表上/下边多近就开始接。比一屏矮一点：滚到底之前就接上了，看不出停顿 */
const FLOW_EDGE = 400

/**
 * 这一段连续的日子：从哪天画起（零点）、一共几天。**总是列数的整数倍**，行才是满的。
 * flowBack 是"往前铺到了离今天多少天"——今天就在这一段里，"回到今天"和接日子的边界都按它算。
 * 进这一屏时特意比今天早一整行：今天顶上还留着几天，往回滚不用先等一次"接"。
 */
let flowFrom = 0
let flowDays = 0
let flowBack = 0
/** 这一屏的格子是按哪批任务画的。接日子时接着用它分桶，不再重新筛一遍 */
let flowTasks: Task[] = []
/** 顶栏那行月份报的是哪天所在的月（跟着可视区顶部那一格走） */
let flowLabel = 0
/**
 * 刚进这一屏：下一次 render 重铺那一段、并滚到今天那一格。
 * "这一笔刚落地"时置一次，用完就清。这一屏每次切进来都要回到今天 —— 浏览器的滚动位置
 * 留不住，与其从上次停的地方开始看，不如每次都停在"我站在哪儿"。
 */
let flowFresh = false
/** 这一屏铺起来没有（切走过再回来要整套重铺） */
const flowBuilt = () => !!$('list').querySelector('.calflowgrid')
/**
 * 已经铺出来的那一串是按几列铺的。列数一改就得整铺 —— 一行几个格子变了，光换 CSS 变量
 * 只会把旧结构拉变形，接下去的日子还会按新列数排，两头对不上。
 */
let flowBuiltCols = 0

/** 排过期的任务按天分桶。口径和 calendarCells 一致：按**原来安排的那天** */
function bucketByDay(list: Task[]): Map<number, Task[]> {
  const byDay = new Map<number, Task[]>()
  for (const t of list) {
    if (t.startAt === undefined) continue
    const d = dayStart(t.startAt)
    const arr = byDay.get(d) ?? []
    arr.push(t); byDay.set(d, arr)
  }
  return byDay
}

/* ── 推演：周期任务未来会排在哪几天 ──
 * 存储层只在**完成**的时候派生下一期（见 core 的 nextOccurrence），所以库里躺着的一条
 * "每天读书 20 分钟"永远只占一天。这一屏把它往后推演的日期也画出来 —— **置灰、只读**：
 * 它不是任务，勾不了、删不了、拖不动，也不进侧栏那个条数。
 *
 * 每个系列只从**最新那一期**往后推：一个系列在库里可能躺着好几期（做完的旧期 + 当前这期），
 * 从每一期都推一遍会和真实存在的那些期撞上，同一天画两行。
 *
 * 两种不推：
 *   mode: 'afterCompletion' —— 下一期取决于你什么时候勾完，算不出来（不是算不准）
 *   规则里有 UNTIL（occurrencesBetween 到头了）—— 系列那天就结束了
 */

/** 推演最多铺到"今天 + 1 年"。DOM 的上限：一个每日任务往后一年就是 366 行。
 *  滚过一年之后不再有新的推演（老的那些照旧留着） */
const PROJECT_AHEAD = 1
/** 一个系列最多推演多少期。保险丝：规则写歪了（比如每 1 天 × 好几个系列）也不至于卡住界面 */
const PROJECT_MAX = 400

/** 推演出来的一行。它不是任务，所以只有画一行要用的这三样 */
type Proj = { title: string; clock: string; rep: string }

/** 今天往后一年那天的零点。按日期加，不按 365 天 —— 闰年不该差一天 */
function yearAhead(): number {
  const d = new Date(today())
  d.setFullYear(d.getFullYear() + PROJECT_AHEAD)
  return +d
}

/**
 * 按天算推演，只管 from..to 这一段（已经铺出来的那些天）。推演跟着滚动走，
 * 最远铺到今天 + 1 年 —— 所以往回滚、滚过一年，都不会多出新的行来。
 */
function projectDays(list: Task[], from: number, to: number): Map<number, Proj[]> {
  const out = new Map<number, Proj[]>()
  if (!projectRepeat) return out
  const end = Math.min(to, yearAhead())
  if (end < from) return out
  // 一个系列只留最新那一期（startAt 最大的那条）
  const latest = new Map<string, Task>()
  for (const t of list) {
    if (!t.repeat || t.repeat.mode === 'afterCompletion' || t.startAt === undefined) continue
    const key = t.seriesId ?? t.id
    const cur = latest.get(key)
    if (!cur || t.startAt > cur.startAt!) latest.set(key, t)
  }
  for (const t of latest.values()) {
    const rule = parseRrule(toRruleString(t.repeat!))
    if (!rule) continue                    // 读不懂的规则不猜，宁可不推
    const rep = describeRepeat(t.repeat!, lang)
    const clock = t.isAllDay ? '' : hhmm(t.startAt!)
    for (const at of occurrencesBetween(rule, t.startAt!, from, end, PROJECT_MAX)) {
      const d = dayStart(at)
      const arr = out.get(d) ?? []
      arr.push({ title: t.title, clock, rep })
      out.set(d, arr)
    }
  }
  return out
}

/**
 * 推演出来的一行：置灰、只读。
 *
 * **它身上没有 data-task / data-id，也没挂 .task 这个类** —— 勾选、点开详情、就地改名、
 * 拖动改期、右键菜单那几套一律按它们认（见"拖任务"那一段和 contextmenu 那几处），
 * 不给就自然碰不到它。这不是"顺手少写两个属性"，是这一行的定义：推演不是任务。
 *
 * ↻ 占着勾选圈那一列，标题于是和上面真实任务对齐；完整说法（推演 + 规则 + 钟点）
 * 挂在 title 上，窄格里截断了也看得到。
 */
function projRow(p: Proj): string {
  const tip = [S.projectTag, p.rep, p.clock].filter(Boolean).join(' · ')
  return `<div class="calrow calproj" data-proj="1" title="${esc(tip)}">` +
    `<span class="pjmark" aria-hidden="true">↻</span>` +
    `<div class="body"><div class="title">${esc(p.title)}</div>${
      p.clock ? `<div class="calmeta"><span>${esc(p.clock)}</span></div>` : ''}</div></div>`
}

/**
 * 连续日历里的一天。**共用的 .calcell 和 data-day 一个都不能少**：拖动改期、落点高亮、
 * 点任务看详情、就地改标题那几套都是按它们认的（见"拖任务"那一段），
 * 换个类名就等于把那几套交互全丢了。
 *
 * **每格自己带完整日期**（2026-10-01）：这一屏不分月、也没有顶上那条周几表头，
 * 不写全就不知道这一格是哪天。表头和 7d / 14d 那两屏是**同一套**（.calhead）：
 * 上面一行日期、下面一行周几 + 条数，两行分开才不会互相挤（见 index.html）。
 * 周末那两天日期换成强调色（.calday.we）—— 一屏数字扫下来，就靠它认出周末。
 *
 * 那串日期本身就有 10 个字符，格子窄了要靠 CSS 按格子的实际宽度让位
 *（见 index.html 的 @container）：先收表头内边距、再收字号。**任何一档都不许截日期**
 *（截成"2026-10-"就不知道是哪天了）。放在 CSS 里而不是这儿：窗口宽度变了不会重画，
 * 只有容器查询跟得上。
 *
 * 今天那一格由 .calcell.today 点亮表头那一条，日期也跟着变成强调色。
 *
 * **行不缩档**（不设 cell.compact）：这一屏的格子和 14d 一样宽，任务行就该和它长得一样 ——
 * 同样的 17px 勾选圈、13.5px 标题、同样的元信息写法。
 *
 * 真实任务在前、推演在后：一格里先看"这天真有什么事"，再看"周期任务往后会排到这天"。
 * 表头第二行那个条数也分开报（"3+5" = 3 条真的 + 5 条推演），而且**只在推演开着时报** ——
 * 关掉推演，表头就只剩日期 + 周几（见下面那一段和 projectRepeat）。
 */
function dayCellHtml(day: number, ctx: CalCtx): string {
  const items = byTime(ctx.byDay.get(day) ?? [])
  const projs = ctx.projs.get(day) ?? []
  const cell: CalCell = { key: String(day), label: '', wd: '', items,
                          today: day === ctx.t0, day }
  const tip = [dayFull(day), projs.length ? `${S.projectTag} ${projs.length}` : '']
    .filter(Boolean).join(' · ')
  // 周末：getDay() 里 0 是周日、6 是周六
  const dow = new Date(day).getDay()
  return `<section class="calcell calday${cell.today ? ' today' : ''}${
      dow === 0 || dow === 6 ? ' we' : ''}"` +
    ` data-day="${day}" title="${esc(tip)}">` +
    `<div class="calhead"><span class="dl">${esc(S.cellDay(new Date(day)))}</span>` +
    // 周几写全（"周一"），不缩成一个字：这一屏没有周几表头，一个字容易看成一横
    `<span class="ws"><span class="wd">${esc(weekday(day))}</span>` +
    // 条数紧跟在周几后面（和 14d 同一个位置）：一眼看出"这天还有几条"。
    // **只在推演开着时报**：这个数是"真实 + 推演"合起来看的（推演那部分压淡一档、
    // 前面带个 +），不推演的时候光报真实条数就成了纯噪声 —— 几条任务格子里本来就数得清。
    // 关掉推演，表头就只剩日期 + 周几（见 projectRepeat）
    `${projectRepeat && (items.length || projs.length)
      ? `<span class="n">${items.length || ''}${
        projs.length ? `<span class="pn">+${projs.length}</span>` : ''}</span>` : ''}</span></div>` +
    // 空的一天什么都不画：日历本来就常常是空的，每格都来一道横杠反而吵
    items.map(t => calRow(t, cell)).join('') +
    projs.map(p => projRow(p)).join('') +
    `</section>`
}

/** 铺格子要的东西：按天分好的真实任务、按天分好的推演、以及"今天是哪天" */
type CalCtx = { byDay: Map<number, Task[]>; projs: Map<number, Proj[]>; t0: number }
/** 备好一段格子的原料。from..to 是这段格子覆盖的第一天和最后一天（含头含尾） */
const ctxOf = (list: Task[], from: number, to: number): CalCtx =>
  ({ byDay: bucketByDay(list), projs: projectDays(list, from, to), t0: today() })

/** 把一段连续的日子（from 起 days 天）铺成格子。接日子时也用它接一段 */
function flowBlockHtml(from: number, days: number, ctx: CalCtx): string {
  let out = ''
  for (let i = 0; i < days; i++) out += dayCellHtml(addDays(from, i), ctx)
  return out
}

/** 按 flowFrom / flowDays 把整段日子画出来 */
function flowHtml(list: Task[]): string {
  const ctx = ctxOf(list, flowFrom, addDays(flowFrom, flowDays - 1))
  return `<div class="calflowgrid">${flowBlockHtml(flowFrom, flowDays, ctx)}</div>`
}

/** 重铺已铺的这一段。滚动位置由 render 里那对 keepScroll / restoreScroll 钉住 */
function rebuildFlow(list: Task[]): void {
  flowTasks = list
  flowBuiltCols = monthCols
  $('list').innerHTML = flowHtml(list)
}

/**
 * 滚到今天那一格 —— 进这一屏的第一件事。今天在第一行，所以这一格滚到顶上就对了
 *（这一屏没有吸顶元素要减，顶栏长在列表外面）。
 *
 * 走"拿到手的位置再拼回滚动坐标"，不用 offsetTop：那个元素的 offsetParent 不一定是 #list，
 * 减出来会偏小半屏。
 */
function scrollToToday(): void {
  const list = $('list')
  const cell = list.querySelector<HTMLElement>('.calday.today')
  if (!cell) return
  const off = cell.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
  list.scrollTop = Math.max(0, off)
}

/**
 * 进这一屏（从别的列表切过来、或者重开应用落在这儿）：重铺一段，把**今天那一格**摆到
 * 可视区顶上。每次都重铺而不是接着上次那一段：滚动位置本来就留不住，重铺最省事，
 * 也顺带把很久没打开、已经过去的那些日子收回来。
 */
function buildFlowSpan(list: Task[]): void {
  const t0 = today()
  // 提前一整行：今天顶上还留着几天，往回滚不用先等一次"接"
  flowBack = monthCols
  flowFrom = addDays(t0, -flowBack)
  flowDays = FLOW_INIT_ROWS * monthCols
  flowLabel = t0
  rebuildFlow(list)
  scrollToToday()
}

/**
 * 滚到上/下边就往前/往后接一段日子。
 *
 * 接的一律是**整行**（列数的整数倍），这样新接的那几行和原来的行才对得齐。
 * 往上接**必须把 scrollTop 补上新增的高度**：内容在顶部长出来，不补的话用户正看着的
 * 日期会整体往下跳一大截。接完就离边远了，回路自然收住 —— 接一次长出来一千多像素，
 * 离边不再是 FLOW_EDGE 以内，再滚一下也不会又接一次。
 * （别改成"滚到边就无限接"：接一次又触发一次 scroll 事件，那样会滚成雪球。）
 */
function extendFlow(): void {
  const list = $('list')
  const grid = list.querySelector<HTMLElement>('.calflowgrid')
  if (!grid) return
  const step = FLOW_STEP_ROWS * monthCols
  const fwdSpan = flowDays - 1 - flowBack        // 往后已经铺到离今天多少天
  if (list.scrollTop < FLOW_EDGE && flowBack < FLOW_MAX_DAYS) {
    const n = Math.min(step, FLOW_MAX_DAYS - flowBack)
    const from = addDays(flowFrom, -n)
    const before = list.scrollHeight
    grid.insertAdjacentHTML('afterbegin',
      flowBlockHtml(from, n, ctxOf(flowTasks, from, addDays(from, n - 1))))
    flowFrom = from
    flowBack += n
    flowDays += n
    list.scrollTop += list.scrollHeight - before
  }
  const left = list.scrollHeight - list.scrollTop - list.clientHeight
  if (left < FLOW_EDGE && fwdSpan < FLOW_MAX_DAYS) {
    const n = Math.min(step, FLOW_MAX_DAYS - fwdSpan)
    const from = addDays(flowFrom, flowDays)
    grid.insertAdjacentHTML('beforeend',
      flowBlockHtml(from, n, ctxOf(flowTasks, from, addDays(from, n - 1))))
    flowDays += n
  }
}

/**
 * 滚动：先接日子，再把顶栏那行月份换成可视区顶部那一格所在的月。
 *
 * "现在滑到几月"直接问列表顶上那一格是谁（elementFromPoint）—— 一圈格子几千个，
 * 每个都量一遍 rect 再比位置，滚动时一秒几十次撑不住。
 */
function onFlowScroll(): void {
  const list = $('list')
  const grid = list.querySelector<HTMLElement>('.calflowgrid')
  if (!grid) return
  extendFlow()
  /**
   * 问"列表顶上压着哪一格"。**要从格子的坐标起算，不能拿列表的**：
   * 列表四周有内边距，从那儿取点问到的永远是列表自己（踩过：月份一直不跟着滚）。
   * 纵向往里试几个点是为了跨过格子之间那道 4px 的缝 —— 正好落在缝里也一样问不到人。
   */
  const gr = grid.getBoundingClientRect(), lr = list.getBoundingClientRect()
  const x = gr.left + 4, y0 = Math.max(gr.top, lr.top)
  let day = 0
  for (const dy of [4, 10, 18]) {
    const el = document.elementFromPoint(x, y0 + dy) as HTMLElement | null
    const v = Number(el?.closest<HTMLElement>('.calday')?.dataset['day'])
    if (Number.isFinite(v) && v > 0) { day = v; break }
  }
  // 一个都问不到（DOM 约定被改坏了）就当没读到：宁可顶栏停在原来那个月，
  // 也不能把 NaN 写进去 —— 那一行会变成"NaN年NaN月"
  if (!day) return
  if (monthLabel(day) === monthLabel(flowLabel)) return
  flowLabel = day
  // 只换那一行字 —— 整块重画的话，滚动中光标底下的 DOM 会被换掉
  const box = document.querySelector<HTMLElement>('#caltools .calmonth')
  if (box) box.textContent = monthLabel(day)
}

/**
 * 日历视图里的任务行。格子只有一百来像素宽，所以时间、重复标签挪到标题下面一行，
 * 不跟标题抢宽度；其余（勾选、点开详情、点标题就地改名、右键菜单）和列表行完全一样 ——
 * 都挂在 .task / .title / [data-act] 上，事件那套代码不用为这个视图分叉。
 *
 * cell 是这行所在的格子：已完成的行挂在**原来安排的那天**，行上给的是**完成时间**
 * （带个 ✓，免得跟原定的时间看混）。完成日和这格不是同一天时（提前做完、事后补勾），
 * 光给钟点看不出是什么时候了结的 —— 那就把完成日期也带上（见下面的 doneDay）。
 * 逾期那格的未完成任务同理，补的是原来的日期（那格表头只有"已逾期"三个字）。
 *
 * 窄格（连续日历，cell.compact）里那串写不下：一格才 90 来像素，行里留给元信息的地方
 * 只有 30px，"✓ 今天 13:28" 折起来会把整行撑成三行高、把日历的节奏打乱。这一屏索性不写 ——
 * "做完了"由勾上的圆圈和划掉的标题说（和"已完成"列表一个意思），几点几分完成的、
 * 完成日是不是这一天，悬浮（title）和详情栏里都有。
 */
function calRow(t: Task, cell: CalCell): string {
  const done = showDone && t.completedAt !== undefined
  const clock = t.startAt !== undefined && !t.isAllDay ? hhmm(t.startAt) : ''
  // 完成那天（零点）。只有日期相同才省掉日期 —— cell.day 是"这一格是哪天"，
  // "已逾期"格没有具体哪一天（undefined），所以落在它里面的行一定会把日期写出来
  const doneDay = t.completedAt !== undefined ? dayStart(t.completedAt) : 0
  const fullWhen = done
    ? `✓ ${doneDay !== cell.day ? `${dayLabel(doneDay)} ` : ''}${hhmm(t.completedAt!)}`
    : cell.overdue && t.startAt !== undefined
      // 逾期那一格的表头只有"已逾期"，不带原来的日子就不知道拖了多久（和列表行同理）
      ? [dayLabel(t.startAt), clock].filter(Boolean).join(' ')
      : clock
  const when = cell.compact && done ? '' : fullWhen
  const rep = t.repeat ? describeRepeat(t.repeat, lang) : ''
  /** 窄格那一行的悬浮提示：完整的完成说法 + 重复规则（正文里装不下，见上面那段） */
  const tip = cell.compact ? [fullWhen, rep ? `↻ ${rep}` : ''].filter(Boolean).join(' ') : ''
  // 窄格里整行元信息都可能被截断（时间和重复标签挤在 70px 里），所以把完整的那串
  // 挂到这一行的 title 上 —— 截掉的是什么，悬浮一下就看得到。
  // 有 tip 就照样把这个空壳画出来（窄格里已完成的那行正文是空的），否则没地方挂提示
  const meta = when || rep || tip
    ? `<div class="calmeta"${tip ? ` title="${esc(tip)}"` : ''}>${when ? `<span>${esc(when)}</span>` : ''}${
        // 重复标签在格子里放不下就截成省略号（见 index.html 的 .calrow .calmeta .tag.rep），
        // 所以整条规则挂在标签自己的 title 上 —— 截掉的那半句悬浮就看得到
        rep ? `<span class="tag rep" title="↻ ${esc(rep)}">↻ ${esc(rep)}</span>` : ''}</div>`
    : ''
  // 进行中：徽标钉在格子右上角，标题给它让出宽度（见 index.html 的 .calrow .tag.doing）。
  // 标题带 title：装不下时被截成一行加省略号，悬浮还能看全
  const prog = t.inProgress ? `<span class="tag doing">${esc(S.inProgress)}</span>` : ''
  // 开关打开时已完成的行留在原来的格子里（它挂在原定安排那天，勾完不动），不该走"淡出"
  // 那套；会消失的只有"排期在今天之前、刚勾完"的那条 —— 它在"已逾期"格里淡出再走（见 pick）
  const fading = leaving.has(t.id) &&
    (!showDone || (t.completedAt !== undefined && !!cell.overdue))
  return `<div class="task calrow ${t.completedAt ? 'is-done' : ''} ${t.id === selected ? 'sel' : ''} ${
               t.inProgress ? 'doing' : ''} ${
               t.important ? 'important' : ''} ${
               fading ? 'leaving' : ''}" data-task="${t.id}">
    <button class="box ${t.completedAt ? 'done' : ''}"
            data-act="${t.completedAt ? 'task:uncomplete' : 'task:complete'}" data-id="${t.id}"></button>${
    prog}<div class="body">${titleEditing === t.id
      ? `<input class="titleedit" data-titleedit="${t.id}" value="${esc(t.title)}">`
      : `<div class="title" title="${esc(t.title)}">${esc(t.title)}</div>`}${meta}</div>
  </div>`
}

/**
 * 详情栏的标题框（textarea）长多高：按内容折行后的实际高度来，长标题整条都看得见。
 *
 * 先把 height 清成 auto 再读 scrollHeight —— 否则读到的是上一次设进去的高度，
 * 标题改短以后框不会缩回去（清空时还会留一屏空白）。
 * rows="1" 只是没有脚本时的兜底；正常路径上高度都由这里给。
 */
function growTitle() {
  const el = $('dtitle') as HTMLTextAreaElement
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/**
 * 详情栏宽度一变（拖分隔线、双击复位、窗口缩放）标题就要重新量一次：
 * 折几行是跟着可用宽度走的，宽度变了行数就变了。
 * 观察 .detailpane 而不是标题框自己 —— 框的高度正是这里设的，
 * 盯着它容易绕成"量一次改一次"的循环。
 */
new ResizeObserver(() => growTitle()).observe($('detail'))

/** 右侧详情栏。点任务打开，展示标题、时间和备注 */
function renderDetail() {
  const t = selected ? tasks.find(x => x.id === selected) : undefined
  if (!t) { selected = null; editing = false }
  if (!t) {                                   // 备注栏常驻，没选中就显示提示
    ;($('dtitle') as HTMLTextAreaElement).value = ''
    growTitle()                               // 上一条的标题可能有好几行高，这里要缩回去
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

  if (!typingTitle) ($('dtitle') as HTMLTextAreaElement).value = t.title
  // 高度每次都重量一遍：正在打字的那个框不走上面这行，但它可能在没触发 input 的
  // 情况下变过内容（比如清空后 saveTitle 把原文写回来），高度得跟上
  growTitle()
  const d = t.startAt !== undefined ? new Date(t.startAt) : null
  const iso = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''
  const bits: string[] = []
  // 重复规则做成下拉，已创建的任务也能改
  if (t.completedAt) bits.push(S.isDone)
  if (t.deleted) bits.push(S.isTrashed)
  // 日期和时间可以直接改；清空日期就是"未安排"。
  // 叉号只在真有具体时间时出现，贴在时间框右边 —— 它只去掉时间，日期留着
  const timed = d !== null && !t.isAllDay
  if (!typingCustom && !whenBusy) $('dmeta').innerHTML =
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
       <div class="notehint">${esc(S.platform.notesHint(OS))}</div>`
    : `<div class="md" data-noteview="${t.id}">${renderMarkdown(t.notes ?? '')}</div>`
}

/**
 * 详情栏宽度。拖列表和详情栏之间那条分隔线来改，双击恢复默认。
 * 存进 ui.json —— 和语言、主题一样是本机的界面偏好，不进库目录、不跟着 iCloud 同步。
 */
const DETAIL_MIN_W = 260
let detailW = DEFAULT_DETAIL_WIDTH
/** 列表区至少留这么宽。窗口再窄也不能让详情栏把任务列表压没 */
const MAIN_MIN_W = 320
/** 侧边栏宽度，和 index.html 里 .app 第一列的兜底值（216px）对齐 —— 改一边要改两边。
 *  侧边栏收起时那一列是 0，这里仍旧按 216 算：夹详情栏宽度时保守一点没坏处，
 *  收起后多出来的地方留给任务列表 */
const SIDEBAR_W = 216
/** 夹一次：最小 260；最大不超过窗口的 60%，同时给列表区留够 320 */
function clampDetailW(w: number): number {
  const max = Math.max(DETAIL_MIN_W, Math.min(window.innerWidth * 0.6, window.innerWidth - SIDEBAR_W - MAIN_MIN_W))
  return Math.round(Math.max(DETAIL_MIN_W, Math.min(w, max)))
}
/**
 * 只改 CSS 变量、按**当前**窗口再夹一次。窗口被拖窄时不能让详情栏把列表挤没，
 * 但 detailW 本身不动 —— 窗口再放大回去，宽度还是用户当初拖的那个。
 */
function applyDetailW() {
  document.documentElement.style.setProperty('--detail-w', `${clampDetailW(detailW)}px`)
}

/**
 * 滚动：连续日历接日子 + 顶栏那个月份跟着走（onFlowScroll）。不在这一屏就什么都不做。
 */
$('list').addEventListener('scroll', onFlowScroll)

const resizeBar = $('dresize')
/** 拖动起点：鼠标 x、当时详情栏**显示**的宽度、以及拖之前的逻辑宽度 */
let resizeFrom: { x: number; w: number; w0: number } | null = null

resizeBar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()      // 别让这次按下顺手选中文字、把焦点挪走
  resizeFrom = { x: e.clientX, w: $('detail').getBoundingClientRect().width, w0: detailW }
  resizeBar.classList.add('on')
  document.body.classList.add('resizing')
  // 捕获指针：拖到窗口外面松手也收得到 pointerup。合成的 PointerEvent（探针）没有真实
  // 指针，捕获会抛 —— 忽略即可，监听挂在 document 上一样收得到
  try { resizeBar.setPointerCapture(e.pointerId) } catch { /* 没有真实指针 */ }
})
document.addEventListener('pointermove', (e) => {
  if (!resizeFrom) return
  detailW = clampDetailW(resizeFrom.w - (e.clientX - resizeFrom.x))
  applyDetailW()
})
document.addEventListener('pointerup', endResize)
document.addEventListener('pointercancel', endResize)
function endResize(e: PointerEvent) {
  const from = resizeFrom
  if (!from) return
  resizeFrom = null
  resizeBar.classList.remove('on')
  document.body.classList.remove('resizing')
  try { resizeBar.releasePointerCapture(e.pointerId) } catch { /* 见上 */ }
  // 拖了半天又拖回原位就不用写盘了。ui.json 是整份重写，没必要那么勤快
  if (detailW !== from.w0) void kapi['ui:setDetailWidth'](detailW)
}
/** 双击恢复默认宽度 */
resizeBar.addEventListener('dblclick', () => {
  detailW = DEFAULT_DETAIL_WIDTH
  applyDetailW()
  void kapi['ui:setDetailWidth'](detailW)
})
// 窗口变小了也要再夹一次，否则详情栏会把列表压没
window.addEventListener('resize', applyDetailW)

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
 * 详情栏里日期/时间/重复这一排（#dmeta）正在被点：mousedown 到 click 之间不要重建它。
 *
 * 和勾选、改标题同一个道理：mousedown 会把焦点从备注/标题编辑框里挪走 → focusout
 * → 保存 → render() → renderDetail 重建 dmeta，被点的日期框在 mouseup 之前就从 DOM 里
 * 消失了，click 落不到它身上 —— 日历按钮于是"第一下没反应，得点第二下"。
 * 而日历是原生控件，没法像勾选那样挪到 mousedown 里做，只能让 renderDetail 在这个
 * 空档里别碰 dmeta。
 */
let whenBusy = false
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
  whenBusy = false
  const target = e.target as HTMLElement
  // 连续日历顶栏那几件控件（月份、列数下拉、回到今天）：不是任务行，让后面的分支整个让开
  if (target.closest('#caltools')) return
  if (target.closest('#dmeta')) whenBusy = true
  const btn = target.closest<HTMLElement>('[data-act]')
  if (btn) {
    const act = btn.dataset['act'] as 'task:complete' | 'task:uncomplete'
    const id = btn.dataset['id']!
    if (act === 'task:complete' || act === 'task:uncomplete') void setDone(id, act === 'task:complete')
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
    // 点备注前先提交列表里正在编辑的标题（blur 走它的保存路径并关掉编辑态）。
    // 不处理的话，focusEditor() 给备注框 focus 时会把标题框挤掉焦 → saveRowTitle
    // 同步 render() → 刚 focus 的备注框被换掉，焦点落回 body，第一下就打不了字。
    ;(document.querySelector<HTMLInputElement>('[data-titleedit]'))?.blur()
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
  // 日历格子里的标题要等 pointerup 才进编辑态：这中间可能变成一次"拖到别的天"，
  // 一按下就进编辑的话，就没法从标题上起手拖了（见下面 pointerup 那段）
  if (row.closest('.calcell')) return
  beginTitleEdit(row.dataset['task']!, e.clientX, e.clientY)
  actedOnMousedown = true
})

/* ── 拖任务：日历格里排序/改期，列表的日期分组里排序/改期 ──
 *
 * 用 pointer 事件自己做，不上 HTML5 拖放：那一套和现有的 mousedown 交互（圆圈勾选、
 * 点标题就地改名）抢同一个按下事件，而这个列表里"点一下"和"拖一下"必须共存 ——
 * 按下先只记着，挪过 5px 才算拖，没挪就是一次普通的点。
 *
 * 一个手势干两件事：落在同一天就是**排序**（写 order），落到别的天就是**改期**
 * （写 startAt，时刻留着；全天任务本来就是零点，拖完还是全天）顺带排到那个位置。
 * 落点精确到"插在哪一条前面"：光标在行的上半就插它前面，下半就插它后面，
 * 那根 2px 的横线就是提示（见 index.html 的 .task.drop-before）。
 *
 * 两个视图共用这一套：起手行和落点都按 [data-task] 找，落点容器按 [data-day] 找 ——
 * 日历是 .calcell，列表是带 data-day 的那个 .group。所以"已逾期"和"未安排"这两组
 * （没有 data-day）既拖不动、也放不进去。
 */

/** 判断是"点"还是"拖"的分界（像素）。太小会把点击误判成拖动 */
const CAL_DRAG_MIN = 5
/** 拖动时贴住列表上/下边缘就自己滚。列表比日历长得多（"全部"能铺几十天），
 *  不滚就够不到别的日期分组 */
const SCROLL_EDGE = 32      // 离边缘多近开始滚
const SCROLL_STEP = 14      // 每一步滚多少像素
/** 光标不在任何一格里时，"就近认一格"的最大距离。得比分组之间那道 18px 的缝大 */
const NEAR_CELL = 24
/**
 * kind 记这条行是从哪儿起手的，两处的"点标题"规矩是相反的：
 *   cal  —— 日历格子。标题要等 pointerup 才进编辑态，否则没法从标题上起手拖
 *   list —— 列表。标题必须 mousedown 就进（见 mousedown 那段），所以真拖起来要
 *           先把那个输入框收掉
 */
type CalDrag = {
  id: string
  kind: 'cal' | 'list'
  x: number; y: number         // 按下时的光标位置
  title: boolean               // 按在标题上：松手没挪就是一次"改标题"（只有日历走这条路）
  on: boolean                  // 已经挪过阈值，真的在拖了
  drop: string | null          // 当前落点的标记，只有变了才动 DOM
}
/** 落点：目标容器 + 插在谁前面（null = 追加到那一格未完成列的末尾） */
type DropHit = {
  cell: HTMLElement
  day: string
  beforeId: string | null
  lineRow: HTMLElement | null  // 画插入线的那一行；null = 只亮容器（里面一条都没有）
  lineAfter: boolean
}
let calDrag: CalDrag | null = null
/** 刚拖完，压掉随之而来的那次 click（不然会顺手把任务选中、打开备注） */
let suppressClick = false
let dragGhost: HTMLElement | null = null

/** 拖动时跟着光标走的那张小卡片，让"正在拖哪条"看得见 */
function showGhost(id: string, x: number, y: number) {
  dragGhost = document.createElement('div')
  dragGhost.className = 'calghost'
  dragGhost.textContent = tasks.find(t => t.id === id)?.title ?? ''
  document.body.appendChild(dragGhost)
  moveGhost(x, y)
}
function moveGhost(x: number, y: number) {
  if (!dragGhost) return
  dragGhost.style.left = `${x + 12}px`
  dragGhost.style.top = `${y + 10}px`
}
/** 清掉落点提示。容器高亮和行上的插入线是两套，一起清 */
function clearDropMarks() {
  document.querySelectorAll('[data-day].drop').forEach(c => c.classList.remove('drop'))
  document.querySelectorAll('.task.drop-before, .task.drop-after')
    .forEach(r => r.classList.remove('drop-before', 'drop-after'))
}

/** 收尾：清掉所有拖动痕迹。指针在窗口外松手时指针事件收不到，所以窗口失焦也要清 */
function endCalDrag() {
  calDrag = null
  dragGhost?.remove()
  dragGhost = null
  document.body.classList.remove('caldragging')
  document.querySelectorAll('.task.dragging').forEach(r => r.classList.remove('dragging'))
  clearDropMarks()
  stopAutoScroll()
}

/** 一行的竖直中线。上半 = 插它前面，下半 = 插它后面 */
function rowMid(r: HTMLElement): number {
  const b = r.getBoundingClientRect()
  return b.top + b.height / 2
}

/** 第 i 行的前面/后面 → 落点。after 时 beforeId 是"下一行"，没有下一行就是追加 */
function hitAt(cell: HTMLElement, day: string, open: HTMLElement[], i: number, after: boolean): DropHit {
  const row = open[i]!
  return { cell, day, lineRow: row, lineAfter: after,
           beforeId: after ? open[i + 1]?.dataset['task'] ?? null : row.dataset['task']! }
}

/**
 * 光标不在任何一格里时，按距离就近认一格。
 *
 * 分组之间那道缝（margin 不在盒子里）归 #list 管，光标从一天的组往下挪到隔壁组时
 * 会经过它 —— 不就近认一格的话，落点在那儿会闪一下"无"，看着像放不进去。
 *
 * **横向也算进距离**：日历格与格之间只隔几个像素，只看纵向的话光标落在两行
 * 之间那道缝里时，认哪一格全看 DOM 顺序（永远是最左边那格），横向一动落点就乱跳。
 * 列表那边每一格都是整宽的，加上横向距离不影响它。
 *
 * max 卡死距离：列表底部那 40px、日历底部那半屏留白都不该算"落在最后一天上"。
 */
function nearestCell(x: number, y: number, max: number): HTMLElement | null {
  let best: HTMLElement | null = null, bestD = Infinity
  document.querySelectorAll<HTMLElement>('#list [data-day]').forEach(c => {
    if (c.dataset['day'] === 'overdue') return       // 逾期格当不了落点，别让它抢
    const r = c.getBoundingClientRect()
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
    const d = Math.hypot(dx, dy)
    if (d < bestD) { bestD = d; best = c }
  })
  return bestD <= max ? best : null
}

/**
 * 光标底下该插到哪。落点容器只能是"某一天"（有 data-day 且不是逾期）——
 * 逾期格跨好几天、未安排没日期，都当不了落点。
 * 已完成的行排不上序（日历里沉底、已完成视图里按完成时间），落在它上面按就近的行算。
 */
function dropAt(x: number, y: number): DropHit | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const cell = el?.closest<HTMLElement>('[data-day]')
    // 落在没有 data-day 的分组里（未安排、搜索结果）就是没有落点，别去就近认
    ?? (el?.closest('.group') ? null : nearestCell(x, y, NEAR_CELL))
  const day = cell?.dataset['day']
  if (!cell || !day || day === 'overdue') return null
  // 只有未完成的行排得上序
  const open: HTMLElement[] = Array.from(cell.querySelectorAll<HTMLElement>('[data-task]'))
    .filter(r => !r.classList.contains('is-done'))
  // 这一格里一条都没有：亮整个容器，插进去就是唯一那条
  if (!open.length) return { cell, day, beforeId: null, lineRow: null, lineAfter: false }
  const row = el?.closest<HTMLElement>('[data-task]')
  if (row && open.includes(row)) return hitAt(cell, day, open, open.indexOf(row), y > rowMid(row))
  // 表头、组之间的缝、行下面那片空白：第一行中线以上插最前，否则接在最后一行后面
  if (y < rowMid(open[0]!)) return hitAt(cell, day, open, 0, false)
  return hitAt(cell, day, open, open.length - 1, true)
}

/** 按当前光标位置更新落点提示。落点没换就不动 DOM，免得每动一下都重排 */
function updateDropMarks(x: number, y: number) {
  const d = calDrag
  if (!d) return
  const hit = dropAt(x, y)
  // 标记：行上是"哪一行、上半还是下半"，整格高亮就是容器本身
  const key = !hit ? null
    : hit.lineRow ? `${hit.day}:${hit.beforeId ?? ''}:${hit.lineAfter ? 'a' : 'b'}` : `${hit.day}:*`
  if (key === d.drop) return
  d.drop = key
  clearDropMarks()
  if (!hit) return
  if (hit.lineRow) hit.lineRow.classList.add(hit.lineAfter ? 'drop-after' : 'drop-before')
  else hit.cell.classList.add('drop')
}

/* 拖到列表上/下边缘时自己滚。每滚一步落点都会变，可指针没动、收不到 pointermove，
   所以这里自己把落点重算一次 */
let scrollTimer: number | null = null
let lastPointer = { x: 0, y: 0 }
function startAutoScroll() {
  if (scrollTimer !== null) return
  scrollTimer = window.setInterval(() => {
    if (!calDrag?.on) return
    const list = $('list'), r = list.getBoundingClientRect()
    const step = lastPointer.y < r.top + SCROLL_EDGE ? -SCROLL_STEP
      : lastPointer.y > r.bottom - SCROLL_EDGE ? SCROLL_STEP : 0
    if (!step) return
    const before = list.scrollTop
    list.scrollTop += step
    if (list.scrollTop !== before) updateDropMarks(lastPointer.x, lastPointer.y)
  }, 40)
}
function stopAutoScroll() {
  if (scrollTimer === null) return
  clearInterval(scrollTimer)
  scrollTimer = null
}

/** 某天里"未完成、按手排顺序"的那一串。逾期的不算 —— 那些归在第一格里。
 *
 * day 用的是格子上 data-day 的**原值**，不重新归一化：calendarCells 分组时也是拿
 * t0 + i*DAY 直接当键（夏令时切换那天它偏一小时），两边同一个口径才找得到同一批任务。
 */
function dayOpen(day: number): Task[] {
  return tasks.filter(t => !t.deleted && t.completedAt === undefined
    && t.startAt !== undefined && dayStart(t.startAt) === day).sort(byOrder)
}

document.addEventListener('pointerdown', (e) => {
  suppressClick = false
  endCalDrag()                 // 上一次没收尾（指针在窗口外松手），先清干净
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  const row = target.closest<HTMLElement>('[data-task]')
  if (!row || target.closest('[data-act]')) return      // 圆圈还是走勾选那条路
  // 只有"某一天"里的行能拖（逾期和未安排那两组没有 data-day）。落点可以是别的天，
  // 所以这里看的是**起手那一行**在哪
  if (!row.closest<HTMLElement>('[data-day]')?.dataset['day']) return
  // 日历格子里正在就地改标题的那一行不给拖：标题已经变成输入框，这时按住划一下
  // 多半是想选字，拖走会把打了一半的标题连任务一起甩到别的天去。
  // 要改期先退出编辑（回车 / esc / 点别处）。列表那边照旧 —— 真拖起来就把编辑框
  // 收掉（见下面 pointermove），那条路能拖是因为列表的标题在 mousedown 就进编辑态，
  // 不起手拖就等于没有"拖上一整行"这个手势了
  if (row.closest('.calcell') && titleEditing === row.dataset['task']) return
  calDrag = { id: row.dataset['task']!, kind: row.closest('.calcell') ? 'cal' : 'list',
              x: e.clientX, y: e.clientY, title: !!target.closest('.title'), on: false, drop: null }
})

document.addEventListener('pointermove', (e) => {
  const d = calDrag
  if (!d) return
  lastPointer = { x: e.clientX, y: e.clientY }
  if (!d.on) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < CAL_DRAG_MIN) return
    const t = tasks.find(x => x.id === d.id)
    // 已完成的不给拖：日历里它挂在"完成那天"、已完成视图按完成时间排，拖它改的是
    // 安排日期，位置根本不会动。与其看着像拖了没反应，干脆不给拖（点标题改名照旧）
    if (!t || t.completedAt !== undefined) return
    // 列表里点标题在 mousedown 就进编辑态了（那是防"点了没反应"的老规矩，动不了）。
    // 真拖起来先把那个框收掉：攒够 5px 才走到这儿，用户还一个字没打
    if (d.kind === 'list') {
      const ta = document.querySelector<HTMLInputElement>('[data-titleedit]')
      ta?.blur()
      // blur 之后补一次它自己的关闭路径。窗口没有系统焦点时（从别的应用切回来、
      // 焦点在别的窗口上）blur 不会发 focusout，光靠它编辑框会一直挂着。
      // saveRowTitle 自己有 closed 守卫，focusout 正常发过时这一次是空转
      if (ta && titleEditing) void saveRowTitle(ta)
    }
    d.on = true
    document.body.classList.add('caldragging')
    document.querySelector<HTMLElement>(`[data-task="${d.id}"]`)?.classList.add('dragging')
    showGhost(d.id, e.clientX, e.clientY)
    startAutoScroll()
  } else moveGhost(e.clientX, e.clientY)
  updateDropMarks(e.clientX, e.clientY)
})

document.addEventListener('pointerup', (e) => {
  const d = calDrag
  if (!d) return
  const on = d.on, id = d.id, title = d.kind === 'cal' && d.title
  const hit = on ? dropAt(e.clientX, e.clientY) : null
  endCalDrag()
  if (!on) {
    // 没挪 = 一次普通的点。日历里点标题进就地编辑放到这里：按下时就进的话没法起手拖。
    // 列表那边 mousedown 已经进过了，这里再来一次会把刚聚焦的框换掉
    if (title) { actedOnMousedown = true; beginTitleEdit(id, e.clientX, e.clientY) }
    return
  }
  suppressClick = true
  if (hit) void applyCalDrop(id, hit)
})
window.addEventListener('blur', endCalDrag)      // 指针跑出窗口松手，收不到 pointerup

/** 改期到某一天：时刻、分秒都留着；全天任务本来就是零点，改完还是全天 */
function sameClockOn(from: number, day: number): number {
  const src = new Date(from), dst = new Date(day)
  dst.setHours(src.getHours(), src.getMinutes(), src.getSeconds(), src.getMilliseconds())
  return +dst
}

/**
 * 把一条任务放到目标格的那个位置上。
 *
 * 正常情况一个手势只写一条 op：拿目标位置左右两条的 order 算出夹在中间的 key
 *（docs/storage.zh.md §7.3）。跨天时 startAt 一起写，两条 op 同一次落盘。
 * 老库的 16 位时间戳 key 挨得极近时，两个邻居之间可能一个空位都没有 ——
 * core 的 orderBetween 那时返回 null，这里就把那一格按当前顺序整格重铺一遍。
 *
 * 已完成的行按完成那天归格，拖它改的是安排日期、格子不会动；与其看着像拖了没反应，
 * 干脆不给拖（见 pointermove 里的守卫）。
 */
async function applyCalDrop(id: string, hit: DropHit) {
  const t = tasks.find(x => x.id === id)
  if (!t || t.startAt === undefined) return
  const day = Number(hit.day)
  const sameDay = day === dayStart(t.startAt)
  // 目标格未完成的那一串（**含**被拖的这条）和摘掉它之后的槽位。
  // 插槽按"含自己"的那份算，落在自己头上（beforeId 就是自己）才会算成原地不动 ——
  // 摘掉之后再 findIndex 找的是"下一格槽位"，会把原地一下拖成追加到末尾
  const all = dayOpen(day)
  const cur = sameDay ? all.findIndex(x => x.id === id) : -1
  const rest = all.filter(x => x.id !== id)
  const j = hit.beforeId === null ? -1 : all.findIndex(x => x.id === hit.beforeId)
  const at = j < 0 ? rest.length : all.slice(0, j).filter(x => x.id !== id).length
  // 原地没动就什么都不写：否则每点一下都白写一条 op，order 还会越切越碎
  if (sameDay
    && (rest[at - 1]?.id ?? null) === (all[cur - 1]?.id ?? null)
    && (rest[at]?.id ?? null) === (all[cur + 1]?.id ?? null)) return
  const startAt = sameDay ? t.startAt : sameClockOn(t.startAt, day)
  const rows: FieldOpIpc[] = []
  const order = orderBetween(rest[at - 1]?.order ?? null, rest[at]?.order ?? null)
  if (order === null) {
    // 挤满了：按"落下之后"的顺序把整格重铺一遍，落点就用重铺给它的 key
    const seq = [...rest.slice(0, at), t, ...rest.slice(at)]
    for (const { id: x, key } of spreadOrders(seq.map(x => x.id))) rows.push({ id: x, f: 'order', val: key })
  } else rows.push({ id, f: 'order', val: order })
  if (!sameDay) rows.push({ id, f: 'startAt', val: startAt })
  await kapi['task:setMany'](rows)
}

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
  whenBusy = false        // 这次点完，允许 renderDetail 重建 dmeta
  // 刚在日历里拖完一条：这次 click 是拖动收尾，不是"点选"，扔掉
  if (suppressClick) { suppressClick = false; return }
  // mousedown 里已经处理完的（勾选、进入改标题），click 不要再来一遍
  if (actedOnMousedown) { actedOnMousedown = false; return }
  const target = e.target as HTMLElement
  const nav = target.closest<HTMLElement>('[data-view]')
  if (nav) { setView(nav.dataset['view'] as ViewId); return }
  // 列数那个 <select> 由下面的 change 处理：这里只把它让开，别当成任务行去处理  // 列数那个 <select> 由下面的 change 处理：这里只把它让开，别当成任务行去处理
  // 连续日历的「回到今天」：只滚回今天那一格，不重铺（接出来的日子留着）。
  // 顶栏那行月份由滚动事件自己跟上（scrollToToday 改了 scrollTop）
  if (target.closest('[data-caltoday]')) {
    scrollToToday()
    return
  }
  if (target.id === 'dclear' && selected) {
    // 走和"手动把时间框清空"完全同一条路：日期不动，任务变成全天
    ;($('dtime') as HTMLInputElement).value = ''
    void saveWhen(); return
  }
  const noteview = target.closest<HTMLElement>('[data-noteview]')
  if (noteview && !(target instanceof HTMLAnchorElement)) {
    ;(document.querySelector<HTMLInputElement>('[data-titleedit]'))?.blur()
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
    // 普通视图（最近 7 天 / 30 天这些）里点任务就把详情栏拉回来：收起只是想把列表
    // 铺满看安排，点一条就是想看它的详情，没道理还要再点一次 » 才展开。
    // 日历视图不拉 —— 那里点一下常常只是换选中，展开详情会把格子挤小（照旧手动展开）
    if (detailCollapsed && !isCalView(view)) await setDetailCollapsed(false)
    // 还没写过备注就直接进编辑，省一次点击。详情栏收着时不进 ——
    // 那个 textarea 在 display:none 的栏里 focus 不上，硬设 editing 只会让它
    // 挂在"编辑中"这个状态上，下次展开详情栏无缘无故就弹出编辑器
    editing = !detailCollapsed && !tasks.find(t => t.id === id)?.notes?.trim()
    render(); focusEditor(); return
  }
  const btn = target.closest<HTMLElement>('[data-act]')
  if (!btn) return
  const act = btn.dataset['act'] as 'task:complete' | 'task:uncomplete' | 'task:trash' | 'task:restore'
  if (act === 'task:complete' || act === 'task:uncomplete') { await setDone(btn.dataset['id']!, act === 'task:complete'); return }
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
  const dt = $('dtitle') as HTMLTextAreaElement
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
 *
 * 去处按**这个输入框长在哪**判断，不能看 customFor：详情栏那个框提交后不会马上消失
 * （焦点还在里面，renderDetail 的 typingCustom 守卫会跳过 #dmeta 重建），用户看它没收起
 * 再按一次回车时 customFor 已经是 null，一掉进下面的添加栏分支，就把"每 11 天"写成
 * 新建任务的默认重复，之后每条新任务都带着它。
 */
function commitCustomDays(el: HTMLInputElement) {
  const n = Math.floor(Number(el.value))
  const ok = Number.isFinite(n) && n >= 1 && n <= 999
  const detail = !!el.closest('#dmeta')
  customFor = null
  if (detail) {
    // 先把焦点交出去，否则 renderDetail 仍以为正在这个框里打字、不重建 #dmeta ——
    // 输入框会一直挂着，下拉也停在旧规则上看不到刚存的"每 N 天"
    el.blur()
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

/**
 * 新任务落在哪：那一天已排最后一条的后面。
 *
 * "哪一天"只有渲染进程算得出来（本地时区的零点，core 不碰时区），所以落点在这里
 * 算好、随 task:create 一起发过去。不带的话 core 只能按创建时间给个 key ——
 * 在手动排过序的格子里会插到当中去，明明是刚加的任务却出现在中间。
 */
function orderForNewDay(startAt: number): string {
  const day = dayStart(startAt)
  let last: string | null = null
  for (const t of tasks) {
    if (t.deleted || t.startAt === undefined || dayStart(t.startAt) !== day) continue
    if (t.order && (last === null || t.order > last)) last = t.order
  }
  return orderBetween(last, null)!
}

const ti = $('newTitle') as HTMLInputElement
const di = $('newDate') as HTMLInputElement
const ni = $('newTime') as HTMLInputElement
const ri = $('newRepeat') as HTMLSelectElement

/**
 * 添加栏的日期/时间是不是"从标题里认出来、自动填的"。
 * 用户自己动过哪个框，就不再覆盖哪个 —— 边打字边把他刚选的日期冲掉最招人烦。
 */
let dateAuto = false
let timeAuto = false
let dateManual = false
let timeManual = false

/** 当天第几分钟 → <input type=time> 认的 HH:mm。那个控件只认 24 小时制（见 hhmm24） */
const timeValue = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** <input type=date> 要的 YYYY-MM-DD。按本地时区拼，不能用 toISOString —— 那是 UTC */
function dateValue(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 边打字边认标题里的日期和时间，认到就预填，**标题原文一个字不动**。
 * 用户改过的框不覆盖；认不出来了就把**自动填的**擦掉 —— 删掉"明天"之后
 * 框里还留着明天，回车就存错了。
 */
function syncWhenFromTitle() {
  const hit = parseWhenIn(ti.value)
  let changed = false
  if (hit?.day !== undefined && !dateManual) {
    const v = dateValue(hit.day)
    if (di.value !== v) { di.value = v; changed = true }
    dateAuto = true
  } else if (dateAuto && !dateManual) {
    di.value = ''; dateAuto = false; changed = true
  }
  if (hit?.minutes !== undefined && !timeManual) {
    const v = timeValue(hit.minutes)
    if (ni.value !== v) { ni.value = v; changed = true }
    timeAuto = true
  } else if (timeAuto && !timeManual) {
    ni.value = ''; timeAuto = false; changed = true
  }
  // 日期变了，重复预设（"每月第二个周二"那种）得跟着重算
  if (changed) syncNewRepeat()
}

/** 建完一条，添加栏整个复位（预填标记也要清，下一条从头认） */
function resetAddBar() {
  ti.value = ''
  di.value = ''
  ni.value = ''
  ri.value = ''
  dateAuto = false
  timeAuto = false
  dateManual = false
  timeManual = false
  syncNewRepeat()
}

ti.addEventListener('input', syncWhenFromTitle)
ti.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !ti.value.trim()) return
  const time = ni.value
  // 没选日期就是今天；只认到时间没认到日期，也算今天那个点
  const at = di.value
    ? +new Date(`${di.value}T${time || '00:00'}`)
    : time ? +new Date(`${dateValue(today())}T${time}`) : today()
  const id = await kapi['task:create']({
    title: ti.value.trim(),
    startAt: at,
    isAllDay: !time,                  // 填了时间才算"定了点"，空着就是全天
    order: orderForNewDay(at),
    ...(ri.value ? { repeat: { rrule: ri.value } } : {}),
  })
  resetAddBar()
  // 刚建的任务直接接进详情栏 —— 建完常常还要补备注、改时间、加重复，
  // 不然得回列表里找它、再点开一次。焦点仍然留在添加栏（上面刚清空），
  // 所以连着敲下一条不会被打断
  selected = id
  remember(id)
  editing = false
  // 正常情况下 tasks:changed 比这条命令先回来。推送要是还没到，就自己拉一次 ——
  // 少了这步 ensureSelection 找不到新任务，会退回列表第一条，详情栏显示错的
  if (!tasks.some(t => t.id === id)) tasks = await kapi['task:list']()
  render()
  // 新任务可能落在列表可视区之外，带一下看不出来它去哪了
  document.querySelector<HTMLElement>(`[data-task="${id}"]`)?.scrollIntoView({ block: 'nearest' })
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
    // 切库不换列表：停在哪一屏是全局偏好（用户选的），换个库接着看同一屏
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
  render()                             // 同上，切库不换列表
})

/** 详情栏里的标题就地编辑。回车或失焦保存，esc 还原；不接受清空 */
async function saveTitle() {
  const el = $('dtitle') as HTMLTextAreaElement
  const id = selected
  if (!id) return
  const t = tasks.find(x => x.id === id)
  const next = el.value.trim()
  if (!t || next === t.title) return
  if (!next) { el.value = t.title; return }     // 没有标题的任务只会让人困惑
  await kapi['task:setField'](id, 'title', next)
}

$('dtitle').addEventListener('keydown', (e) => {
  const el = e.target as HTMLTextAreaElement
  // 回车直接保存，不绕 blur —— 那条路依赖焦点状态，边界情况下会静默不保存
  if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void saveTitle(); el.blur() }
  // esc 同样是保存后收起，不还原
  if ((e as KeyboardEvent).key === 'Escape') { e.preventDefault(); void saveTitle(); el.blur() }
})
$('dtitle').addEventListener('blur', () => void saveTitle())
// 边打边长：打到第二行就看得出来长了，不用等失焦（renderDetail 里那个 typingTitle 守卫
// 保证重建时跳过这个框，所以这里改高度不会被打断）
$('dtitle').addEventListener('input', growTitle)

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
  // 这次交互定下来了（选了日期 / 选了重复规则），whenBusy 可以放开。
  // 不能只靠 click：原生下拉在 macOS 上是系统弹层，点开时 click 不一定落在
  // 这个 select 上 —— 只挂 click 的话 whenBusy 会一直立着，dmeta 再也不重建，
  // 选「自定义天数…」那个输入框就永远不出现
  whenBusy = false
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
  if (el.id === 'newDate') {
    // change 只在用户真的动了控件时来（代码赋 value 不触发），所以这里就是"他手动选了"
    dateManual = true
    dateAuto = false
    syncNewRepeat()      // 换了日期，重复预设跟着变
  }
  if (el.id === 'newTime') { timeManual = true; timeAuto = false }
  // 连续日历每行几列。存下去之后要整铺：一行几个格子变了，不光是个 CSS 变量的事
  if (el.id === 'calcols') {
    const n = Number((el as HTMLSelectElement).value)
    void kapi['ui:setMonthCalCols'](n).then(saved => { monthCols = saved; render() })
  }
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

/**
 * 主题开关。点了就固定成另一档 —— 没碰过这个开关时是"跟系统"（主进程的默认），
 * 碰过之后就不再跟系统了，和语言按钮一样存在 ui.json 里、不进库目录。
 */
document.addEventListener('click', async (e) => {
  if (!(e.target as HTMLElement).closest('[data-themesw]')) return
  theme = await kapi['ui:setTheme'](theme === 'dark' ? 'light' : 'dark')
  setThemeSwitch()
})

/**
 * 日历视图的「显示已完成」开关。打开后格子里还会列出打过钩的任务，它们仍在**原来安排
 * 的那天**（安排不因为提前做完就挪位置）；行上给的是完成时间、标题划删除线。
 * 状态存 ui.json，三个日历视图共用这一个开关。
 */
document.addEventListener('click', async (e) => {
  if (!(e.target as HTMLElement).closest('[data-donesw]')) return
  showDone = await kapi['ui:setShowDone'](!showDone)
  setDoneSwitch()
  render()
})

/**
 * 连续日历的「推演」开关。关掉就是整块不画（不是画淡一点）—— 推演的行只在这一个地方生成，
 * 关掉之后格子里就只剩真实任务。状态同样存 ui.json。
 */
document.addEventListener('click', async (e) => {
  if (!(e.target as HTMLElement).closest('[data-projectsw]')) return
  projectRepeat = await kapi['ui:setProjectRepeat'](!projectRepeat)
  setProjectSwitch()
  render()
})

/**
 * 收起/展开两侧栏。状态存 ui.json —— 和详情栏宽度一样是本机的界面偏好。
 * 详情栏收起后选中项不动（列表里那条照旧高亮）；普通视图里点任务会自动展开它，
 * 日历视图和以前一样只换选中，得手动点 » 才展开。
 */
document.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement
  const side = !!t.closest('#sidecollapse') || !!t.closest('#sideexpand')
  if (!side && !t.closest('#detailtoggle')) return
  if (side) {
    sideCollapsed = await kapi['ui:setSidebarCollapsed'](!sideCollapsed)
  } else {
    // 收起详情栏之前先把焦点交出去：备注/标题都在那一栏里，display:none 之后
    // 还能不能收到 focusout 不该赌 —— 主动 blur 一次，走它们自己的保存路径，
    // 打了一半的字不会因为面板被藏起来而丢（和主进程的同步挡板同一套做法）
    const active = document.activeElement as HTMLElement | null
    if (!detailCollapsed && active?.closest?.('#detail')) active.blur()
    await setDetailCollapsed(!detailCollapsed)
  }
  applyPanes()
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
// 系统外观变了（或别处改了 themeSource）：把开关挪过去。配色 CSS 自己会刷
kapi.onThemeChanged((next) => { theme = next; setThemeSwitch() })
kapi.onTasksChanged((t) => { tasks = t; if (ready) render() })

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
  // 先把上次拖的详情栏宽度装上，省得第一帧按默认 340 画一遍再跳
  detailW = await kapi['ui:detailWidth']()
  applyDetailW()
  // 两侧栏收起没有，也要在第一次 render 之前拿到，否则会先按"三栏都在"画一遍再塌下去。
  // 而且得赶在 setLang 之前 —— applyStatic 里会调 applyPanes 把它们落到 .app 上
  sideCollapsed = await kapi['ui:sidebarCollapsed']()
  // 日历的「显示已完成」开关也得在第一次 render 之前拿到，否则会先按默认关画一遍
  showDone = await kapi['ui:showDone']()
  // 「推演」同理（默认开，所以第一帧就得是对的，不能先画一遍没推演的）
  projectRepeat = await kapi['ui:projectRepeat']()
  // 连续日历每行几列：同样是第一次 render 就要用的（列数决定一行几个格子）
  monthCols = await kapi['ui:monthCalCols']()
  /**
   * 落在上次那一屏列表上（主进程建窗口时已经按同一屏给了尺寸）。浏览器的滚动位置
   * 没法跨启动保留，列表长了会回到顶部 —— 能记住的只有"哪一屏"。
   * 没存过、或者存的值这个版本不认识（旧 ui.json 被手改过），就退回默认视图。
   */
  const lastView = await kapi['ui:view']()
  if (lastView && VIEWS.some(v => v.id === lastView)) view = lastView
  // 上次就停在这一屏：第一次 render 就得重铺并滚到今天那一格（同 setView）
  if (view === CAL_FLOW) flowFresh = true
  /**
   * 详情栏收没收起按视图分组记，所以三份都先拿回来（切视图时不再问主进程，见 setView），
   * 再把当前这一屏那份装上。必须在 setLang 之前 —— applyStatic 会调 applyPanes。
   */
  for (const slot of WIN_SLOTS) detailBySlot[slot] = await kapi['ui:detailCollapsed'](slot)
  detailCollapsed = detailBySlot[viewSlot(view)]
  // 主题要在 setLang 之前拿到：applyStatic 里会刷开关状态，那时 theme 得是对的
  theme = await kapi['ui:theme']()
  // 版本号也要 —— applyStatic 要把它写到左下角那个按钮上
  version = await kapi['app:version']()
  setLang(await kapi['ui:lang']())
  vault = await kapi['vault:state']()
  ready = true
  if (!vault) { showWelcome(true); return }
  tasks = await kapi['task:list']()
  render()
  ti.focus()
}
boot()
