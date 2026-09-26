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
 * 窗口大小按"哪一屏"分开记：**三个日历视图共用 'calendar' 一份**，其余视图共用 'other'。
 * 日历铺的是格子，要的地方和列表不一样，用户不用每次切视图都手动拖窗口；
 * 三个日历之间也不分家 —— 都是铺格子，7d 调好了 14d、自定义也该是那个大小。
 */
export type WinSlot = 'other' | 'calendar'
export const WIN_SLOTS: readonly WinSlot[] = ['other', 'calendar']
export const isWinSlot = (x: unknown): x is WinSlot => WIN_SLOTS.includes(x as WinSlot)

/**
 * 分家时代的旧分组名：日历 7d / 14d 各记过一套窗口大小和详情栏开合。
 * 现在三个日历共用 'calendar'，主进程读偏好时按这张表把旧键折算过来，不让老用户的
 * 设置凭空变回默认（自定义那屏是这次才加进日历组的，旧版本里没有它自己的键）。
 * **只读不写**：留着这几个键不碍事，下次改窗口大小自然只会写新的 'calendar'。
 */
export const LEGACY_SLOT_KEYS: Partial<Record<WinSlot, readonly string[]>> = {
  calendar: ['calendar7', 'calendar14'],
}

/**
 * 侧栏那 9 个列表。渲染进程的 VIEWS 只管图标和副标题，id 这一层放这儿 ——
 * 主进程要用它校验 ui.json 里存下的值（那个文件可能被手改，也可能是旧版本写的，
 * 读回来不能直接当合法视图用），窗口大小也要按视图分组。
 */
export const VIEW_IDS = ['today', 'next7', 'next30', 'calendar7', 'calendar14', 'calendarCustom', 'all', 'done', 'trash'] as const
export type ViewId = typeof VIEW_IDS[number]
export const isViewId = (x: unknown): x is ViewId => VIEW_IDS.includes(x as ViewId)

/**
 * 视图 → 窗口大小分组。三个日历视图共用 'calendar'（大小、详情栏开合都共享一份），
 * 其余视图共用 'other'。渲染进程切视图和主进程建窗口都按这个映射走，别各写一份。
 */
export const viewSlot = (v: ViewId): WinSlot =>
  v === 'calendar7' || v === 'calendar14' || v === 'calendarCustom' ? 'calendar' : 'other'

/**
 * 值得"下次打开还停在这儿"的列表。已完成和垃圾桶是顺路看一眼就走的地方，
 * 退出时停在那儿不该变成下一次的落脚点 —— 记进去也没用，读的时候当没存过。
 */
export const RESTORABLE_VIEWS: readonly ViewId[] =
  ['today', 'next7', 'next30', 'calendar7', 'calendar14', 'calendarCustom', 'all']
export const isRestorableView = (x: unknown): x is ViewId => RESTORABLE_VIEWS.includes(x as ViewId)

/* ── 日历视图（自定义）────
 * 用户自己拖出来的一段日期 + 一个列数。范围是**绝对日期**（那两天的零点），不是
 * "今天起 N 天" —— 选好之后重开应用，看到的还是那几天。
 */
/** 一段日期范围：起止两天的零点，from ≤ to。渲染进程拖选时算好发上来 */
export type CalRange = { from: number; to: number }

/**
 * 范围最多几天。超过就不是"日历"了 —— 格子小到看不清，还会把窗口挤爆。
 * 拖选在渲染进程就地卡住（顶栏显示"最多 36 天"），主进程再兜一次底：
 * ui.json 可能被手改，也可能来自旧版本。
 */
export const CUSTOM_CAL_MAX_DAYS = 36
/** 自定义日历的列数范围。5 列是默认（一行一周，日历最常见的摆法） */
export const CUSTOM_CAL_COLS = { min: 3, max: 6, def: 5 } as const

/**
 * 一段范围一共几天（含头含尾）。**用日期加减算，不拿毫秒除 86400000**：
 * 跨夏令时切换那天两个零点差 23 或 25 小时，除出来会少一天或多一天，
 * "36 天上限"就会时松时紧。
 */
