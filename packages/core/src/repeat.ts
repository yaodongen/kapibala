import type { RepeatRule, Task } from './types.ts'
import { derivedId } from './ids.ts'

const DAY = 86400000

export function advance(from: number, rule: RepeatRule): number {
  const n = Math.max(1, rule.interval ?? 1)
  const d = new Date(from)
  if (rule.freq === 'DAILY') d.setDate(d.getDate() + n)
  else if (rule.freq === 'WEEKLY') d.setDate(d.getDate() + 7 * n)
  else d.setMonth(d.getMonth() + n)
  return +d
}

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10)

/**
 * 周期任务的下一个实例。ID 由 (系列, 这一次的日期) 确定性派生：
 * 两台 Mac 各自完成同一次，算出同一个 ID → 合并后只有一个任务。
 * afterCompletion 模式下完成时间按天取整，否则差几秒就会分叉。见 storage.zh.md §7.2
 */
export function nextOccurrence(task: Task, completedAt: number):
    { id: string; startAt: number; seriesId: string } | null {
  if (!task.repeat || task.startAt === undefined) return null
  const seriesId = task.seriesId ?? task.id
  const base = task.repeat.mode === 'afterCompletion'
    ? Math.floor(completedAt / DAY) * DAY + (task.startAt % DAY)
    : task.startAt
  let startAt = advance(base, task.repeat)
  // 固定周期：如果算出来还在过去，一直推到未来，避免补上一堆历史实例
  if (task.repeat.mode !== 'afterCompletion') {
    let guard = 0
    while (startAt <= completedAt && guard++ < 500) startAt = advance(startAt, task.repeat)
  }
  return { id: derivedId(seriesId, dayKey(startAt)), startAt, seriesId }
}
