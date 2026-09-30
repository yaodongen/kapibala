import type { RepeatRule, Task } from './types.ts'
import { derivedId } from './ids.ts'
import { nextAfter, parseRrule, toRruleString } from './rrule.ts'
export { describeRepeat, toRruleString } from './rrule.ts'

const DAY = 86400000

const dayKey = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 旧方案（1.11.4 及以前）按"系列 + 日期"派生的那一期 ID。
 * 只有自愈用得到：老库里"下一期"躺在哪个 ID 上得按这个算，才认得出它已经存在
 *（包括被用户删掉的那种），不会又补一条新的出来。
 */
export const legacyOccurrenceId = (seriesId: string, startAt: number) =>
  derivedId(seriesId, dayKey(startAt))

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

/**
 * 周期任务的下一个实例。**ID 链在"这一期"上**（系列 + 上一期的 ID）：
 * 两台 Mac 各自完成同一次，算出同一个 ID → 合并后只有一个任务。
 *
 * 为什么不按日期派生（`系列 + 那一天的日期`，1.11.4 及以前是这么写的）：
 * 日期是用户能拖的（日历里改期）。按日期派生时，"派生出来的下一期"会把未来那一天的
 * 槽位占住 —— 把它拖回早几天的位置再完成，往后推就又落回一个已经被占用的 ID，于是
 * 静默写不出来（1.11.5 修的断链）；就算不撞车，把下一期拖到今天再勾也会"提前用掉"
 * 未来那一期，下一次的日期一路往后漂。链在上一期上就没这些事：每一期都是全新的一条，
 * 日期只决定它排在哪天。旧数据里已经写下的日期型 ID 读起来照旧（ID 是不透明的）。
 *
 * 固定周期只从**这一期自己的日期**往后推一个周期，完全不看完成时刻：否则你在计划
 * 上那一天点完成，下一期会被推到再下一个周期（"每 2 天"变成"完成后 2 天"）；两台
 * 机器在不同时刻完成同一次，也会算出两个不同的日期。想"完成后 N 天再来"的是
 * afterCompletion 模式。
 *
 * 返回 null 有两种情况：这条任务不重复，或者 UNTIL 到了、系列结束。
 */
export function nextOccurrence(task: Task, completedAt: number):
    { id: string; startAt: number; seriesId: string } | null {
  if (!task.repeat || task.startAt === undefined) return null
  const seriesId = task.seriesId ?? task.id

  let startAt: number
  if (task.repeat.mode === 'afterCompletion') {
    // 完成时间按天取整：同一台机器上 23:59 和 00:01 完成该落在不同的天，
    // 而同一天里几点完成都算同一天，才不会因为差几小时排出两个日期
    const base = Math.floor(completedAt / DAY) * DAY + (task.startAt % DAY)
    startAt = advance(base, task.repeat)
  } else {
    const rule = parseRrule(toRruleString(task.repeat))
    if (!rule) return null
    const next = nextAfter(rule, task.startAt, task.startAt)
    if (next === null) return null            // UNTIL 到了
    startAt = next
  }
  return { id: derivedId(seriesId, task.id), startAt, seriesId }
}
