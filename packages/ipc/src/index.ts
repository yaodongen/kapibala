/** 主进程与渲染进程共享的契约。渲染进程只认识这些，永远看不到 op 和 HLC */
import type { Lang, RepeatRule, Task } from '@kapibala/core'

/**
 * 运行平台。只为两件小事存在：标题栏要不要给系统按钮让位、快捷键提示写 ⌘ 还是 Ctrl。
 * 界面逻辑不按它分叉 —— 分叉越多，两个平台就越容易各长各的。
 */
export type Platform = 'darwin' | 'win32' | 'other'

/** 平台判定只有这一个入口。认 darwin / win32 两个，其余（linux 之类）一律 other。
 *  forced 认不出来的值直接忽略 —— 环境变量写错一个字不该把平台判成 other */
export const platformOf = (raw: string | undefined, forced?: string): Platform => {
  const p = forced === 'darwin' || forced === 'win32' ? forced : raw
  return p === 'darwin' ? 'darwin' : p === 'win32' ? 'win32' : 'other'
}

/**
 * 主进程把自己的判定结果通过 webPreferences.additionalArguments 递给 preload 用的参数名。
 * 渲染进程那边不自己判断平台：只有主进程知道打没打包、认不认开发期的 KAPIBALA_OS，
 * 两边各判一次迟早会不一致（那边看的是 mac 的留白，这边跑的是 Windows 的托盘）。
 */
export const PLATFORM_ARG = '--kapi-platform='

export type VaultState = {
  id: string
  /** 这台机器上次在这个库里选中的任务 */
  lastTask?: string
  name: string
  path: string
  deviceLabel: string
  readOnly: boolean
  forked: boolean
  health: { badLines: number; droppedTail: boolean; incomplete: boolean; devices: number }
}

export type VaultSummary = {
  id: string
  name: string
  path: string
  current: boolean
  available: boolean        // 路径不存在（外置盘没挂载 / 目录被移动）时为 false
}

export type TaskDraftIpc = {
  title: string
  startAt?: number
  isAllDay?: boolean
  repeat?: RepeatRule
  /** 落点（分数索引 key）。界面知道"哪一天"，算好一起发过来，见 core 的 order.ts */
  order?: string
}

/** 一次字段写入。多行一起发 = 一次落盘（见 store.setMany） */
export type FieldOpIpc = { id: string; f: string; val: unknown }

/**
 * 界面主题。只有亮/暗两种 —— "跟系统"不是第三种取值，而是**没存过偏好**时的默认行为：
 * 主进程据此把 nativeTheme.themeSource 设成 'system'。用户一点开关就固定下来。
 */
export type Theme = 'light' | 'dark'

/**
 * 详情栏的默认宽度。三处都要它：CSS 的 `var(--detail-w, …)`、渲染进程的初始值、
 * 主进程读到空偏好时的兜底 —— 写三份迟早会对不上，放这儿共享。
 */
export const DEFAULT_DETAIL_WIDTH = 340

/**
 * 窗口大小按"哪一屏"分开记：**四个日历视图共用 'calendar' 一份**，其余视图共用 'other'。
 * 日历铺的是格子，要的地方和列表不一样，用户不用每次切视图都手动拖窗口；
 * 几个日历之间也不分家 —— 都是铺格子，7d 调好了月历也该是那个大小。
 */
export type WinSlot = 'other' | 'calendar'
export const WIN_SLOTS: readonly WinSlot[] = ['other', 'calendar']
export const isWinSlot = (x: unknown): x is WinSlot => WIN_SLOTS.includes(x as WinSlot)

/**
 * 分家时代的旧分组名：日历 7d / 14d 各记过一套窗口大小和详情栏开合。
 * 现在四个日历共用 'calendar'，主进程读偏好时按这张表把旧键折算过来，不让老用户的
 * 设置凭空变回默认。
 * **只读不写**：留着这几个键不碍事，下次改窗口大小自然只会写新的 'calendar'。
 */
export const LEGACY_SLOT_KEYS: Partial<Record<WinSlot, readonly string[]>> = {
  calendar: ['calendar7', 'calendar14'],
}

