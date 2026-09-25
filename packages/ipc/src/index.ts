/** 主进程与渲染进程共享的契约。渲染进程只认识这些，永远看不到 op 和 HLC */
import type { Lang, RepeatRule, Task } from '@kapibala/core'

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
 * 窗口大小按"哪一屏"分开记：两个日历视图各记各的，其余视图共用一份。
 * 日历铺的是格子，要的地方和列表不一样，用户不用每次切视图都手动拖窗口。
 */
export type WinSlot = 'other' | 'calendar7' | 'calendar14'
export const WIN_SLOTS: readonly WinSlot[] = ['other', 'calendar7', 'calendar14']
export const isWinSlot = (x: unknown): x is WinSlot => WIN_SLOTS.includes(x as WinSlot)

/**
 * 侧栏那 8 个列表。渲染进程的 VIEWS 只管图标和副标题，id 这一层放这儿 ——
 * 主进程要用它校验 ui.json 里存下的值（那个文件可能被手改，也可能是旧版本写的，
 * 读回来不能直接当合法视图用），窗口大小也要按视图分组。
 */
export const VIEW_IDS = ['today', 'next7', 'next30', 'calendar7', 'calendar14', 'all', 'done', 'trash'] as const
export type ViewId = typeof VIEW_IDS[number]
export const isViewId = (x: unknown): x is ViewId => VIEW_IDS.includes(x as ViewId)

/**
 * 视图 → 窗口大小分组。两个日历视图各占一屏，其余共用 'other'。
 * 渲染进程切视图和主进程建窗口都按这个映射走，别各写一份。
 */
export const viewSlot = (v: ViewId): WinSlot => (v === 'calendar7' || v === 'calendar14' ? v : 'other')

/**
 * 值得"下次打开还停在这儿"的列表。已完成和垃圾桶是顺路看一眼就走的地方，
 * 退出时停在那儿不该变成下一次的落脚点 —— 记进去也没用，读的时候当没存过。
 */
export const RESTORABLE_VIEWS: readonly ViewId[] = ['today', 'next7', 'next30', 'calendar7', 'calendar14', 'all']
export const isRestorableView = (x: unknown): x is ViewId => RESTORABLE_VIEWS.includes(x as ViewId)

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
  'ui:detailWidth', 'ui:setDetailWidth', 'ui:showDone', 'ui:setShowDone', 'ui:view', 'ui:setView',
  'window:switch', 'app:version',
  'log:read', 'log:copy', 'log:reveal', 'log:renderer',
] as const satisfies ReadonlyArray<keyof Commands>

export type Api = {
  [K in keyof Commands]: (...a: Parameters<Commands[K]>) => Promise<ReturnType<Commands[K]>>
} & {
  onTasksChanged(cb: (tasks: Task[]) => void): void
  onSyncBusy(cb: (busy: boolean) => void): void
  onThemeChanged(cb: (theme: Theme) => void): void
}
