import { notePreview } from './markdown.ts'
import type { Task } from './types.ts'

/**
 * 搜索标题和备注。空格分隔的多个词按"全部命中"处理（AND），不做模糊匹配 ——
 * 个人待办这个量级下，猜用户想搜什么比不猜更容易出错。
 */
export function searchTasks(tasks: Task[], query: string): Task[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const scored: { t: Task; score: number }[] = []
  for (const t of tasks) {
    const title = t.title.toLowerCase()
    const notes = (t.notes ?? '').toLowerCase()
    if (!terms.every(w => title.includes(w) || notes.includes(w))) continue
    // 标题命中比备注命中更相关；未完成的排在已完成前面
    const score = (terms.every(w => title.includes(w)) ? 2 : 0) + (t.completedAt ? 0 : 1)
    scored.push({ t, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.t.startAt ?? 0) - (a.t.startAt ?? 0))
    .map(x => x.t)
}

/** 命中位置附近的一小段，用来在结果里显示上下文 */
export function matchContext(task: Task, query: string, max = 60): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const notes = notePreview(task.notes ?? '', 400)
  const low = notes.toLowerCase()
  const hit = terms.map(w => low.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0]
  if (hit === undefined) return notePreview(task.notes ?? '', max)
  const from = Math.max(0, hit - 16)
  const text = notes.slice(from, from + max)
  return (from > 0 ? '…' : '') + text + (from + max < notes.length ? '…' : '')
}