/**
 * 侧栏那 9 个列表。渲染进程的 VIEWS 只管图标和副标题，id 这一层放这儿 ——
 * 主进程要用它校验 ui.json 里存下的值（那个文件可能被手改，也可能是旧版本写的，
 * 读回来不能直接当合法视图用），窗口大小也要按视图分组。
 *
 * calendarFlow 是"连续日历"（日子一天接一天铺下去、上下无限滚，每行放几列由用户定）——
 * 侧栏顺序就是这一份的顺序（见渲染进程的 VIEWS）。
 */
export const VIEW_IDS = ['today', 'next7', 'next30', 'calendar7', 'calendar14',
                         'calendarFlow', 'all', 'done', 'trash'] as const
export type ViewId = typeof VIEW_IDS[number]
export const isViewId = (x: unknown): x is ViewId => VIEW_IDS.includes(x as ViewId)

/**
 * 视图 → 窗口大小分组。四个日历视图共用 'calendar'（大小、详情栏开合都共享一份），
 * 其余视图共用 'other'。渲染进程切视图和主进程建窗口都按这个映射走，别各写一份。
 */
export const viewSlot = (v: ViewId): WinSlot =>
  v === 'calendar7' || v === 'calendar14' || v === 'calendarFlow' ? 'calendar' : 'other'

/**
 * 值得"下次打开还停在这儿"的列表。已完成和垃圾桶是顺路看一眼就走的地方，
 * 退出时停在那儿不该变成下一次的落脚点 —— 记进去也没用，读的时候当没存过。
 */
export const RESTORABLE_VIEWS: readonly ViewId[] =
  ['today', 'next7', 'next30', 'calendar7', 'calendar14', 'calendarFlow', 'all']
export const isRestorableView = (x: unknown): x is ViewId => RESTORABLE_VIEWS.includes(x as ViewId)

/**
 * 撤掉的视图：老用户的 ui.json 里还可能存着它。读的时候折算到接替它的那一屏 ——
 * 直接当"没存过"的话，下一次打开会莫名跳回「今天」，用户只会觉得"我的设置丢了"。
 * 和 LEGACY_SLOT_KEYS 一个规矩：**只读不写**，之后所有的写都只写新的 id。
 *
 * 撤过的两个：
 *   calendarCustom —— 用户拖一段固定日期、一月一块地看。它那点诉求「格子别太挤」
 *     现在是连续日历的列数（见 MONTH_CAL_COLS），「看某一段日子」直接滚过去。
 *   calendarMonth —— 就是这同一屏的上一个名字（当时是"一月一块的真月历"，
 *     现在改成一天接一天、不分月了，所以连 id 一起换掉）。
 */
export const LEGACY_VIEW_IDS: Readonly<Record<string, ViewId>> = {
  calendarCustom: 'calendarFlow',
  calendarMonth: 'calendarFlow',
}
/** 从盘上读回来的视图 id：认得的就用，撤掉的折算，别的一律 null（当没存过） */
export function restorableView(x: unknown): ViewId | null {
  if (isRestorableView(x)) return x
  return typeof x === 'string' ? LEGACY_VIEW_IDS[x] ?? null : null
}

/* ── 「日历视图」（月历）每行放几天 ────
 * 这一屏原来固定 7 列（周一到周日），1110 宽的窗口下每格只剩六十几像素，标题只剩两三个字。
 * 现在列数由用户定：**5 列是默认** —— 那个宽度下每格还有 90 多像素，小屏幕上标题读得全；
 * 7 列是"一周一行"的传统月历（只有 7 列才对得齐周一到周日，见渲染进程的 dayCellHtml）。
 * 存在 ui.json 里，是本机的界面偏好，不进库目录、不跟 iCloud 同步。
 */
export const MONTH_CAL_COLS = { min: 3, max: 7, def: 5 } as const

/**
 * 盘上读回来的列数：不是 3~7 的整数（没存过、手改过、旧版本写的）就用默认 5。
 * **夹而不报错** —— 列数只是个摆法，没必要为它把界面卡住。
 */
export function normMonthCalCols(x: unknown): number {
  const n = Math.round(Number(x))
  return Number.isFinite(n) && n >= MONTH_CAL_COLS.min && n <= MONTH_CAL_COLS.max
    ? n : MONTH_CAL_COLS.def
}

