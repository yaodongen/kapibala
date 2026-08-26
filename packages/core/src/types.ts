/** 存储层的类型定义。字段名一旦发布就不能改，见 storage.zh.md §5.4 */

/** 一行 JSONL = 一个字段的一次赋值 */
export type Op = {
  v: 1
  hlc: string      // "<16位毫秒>:<4位计数器>:<设备ID>"
  e: string        // entity 类型
  id: string
  f: string        // 字段名
  val: unknown
}

/** 一个实体的字段映射：不认识的字段也照样存在这里，见 storage.zh.md §5.4 */
export type Cell = { val: unknown; hlc: string }
export type Fields = Record<string, Cell>
/** state[entity][id][field] */
export type State = Record<string, Record<string, Fields>>

export type Snapshot = {
  schema: 1
  deviceId: string          // 提到顶层，state 里的 hlc 只存 "时间:计数器"
  lastSegment: number
  hlcMax: string
  state: State
}

export type VaultMeta = {
  appId: 'kapibala'
  vaultId: string
  schema: number
  createdAt: number
  createdBy: string
}

export type DeviceIdentity = {
  deviceId: string
  claimToken: string
  machineId: string
  label: string
}

export type VaultEntry = {
  id: string
  path: string
  name: string
  lastOpenedAt: number
  device: DeviceIdentity
}

export type VaultsFile = { version: 1; lastVaultId?: string; vaults: VaultEntry[] }

export type RepeatRule = {
  /** RFC 5545 RRULE 子集，如 "FREQ=MONTHLY;BYDAY=2TU"。新数据都写这个 */
  rrule?: string
  /** 0.0.x 写下的形状，只读不写。见 repeat.ts 的 toRruleString */
  freq?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval?: number
  /** 'fixed' 按原计划推进；'afterCompletion' 从完成日推进 */
  mode?: 'fixed' | 'afterCompletion'
  /** "每周一 9:00"这条规则本身是绑时区的 */
  tz?: string
}

export type Reminder = { id: string; offsetMin?: number; at?: number }

/** 业务视图。存储层只认字段，这个类型只是 state 的一个投影 */
export type Task = {
  id: string
  title: string
  notes?: string
  startAt?: number
  isAllDay: boolean
  reminders: Reminder[]
  repeat?: RepeatRule
  order: string
  completedAt?: number
  createdAt: number
  seriesId?: string          // 周期任务的系列 ID
  deleted: boolean
  purgedAt?: number
}

export const SCHEMA_VERSION = 1
export const APP_ID = 'kapibala' as const
