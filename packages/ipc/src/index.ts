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
}

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
  'log:read': () => { text: string; path: string }
  'log:copy': () => void
  'log:reveal': () => void
  /** 渲染进程自己的报错也要进同一份日志 */
  'log:renderer': (msg: string) => void
}

export type Events = {
  /** 本机改动或别的 Mac 同步过来的改动，都从这里推 */
  'tasks:changed': (tasks: Task[]) => void
  /** 右键菜单里选了"备注"，让界面把这条任务的详情栏打开 */
  'task:show': (id: string) => void
  /** 正在读别的设备同步过来的改动。界面据此挡住编辑，读完自动放开 */
  'sync:busy': (busy: boolean) => void
  /** 系统外观变了（或自己被 ui:setTheme 改了）。开关跟着挪，CSS 那边由媒体查询自己刷 */
  'theme:changed': (theme: Theme) => void
}

export const CHANNELS = [
  'vault:state', 'vault:pick', 'vault:list', 'vault:open', 'vault:forget', 'task:list', 'task:create', 'task:setField',
  'task:complete', 'task:uncomplete', 'task:trash', 'task:restore', 'task:purgeAll', 'task:menu',
  'ui:lastTask', 'ui:lang', 'ui:setLang', 'ui:theme', 'ui:setTheme',
  'ui:detailWidth', 'ui:setDetailWidth',
  'log:read', 'log:copy', 'log:reveal', 'log:renderer',
] as const satisfies ReadonlyArray<keyof Commands>

export type Api = {
  [K in keyof Commands]: (...a: Parameters<Commands[K]>) => Promise<ReturnType<Commands[K]>>
} & {
  onTasksChanged(cb: (tasks: Task[]) => void): void
  onShowTask(cb: (id: string) => void): void
  onSyncBusy(cb: (busy: boolean) => void): void
  onThemeChanged(cb: (theme: Theme) => void): void
}