/* ── 日期算术 ────
 * 连续日历是"一天接一天"铺出来的，往前/往后接也是按天算 —— 所以这里只需要"某天加减几天"。
 * （原来那套"月序号 / 这个月几号起画 / 画几周"是给"一月一块的真月历"用的，那一屏已经改成
 * 连续排了，用不上，连单测一起删掉。要再捡回来：git log 里搜 monthWeekStart。）
 */

/**
 * 某天往后（往前就是负数）n 天的零点。**用日期加减，不拿毫秒乘**：
 * 跨夏令时切换那天两个零点差 23 或 25 小时，加 86400000 会落到前一天 23 点或后一天 1 点。
 */
export function addDays(ts: number, n: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + n)
  d.setHours(0, 0, 0, 0)
  return +d
}

/** 一条命令对应存储层的一条或几条 op。字段会一直加，所以不给每个字段发明命令 */
export type Commands = {
  'vault:state': () => VaultState
  'vault:pick': () => VaultState | null      // 弹目录选择，新建或打开
  'vault:list': () => VaultSummary[]
  'vault:open': (id: string) => VaultState   // 切换到已知的库
  /** 从列表里移出。只删注册表条目，绝不动磁盘上的目录。
   *  移出的是当前库时会切到剩下的第一个，都没有就返回 null（回到引导页） */
  'vault:forget': (id: string) => VaultState | null
  'task:list': () => Task[]
  'task:create': (draft: TaskDraftIpc) => string
  'task:setField': (id: string, field: string, val: unknown) => void
  /** 一批字段一次写。拖动排序/改期用：跨天要 startAt + order 一起写，那一格
   *  挤满了要整格重排时也是一批 —— 分几次发就是几次落盘 */
  'task:setMany': (rows: FieldOpIpc[]) => void
  /** 完成。周期任务会派生下一个实例，返回它的 id（不重复、或系列已结束就是 null），
   *  界面据此把详情栏跟过去 */
  'task:complete': (id: string) => string | null
  'task:uncomplete': (id: string) => void
  'task:trash': (id: string) => void
  'task:restore': (id: string) => void
  /** 清空垃圾桶。确认对话框在主进程弹（原生的），用户取消就返回 0 */
  'task:purgeAll': () => number
  /** 右键菜单。用系统原生菜单，不自己画 */
  'task:menu': (id: string) => void
  /** 记住选中的任务。属于本机的界面状态，写在 userData 里，不进库目录 */
  'ui:lastTask': (taskId: string) => void
  /** 界面语言。默认跟系统走，改过就以改过的为准。同样是本机状态，不进库目录 */
  'ui:lang': () => Lang
  'ui:setLang': (lang: Lang) => Lang
  /** 界面主题。没存过偏好就跟系统走，返回的是**当前生效**的亮/暗 */
  'ui:theme': () => Theme
  /** 手动固定成亮或暗（开关就这两个状态）。返回固定后生效的主题 */
  'ui:setTheme': (theme: Theme) => Theme
  /** 详情栏宽度（像素）。和语言、主题一样是本机的界面偏好，不进库目录、不跟 iCloud 走 */
  'ui:detailWidth': () => number
  /** 记下拖动后的详情栏宽度。返回实际存进去的值 */
  'ui:setDetailWidth': (width: number) => number
  /**
   * 日历视图要不要显示已完成的任务。默认关 —— 日历首先是看安排的，
   * 已完成的不该一上来就把格子占满。打过钩的仍然挂在**原来安排的那天**，
   * 不是完成那天。这是本机的界面偏好，四个日历视图共用（7d / 14d / 月历）
   */
  'ui:showDone': () => boolean
  /** 记下这个开关。返回存进去的值 */
  'ui:setShowDone': (on: boolean) => boolean
  /**
   * 日历视图要不要"推演"周期任务：把「每天读书 20 分钟」这类固定周期任务**未来会排到
   * 哪几天**也画在格子里（置灰、只读，不是任务）。默认开。只是本机的界面偏好，
   * 和 showDone 一样存 ui.json，不进库目录、不跟 iCloud 同步
   */
  'ui:projectRepeat': () => boolean
  /** 记下这个开关。返回存进去的值 */
  'ui:setProjectRepeat': (on: boolean) => boolean
  /**
   * 「日历视图」（月历）每行放几天。没存过 = 5（见 MONTH_CAL_COLS）。
   * 和 showDone 一样是本机的界面偏好：不进库目录、不跟 iCloud 同步。
   * 旧版本那个自定义日历的 customCalCols 可能还躺在盘上，读的时候拿它兜底（见 main.ts）
   */
  'ui:monthCalCols': () => number
  /** 记下列数（3~7）。返回真正存进去的值，越界的一律回默认 5 */
  'ui:setMonthCalCols': (cols: number) => number
  /**
   * 左右两侧栏收起没有。收起是为了把任务列表 / 日历铺满（专注看安排），
   * 默认都不收。和详情栏宽度一样是本机的界面偏好：不进库目录、不跟 iCloud 同步
   */
  'ui:sidebarCollapsed': () => boolean
  'ui:setSidebarCollapsed': (on: boolean) => boolean
  /**
   * 详情栏收起没有。按视图分组各记一份（其余视图 / 日历 7d / 日历 14d，和窗口大小
   * 同粒度）：在日历里收起详情把格子铺满，切回别的列表逛一圈再回来，它还是收着的
   */
  'ui:detailCollapsed': (slot: WinSlot) => boolean
  /** 记下某个视图分组的详情栏收起状态。返回存进去的值 */
  'ui:setDetailCollapsed': (slot: WinSlot, on: boolean) => boolean
  /**
   * 上次停在哪个列表，打开就回到那一屏（没存过 = 渲染进程的 DEFAULT_VIEW）。
   * 已完成 / 垃圾桶不记，所以返回的一定是 RESTORABLE_VIEWS 里的一个
   */
  'ui:view': () => ViewId | null
  /** 记下当前列表。已完成 / 垃圾桶不记（见 RESTORABLE_VIEWS），传进来就当没发生 */
  'ui:setView': (view: ViewId) => void
  /**
   * 切到某一屏（视图分组）。主进程先把当前窗口大小记到**离开**的那一屏，
   * 再按 to 这屏记过的大小调窗口。返回实际调成的尺寸；这屏没记过就是 null（窗口不动）
   */
  'window:switch': (to: WinSlot) => [number, number] | null
  /** 当前版本号，显示在左下角（点它就是看日志） */
  'app:version': () => string
  'log:read': () => { text: string; path: string }
  'log:copy': () => void
  'log:reveal': () => void
  /** 渲染进程自己的报错也要进同一份日志 */
  'log:renderer': (msg: string) => void
}

