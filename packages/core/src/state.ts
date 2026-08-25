import type { Cell, Fields, Op, State, Task } from './types.ts'
import { cmpHlc } from './hlc.ts'

/**
 * 字段级 LWW：同一 (e,id,f) 上 HLC 大的胜出。
 *
 * HLC 末段是设备 ID，同一台设备的计数器又严格递增，所以正常写入永远不会平票。
 * 但损坏或被重复写入的日志可能出现"HLC 相同、值不同"的两行——那时合并结果就会
 * 取决于重放顺序，收敛性失效。所以平票时再用值的 JSON 做最后一道 tiebreaker，
 * 让合并规则成为全序：无论什么输入、什么顺序，任何机器都算出同一个结果。
 */
export function applyOp(state: State, op: Op): void {
  const byId = (state[op.e] ??= {})
  const fields = (byId[op.id] ??= {})
  const prev = fields[op.f]
  if (!prev) { fields[op.f] = { val: op.val, hlc: op.hlc }; return }
  const c = cmpHlc(op.hlc, prev.hlc)
  if (c > 0 || (c === 0 && JSON.stringify(op.val ?? null) > JSON.stringify(prev.val ?? null)))
    fields[op.f] = { val: op.val, hlc: op.hlc }
}

export function replay(ops: Iterable<Op>): State {
  const s: State = {}
  for (const op of ops) applyOp(s, op)
  return s
}

/** 把 snapshot / state 摊平回 op 列表（压实等价性测试与快照读取都用它） */
export function flatten(state: State): Op[] {
  const out: Op[] = []
  for (const e of Object.keys(state)) for (const id of Object.keys(state[e]!))
    for (const [f, c] of Object.entries(state[e]![id]!)) out.push({ v: 1, hlc: c.hlc, e, id, f, val: c.val })
  return out
}

const num = (c?: Cell) => (typeof c?.val === 'number' ? c.val : undefined)
const str = (c?: Cell) => (typeof c?.val === 'string' ? c.val : undefined)

/** state → 业务对象。不认识的字段留在 state 里，不会因为这里没读到就丢失 */
export function materialize(id: string, f: Fields): Task {
  return {
    id,
    title: str(f['title']) ?? '',
    notes: str(f['notes']),
    startAt: num(f['startAt']),
    isAllDay: f['isAllDay']?.val !== false,
    reminders: Array.isArray(f['reminders']?.val) ? (f['reminders']!.val as Task['reminders']) : [],
    repeat: (f['repeat']?.val as Task['repeat']) ?? undefined,
    order: str(f['order']) ?? '',
    completedAt: num(f['completedAt']),
    createdAt: num(f['createdAt']) ?? 0,
    seriesId: str(f['seriesId']),
    deleted: f['_deleted']?.val === true,
    purgedAt: num(f['_purgedAt']),
  }
}

export function tasksOf(state: State): Task[] {
  const byId = state['task'] ?? {}
  return Object.keys(byId).map(id => materialize(id, byId[id]!))
}
