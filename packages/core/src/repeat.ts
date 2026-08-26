import type { RepeatRule, Task } from './types.ts'
import { derivedId } from './ids.ts'
import { nextAfter, parseRrule, toRruleString } from './rrule.ts'
export { describeRepeat, toRruleString } from './rrule.ts'

const DAY = 86400000

/** afterCompletion 模式只按 freq + interval 往后推，BYDAY 这类在这个语义下没有意义 */
export function advance(from: number, rule: RepeatRule): number {
  const r = parseRrule(toRruleString(rule))
  const n = Math.max(1, r?.interval ?? 1)
  const d = new Date(from)
  if (!r || r.freq === 'DAILY') d.setDate(d.getDate() + n)
  else if (r.freq === 'WEEKLY') d.setDate(d.getDate() + 7 * n)
  else if (r.freq === 'MONTHLY') d.setMonth(d.getMonth() + n)
  else d.setFullYear(d.getFullYear() + n)
  return +d
}

const dayKey = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 周期任务的下一个实例。ID 由 (系列, 这一次的日期) 确定性派生：
 * 两台 Mac 各自完成同一次，算出同一个 ID → 合并后只有一个任务。
 * afterCompletion 模式下完成时间按天取整，否则差几秒就会分叉。见 storage.md §7.2
 *
 * 返回 null 有两种情况：这条任务不重复，或者 UNTIL 到了、系列结束。
 */
export function nextOccurrence(task: Task, completedAt: number):
    { id: string; startAt: number; seriesId: string } | null {
  if (!task.repeat || task.startAt === undefined) return null
  const seriesId = task.seriesId ?? task.id

  let startAt: number
  if (task.repeat.mode === 'afterCompletion') {
    const base = Math.floor(completedAt / DAY) * DAY + (task.startAt % DAY)
    startAt = advance(base, task.repeat)
  } else {
    const rule = parseRrule(toRruleString(task.repeat))
    if (!rule) return null
    // 固定周期：从"当前实例"和"完成时刻"里较晚的那个之后找，避免补一堆历史实例
    const next = nextAfter(rule, task.startAt, Math.max(task.startAt, completedAt))
    if (next === null) return null            // UNTIL 到了
    startAt = next
  }
  return { id: derivedId(seriesId, dayKey(startAt)), startAt, seriesId }
}