export type Events = {
  /** 本机改动或别的 Mac 同步过来的改动，都从这里推 */
  'tasks:changed': (tasks: Task[]) => void
  /** 正在读别的设备同步过来的改动。界面据此挡住编辑，读完自动放开 */
  'sync:busy': (busy: boolean) => void
  /** 系统外观变了（或自己被 ui:setTheme 改了）。开关跟着挪，CSS 那边由媒体查询自己刷 */
  'theme:changed': (theme: Theme) => void
}

export const CHANNELS = [
  'vault:state', 'vault:pick', 'vault:list', 'vault:open', 'vault:forget', 'task:list', 'task:create', 'task:setField',
  'task:setMany', 'task:complete', 'task:uncomplete', 'task:trash', 'task:restore', 'task:purgeAll', 'task:menu',
  'ui:lastTask', 'ui:lang', 'ui:setLang', 'ui:theme', 'ui:setTheme',
  'ui:detailWidth', 'ui:setDetailWidth', 'ui:showDone', 'ui:setShowDone',
  'ui:projectRepeat', 'ui:setProjectRepeat',
  'ui:monthCalCols', 'ui:setMonthCalCols',
  'ui:sidebarCollapsed', 'ui:setSidebarCollapsed', 'ui:detailCollapsed', 'ui:setDetailCollapsed',
  'ui:view', 'ui:setView',
  'window:switch', 'app:version',
  'log:read', 'log:copy', 'log:reveal', 'log:renderer',
] as const satisfies ReadonlyArray<keyof Commands>

export type Api = {
  [K in keyof Commands]: (...a: Parameters<Commands[K]>) => Promise<ReturnType<Commands[K]>>
} & {
  /** 运行平台。preload 直接给的常量，不走 IPC —— 界面第一帧就要用它决定标题栏留白 */
  platform: Platform
  onTasksChanged(cb: (tasks: Task[]) => void): void
  onSyncBusy(cb: (busy: boolean) => void): void
  onThemeChanged(cb: (theme: Theme) => void): void
}