export function calRangeDays(r: CalRange): number {
  const d = new Date(r.from)
  d.setHours(0, 0, 0, 0)
  const end = new Date(r.to)
  end.setHours(0, 0, 0, 0)
  let n = 1
  while (+d < +end && n <= CUSTOM_CAL_MAX_DAYS + 1) { d.setDate(d.getDate() + 1); n++ }
  return n
}

/** 超了 36 天就从尾部砍掉，起点不动（同 calRangeDays：日期加减，不碰毫秒） */
export function clampCalRange(r: CalRange): CalRange {
  if (calRangeDays(r) <= CUSTOM_CAL_MAX_DAYS) return r
  const end = new Date(r.from)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + CUSTOM_CAL_MAX_DAYS - 1)
  return { from: r.from, to: +end }
}

/**
 * 把一段来路不明的值收拾成能用的范围：形状不对（不是两个数字）返回 null，
 * **形状对但超了 36 天就夹到 36 天**（不返回 null）。
 *
 * 为什么超限要夹而不是拒：用户拖选时来回拖过界很常见（先划一大片再收回来），
 * 超一点是过程而不是错误 —— 拒掉会让"明明选好了一段却什么都没存下"。
 * 真正看不懂的形状（手改过的 ui.json、旧版本写的东西）才当没选过。
 */
export function normCalRange(x: unknown): CalRange | null {
  if (!x || typeof x !== 'object') return null
  const { from, to } = x as CalRange
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const a = new Date(from), b = new Date(to)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  const [lo, hi] = +a <= +b ? [+a, +b] : [+b, +a]
  return clampCalRange({ from: lo, to: hi })
}

/**
 * 从 ui.json 读回来的一段范围：除了形状要对，**超过 36 天的也当没选过**（返回 null）。
 *
 * 和 normCalRange 的区别就在这儿：那个是"用户正在给我的值"（超了夹一下就好），
 * 这个是"盘上躺着的一段值"—— 它超限说明要么被手改过、要么是别的版本写的，
 * 与其照它铺一屏荒唐的格子，不如让用户重新选一次。
 *
 * 判断办法是"夹过没有"：normCalRange 会把超限的砍短，砍短了就说明原来是超的。
 * 别直接比较 from/to 的数值 —— 它还会顺手排序，倒着存的那份是正常的。
 */
export function readCalRange(x: unknown): CalRange | null {
  if (!x || typeof x !== 'object') return null
  const { from, to } = x as CalRange
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const a = new Date(from), b = new Date(to)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  const [lo, hi] = +a <= +b ? [+a, +b] : [+b, +a]
  // 先量天数再决定要不要夹 —— 反过来的话量到的永远是夹过之后的 36 天，
  // 这道"盘上的值超限就当没选过"的关卡就等于没有（踩过一次）
  return calRangeDays({ from: lo, to: hi }) <= CUSTOM_CAL_MAX_DAYS ? { from: lo, to: hi } : null
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
   * 日历视图要不要显示"当天已完成"的任务。默认关 —— 日历首先是看安排的，
   * 已完成的不该一上来就把格子占满。这是本机的界面偏好，两个日历视图共用
   */
  'ui:showDone': () => boolean
  /** 记下这个开关。返回存进去的值 */
  'ui:setShowDone': (on: boolean) => boolean
  /**
   * 日历视图（自定义）选的那段日期 + 列数。没选过范围就是 null —— 界面据此进入
   * "拖选范围"那一屏。和 showDone 一样是本机的界面偏好：不进库目录、不跟 iCloud 同步
   */
  'ui:customCal': () => { range: CalRange | null; cols: number }
  /** 记下拖出来的范围（传 null = 清掉重选）。返回真正存进去的值，越界的一律夹回来 */
  'ui:setCustomCalRange': (range: CalRange | null) => CalRange | null
  /** 记下列数（3~6）。返回真正存进去的值 */
  'ui:setCustomCalCols': (cols: number) => number
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
  'ui:customCal', 'ui:setCustomCalRange', 'ui:setCustomCalCols',
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
