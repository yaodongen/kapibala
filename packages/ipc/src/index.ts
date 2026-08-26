/** 主进程与渲染进程共享的契约。渲染进程只认识这些，永远看不到 op 和 HLC */
import type { Task } from '@kapibala/core'

export type VaultState = {
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
  repeat?: { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'; mode?: 'fixed' | 'afterCompletion' }
}

/** 一条命令对应存储层的一条或几条 op。字段会一直加，所以不给每个字段发明命令 */
export type Commands = {
  'vault:state': () => VaultState
  'vault:pick': () => VaultState | null      // 弹目录选择，新建或打开
  'vault:list': () => VaultSummary[]
  'vault:open': (id: string) => VaultState   // 切换到已知的库
  'task:list': () => Task[]
  'task:create': (draft: TaskDraftIpc) => string
  'task:setField': (id: string, field: string, val: unknown) => void
  'task:complete': (id: string) => void
  'task:uncomplete': (id: string) => void
  'task:trash': (id: string) => void
  'task:restore': (id: string) => void
  /** 右键菜单。用系统原生菜单，不自己画 */
  'task:menu': (id: string) => void
  'log:read': () => { text: string; path: string }
  'log:copy': () => void
  'log:reveal': () => void
  /** 渲染进程自己的报错也要进同一份日志 */
  'log:renderer': (msg: string) => void
}

export type Events = {
  /** 本机改动或别的 Mac 同步过来的改动，都从这里推 */
  'tasks:changed': (tasks: Task[]) => void
}

export const CHANNELS = [
  'vault:state', 'vault:pick', 'vault:list', 'vault:open', 'task:list', 'task:create', 'task:setField',
  'task:complete', 'task:uncomplete', 'task:trash', 'task:restore', 'task:menu',
  'log:read', 'log:copy', 'log:reveal', 'log:renderer',
] as const satisfies ReadonlyArray<keyof Commands>

export type Api = {
  [K in keyof Commands]: (...a: Parameters<Commands[K]>) => Promise<ReturnType<Commands[K]>>
} & {
  onTasksChanged(cb: (tasks: Task[]) => void): void
}
