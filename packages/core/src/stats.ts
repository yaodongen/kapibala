/**
 * 「统计」这一屏的算法：周期性任务分别做过几次。
 *
 * 存储层不需要为它加任何字段 —— 每勾完一次周期性任务，store.complete() 会派生下一期，
 * 同一个系列的所有实例共享 seriesId，每一期完成时写 completedAt。所以一个系列「做过几次」
 * 就是它名下 completedAt 有值的实例数；取消勾选把 completedAt 写成 null，这一期自然就不算了。
 * 删进垃圾桶 / 清空的那一期不算完成、不算待做、不参与分组，连「谁是这个系列的首期」
 * 都不由它认。用户删掉的是「那一次」，不是抹掉历史 —— 但如果把当前**待做**的那一期删了、
 * 后面再没有实例，说明这条周期任务放弃了，「周期性任务分别做了几次」里就不再追着它；
 * 已完成的历史仍留在累计 / 点阵 / 分布里。注意「完成 N/M」的分母是**规则**在这一期排到的
 * 次数：删掉一期只让它不再算完成，不会把规则里的那个槽位一起抹掉。
 *
 * 只认真正的系列（有 seriesId，或自己带重复规则）：用户中途改过标题的系列仍然算同一件事；
 * 反过来，两个不同系列恰好叫同一个名字也不会被硬凑到一起。系列的首期可能没写 seriesId
 * （链式派生里「系列 id = 首期 id」，见 repeat.ts），靠「别人的 seriesId 指向它」认出来。
 * 没设周期的同名一次性任务**不算周期性任务**，不按标题兜底合并；它们的完成记录仍算进
 * 累计完成 / 点阵 / 完成分布，只是不进「周期性任务分别做了几次」。
 *
 * 纯函数、不碰 node：渲染进程只从 @kapibala/core/stats 引它，和 rrule / markdown 一样。
 * 日期一律按本地时区的零点算，加减天用 setDate —— 夏令时切换那天两个零点差 23 或 25 小时，
 * 拿毫秒乘会落到前一天 23 点。
 */
import { nextAfter, parseRrule, toRruleString } from './rrule.ts'
import type { RepeatRule, Task } from './types.ts'

/** 「最近 30 天」含今天 */
const LAST_DAYS = 30
/**
 * 点阵铺多少周。和 GitHub 的贡献图一样固定 53 列：最后一列是本周，往前数 52 周，
 * 于是跨年那段是连着的，不会在 1 月 1 日被切断。列数固定，月份标签的位置也稳。
 */
export const STATS_YEAR_WEEKS = 53

export type StatsWeek = {
  /** 这周周一的本地零点 */
  start: number
  /** 周一 → 周日，每天的完成次数；还没到的日子是 null（留白，不写「欠了几天」） */
  days: Array<number | null>
  /** 这一周合计 */
  count: number
}

/** 一件周期性任务 */
export type RepeatGroup = {
  key: string
  /** 当前那一期的标题：有未完成的一期就跟它走，否则用最近完成的那一期 */
  title: string
  count: number
  firstAt: number
  lastAt: number
  /** 当前那一期的重复规则（口径同 title）；老数据 / 被清掉规则的系列可能没有 */
  rule?: RepeatRule
  /** 最近完成那一期的 id（系列里定位用） */
  latestId: string
  /** 系列里当前还待做的那一期 */
  pendingId?: string
}

export type Stats = {
  /** 按完成次数从多到少 */
  groups: RepeatGroup[]
  /** 全部已完成任务数（含一次性任务），不含垃圾桶 */
  totalDone: number
  /** 周期性任务贡献的完成次数 */
  repeatDone: number
  /** 最近 30 天（含今天）完成次数 */
  last30: number
  /** 最近一年这 53 周里，有多少天有过完成记录 */
  activeDays: number
  /** 滚动最近一年的周网格：最后一列是本周，往前 52 周 */
  weeks: StatsWeek[]
}

const startOfDay = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return +d }
const addDays = (ts: number, n: number) => {
  const d = new Date(ts); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return +d
}
/**
 * 一周从**周一**算起（中文习惯，也是周期视图里柱子的顺序）。
 * getDay() 是周日=0，换算成「离本周一过了几天」要 (getDay()+6)%7。
 */
const weekStart = (ts: number) => addDays(startOfDay(ts), -((new Date(ts).getDay() + 6) % 7))

/**
 * 「周期性任务分别做了几次」只收周期不超过 7 天的规则。
 * 「每月复盘」「每 17 天浇水」这类在周/月视图里几乎全是空柱，分母也容易失真，
 * 摆在一屏「这周做了几次」里只是噪音。完成的史实不删：累计完成、点阵、
 * 完成分布照旧记它们，只是不进这一份分组列表。
 */
export const STATS_MAX_CYCLE_DAYS = 7

/** 一条重复规则要不要进周期性任务列表。没规则 / 读不懂规则的都不拦 */
export function statsEligibleRule(rule?: RepeatRule): boolean {
  if (!rule) return true
  const r = parseRrule(toRruleString(rule))
  if (!r) return true
  // 月 / 年一定比 7 天长；BYMONTHDAY 写两个日子也还是按月循环，不按两次的间隔算
  const days = r.freq === 'DAILY' ? r.interval
    : r.freq === 'WEEKLY' ? r.interval * 7
    : Infinity
  return days <= STATS_MAX_CYCLE_DAYS
}

/**
 * 一条任务归到哪个**系列**。返回 null = 不是周期性任务：没写 seriesId、没带重复规则，
 * 也不是被别的实例当系列首期指着的那一条（链式派生里首期常常没写 seriesId）。
 * 同名的一次性任务不会在这里被按标题合并。
 *
 * heads 是「被别的实例当系列 id 指着」的那些任务 —— 先扫一遍再闭包，别在循环里反复建集合。
 */
function keyMaker(tasks: Task[]) {
  const heads = new Set<string>()
  // 已删除 / 已清空的实例不参与分组判定：连「谁是这个系列的首期」都不该由它们说了算
  for (const t of tasks)
    if (t.seriesId && !t.deleted && t.purgedAt === undefined) heads.add(t.seriesId)
  return (t: Task): string | null => {
    if (t.seriesId) return `s:${t.seriesId}`
    if (t.repeat || heads.has(t.id)) return `s:${t.id}`
    return null
  }
}

/** 完成才算数：垃圾桶里的、清空过的、没勾的、取消勾选的都不算 */
const isDone = (t: Task) => !t.deleted && t.purgedAt === undefined && t.completedAt !== undefined
const isAlive = (t: Task) => !t.deleted && t.purgedAt === undefined

type Acc = {
  key: string
  title: string
  count: number
  firstAt: number
  lastAt: number
  rule?: RepeatRule
  latestId: string
  pendingId?: string
  pendingCreatedAt: number
  /** 待做那一期的标题 / 规则：它才是用户眼前这一条，改名或改周期后要立刻反映出来 */
  pendingTitle: string
  pendingRule?: RepeatRule
  /** 这一组里有没有**未完成**的一期被删进垃圾桶 / 清空过（= 放弃信号） */
  hasDeletedPending: boolean
}

export function summarize(tasks: Task[], now = Date.now()): Stats {
  const today0 = startOfDay(now)
  /**
   * 点阵按周铺成「滚动最近一年」：最后一列就是本周，往前数 52 周，一共 53 列。
   * 不按自然年切 —— 十二月看这张图时，去年十二月还在画面里，跨年那段是连着的。
   * 日期一律用 setDate 加减，不拿毫秒乘 —— 夏令时那天两个零点差 23 或 25 小时。
   */
  const thisWeek = weekStart(today0)
  const gridStart = addDays(thisWeek, -7 * (STATS_YEAR_WEEKS - 1))
  const gridEnd = addDays(thisWeek, 7)       // 下周一，区间右开
  const grid: number[] = []
  for (let d = gridStart; d < gridEnd; d = addDays(d, 1)) grid.push(d)
  const future = (d: number) => d > today0

  /** 所有已完成任务的按天计数，点阵用（包括一次性任务：那也是做完的事） */
  const byDay = new Map<number, number>()
  let totalDone = 0, last30 = 0
  const since = addDays(today0, -(LAST_DAYS - 1))

  const keyOf = keyMaker(tasks)
  const acc = new Map<string, Acc>()
  const accOf = (key: string, t: Task) => {
    let a = acc.get(key)
    if (!a) {
      a = { key, title: t.title.trim(), count: 0, firstAt: Infinity, lastAt: -Infinity,
            latestId: t.id, pendingCreatedAt: -Infinity, pendingTitle: '', hasDeletedPending: false }
      acc.set(key, a)
    }
    return a
  }

  for (const t of tasks) {
    const key = keyOf(t)
    // 删掉的那一期：不算完成、不算待做。只有删掉的是**待做**的一期，才留一个「可能放弃」
    // 的记号；删掉一条历史完成记录不该让整个系列从排行里消失。同名的一次性任务没有系列，
    // 也就没有「放弃」这回事。
    if (!isAlive(t)) {
      if (key !== null && t.completedAt === undefined) accOf(key, t).hasDeletedPending = true
      continue
    }
    if (isDone(t)) {
      const at = t.completedAt!
      const day = startOfDay(at)
      byDay.set(day, (byDay.get(day) ?? 0) + 1)
      totalDone++
      if (at >= since) last30++
      if (key === null) continue
      const a = accOf(key, t)
      a.count++
      // 次数 / 首末完成 / latestId 跟着完成记录；标题和规则最后统一取当前那一期（见 current()）
      if (at < a.firstAt) a.firstAt = at
      if (at >= a.lastAt) { a.lastAt = at; a.title = t.title.trim(); a.rule = t.repeat; a.latestId = t.id }
    } else if (key !== null) {
      const a = accOf(key, t)
      if (t.createdAt >= a.pendingCreatedAt) {
        // 当前待做的那一期：链式派生里正常只有一条，多条时挑最后创建的。
        // 标题 / 规则跟着它走 —— 用户刚改过名、刚把周期换成每两周，这一屏就该按新的算。
        a.pendingId = t.id
        a.pendingCreatedAt = t.createdAt
        a.pendingTitle = t.title.trim()
        a.pendingRule = t.repeat
      }
    }
  }

  /** 当前那一期：有待做期就用它，没有（系列已结束）才退回最近完成的那一期 */
  const current = (a: Acc) => a.pendingId !== undefined
    ? { title: a.pendingTitle, rule: a.pendingRule }
    : { title: a.title, rule: a.rule }

  let activeDays = 0
  const weeks: StatsWeek[] = []
  for (let i = 0; i < grid.length; i += 7) {
    const slice = grid.slice(i, i + 7)
    const days = slice.map(d => future(d) ? null : (byDay.get(d) ?? 0))
    weeks.push({ start: slice[0]!, days, count: days.reduce<number>((n, x) => n + (x ?? 0), 0) })
    for (const n of days) if (n !== null && n > 0) activeDays++
  }

  /** 只统计真正的系列；没设周期的一次性任务连 acc 都没有 */
  const counted = [...acc.values()].filter(a => a.count > 0)
  /**
   * 「累计完成」里有多少来自这些重复的事。按**过滤前**的组算：列表可以不列
   * 每月复盘，但「累计完成 141 次 / 其中周期性任务 141 次」不能因此对不上账。
   */
  const repeatDone = counted.reduce((n, a) => n + a.count, 0)
  const groups: RepeatGroup[] = counted
    .filter(a => statsEligibleRule(current(a).rule))   // 当前规则周期 > 7 天的不进这一屏
    // 删掉**待做**的那一期、且现在没有任何待做的实例了 = 这条周期任务已经放弃，不再列入排行。
    // 只删掉旧的一期（还有下一期待做）、只删历史完成记录、或本来就到 UNTIL 结束的系列，照旧留着。
    .filter(a => a.pendingId !== undefined || !a.hasDeletedPending)
    .map(a => {
      const c = current(a)
      return {
        key: a.key, title: c.title, count: a.count, firstAt: a.firstAt, lastAt: a.lastAt,
        ...(c.rule ? { rule: c.rule } : {}),
        latestId: a.latestId,
        ...(a.pendingId ? { pendingId: a.pendingId } : {}),
      }
    })
    .sort((x, y) => y.count - x.count || y.lastAt - x.lastAt || x.title.localeCompare(y.title))

  return {
    groups, totalDone, repeatDone,
    last30, activeDays, weeks,
  }
}

/**
 * 某一条任务所属的周期系列一共做过几次。给详情栏用：勾完周期性任务后详情栏会跟到派生
 * 出来的下一期（见 app.ts 的 setDone），那儿的这个数字立刻 +1 —— 成就感不必另做弹窗、
 * 通知或连续打卡。不是周期性任务、或者一次都没做过，返回 null（不显示「0 次」）。
 */
export function seriesDoneCount(tasks: Task[], task: Task): number | null {
  const keyOf = keyMaker(tasks)
  const key = keyOf(task)
  if (key === null) return null
  const n = tasks.reduce((c, t) => c + (isDone(t) && keyOf(t) === key ? 1 : 0), 0)
  return n > 0 ? n : null
}

/* ── 周期视图：周 / 月 / 年 ────────────────────────────────
 * 上面那套是「攒到现在一共做过多少」，这一套是「挑一段时间，看它里面怎么分布」。
 * 两者都从同一批 completedAt 读，不存新东西；翻到没有记录的期，柱子就空着。
 * 不做「日」这一档：待办里同一天反复完成同一件事很少见，24 根空柱子只是噪音。
 */

/** 周期粒度。和 when.ts 已有的 PeriodKind 不是一回事，别重名（core 的 index.ts 是 export *） */
export type StatsPeriod = 'week' | 'month' | 'year'
/** 一根柱子。start 是桶的起点（日 / 月零点），标签交给界面按 kind 生成 */
export type PeriodBucket = { start: number; count: number }
export type PeriodView = {
  kind: StatsPeriod
  /** 本期起点（含）与下一期起点（不含），都是本地零点 */
  start: number
  end: number
  /** 本期完成次数 */
  total: number
  buckets: PeriodBucket[]
  /** 还能不能往后翻一期（本期已经包含今天就不能） */
  hasNext: boolean
}

const startOfMonth = (ts: number) => {
  const d = new Date(ts); d.setDate(1); d.setHours(0, 0, 0, 0); return +d
}
const startOfYear = (ts: number) => {
  const d = new Date(ts); d.setMonth(0, 1); d.setHours(0, 0, 0, 0); return +d
}
/** 只从月初 / 年初 / 周初开始加减，31 号不会溢出到再下一个月 */
const addMonths = (ts: number, n: number) => {
  const d = new Date(ts); d.setMonth(d.getMonth() + n); d.setHours(0, 0, 0, 0); return +d
}

/**
 * 翻一期。先落到这一期的起点再加减，免得「1 月 31 日 +1 个月」跳到 3 月去。
 * dir 是 +1 / -1，界面上由左右箭头给。
 */
export function shiftAnchor(anchor: number, kind: StatsPeriod, dir: number): number {
  if (kind === 'week') return addDays(weekStart(anchor), 7 * dir)
  if (kind === 'month') return addMonths(startOfMonth(anchor), dir)
  return addMonths(startOfYear(anchor), 12 * dir)
}

/**
 * 某一期里，完成次数按时间桶摊开：
 *   周 → 7 天（周一起），月 → 这个月的每一天，年 → 12 个月。
 * 桶的归属一律查表（零点 → 下标），不做 (at - start) / 86400000 —— 夏令时那天会算到隔壁桶。
 * 只认 isDone()，和上面所有统计一个口径。
 */
export function periodView(tasks: Task[], kind: StatsPeriod, anchor: number,
                           now = Date.now()): PeriodView {
  let start: number, end: number
  if (kind === 'week') { start = weekStart(anchor); end = addDays(start, 7) }
  else if (kind === 'month') { start = startOfMonth(anchor); end = addMonths(start, 1) }
  else { start = startOfYear(anchor); end = addMonths(start, 12) }

  const buckets: PeriodBucket[] = []
  const slotOf = new Map<number, number>()
  const add = (key: number) => { slotOf.set(key, buckets.length); buckets.push({ start: key, count: 0 }) }
  if (kind === 'week' || kind === 'month') {
    for (let d = start; d < end; d = addDays(d, 1)) add(d)
  } else {
    for (let m = 0; m < 12; m++) add(addMonths(start, m))
  }

  let total = 0
  for (const t of tasks) {
    if (!isDone(t)) continue
    const at = t.completedAt!
    if (at < start || at >= end) continue
    total++
    const key = kind === 'year' ? startOfMonth(at) : startOfDay(at)
    const i = slotOf.get(key)
    if (i !== undefined) buckets[i]!.count++
  }
  return { kind, start, end, total, buckets, hasNext: end <= now }
}

/**
 * 每一组在某一期里做过几次。key 和 summarize() 的 groups[].key 完全一致，
 * 界面拿它给「周期性任务分别做了几次」的每行算主数字。
 */
export function countsInRange(tasks: Task[], start: number, end: number): Map<string, number> {
  const keyOf = keyMaker(tasks)
  const out = new Map<string, number>()
  for (const t of tasks) {
    if (!isDone(t)) continue
    const at = t.completedAt!
    if (at < start || at >= end) continue
    const key = keyOf(t)
    if (key === null) continue
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

/**
 * 每一组在**这一期**里，按该期的时间桶分别完成几次 —— 桶和 periodView 的 buckets
 * 一一对应：周看 7 天、月看当月每天、年看 12 个月。
 * 界面拿它给「周期性任务分别做了几次」每行画和「完成分布」同款的胶囊柱，
 * 于是能看出「这件具体的事是哪几天做掉的」；共享周期一变，这里也跟着变。
 */
export function groupPeriodBuckets(tasks: Task[], kind: StatsPeriod, anchor: number,
                                   now = Date.now()):
    { buckets: PeriodBucket[]; byGroup: Map<string, number[]> } {
  const pv = periodView(tasks, kind, anchor, now)
  const slotOf = new Map(pv.buckets.map((b, i) => [b.start, i] as const))
  const keyOf = keyMaker(tasks)
  const byGroup = new Map<string, number[]>()
  for (const t of tasks) {
    if (!isDone(t)) continue
    const at = t.completedAt!
    if (at < pv.start || at >= pv.end) continue
    const key = kind === 'year' ? startOfMonth(at) : startOfDay(at)
    const i = slotOf.get(key)
    if (i === undefined) continue
    const groupKey = keyOf(t)
    if (groupKey === null) continue
    let arr = byGroup.get(groupKey)
    if (!arr) { arr = Array(pv.buckets.length).fill(0) as number[]; byGroup.set(groupKey, arr) }
    arr[i]!++
  }
  return { buckets: pv.buckets, byGroup }
}

/* ── 本期「按规则应该完成几次」 ───────────────────────────────
 * 分母不是拍脑袋定的：拿这一系列最早一期的排期作锚点，把当前的重复规则在本期
 * 区间里展开，数出排到了几次。**只数到此刻为止** —— 本周还有四天没到，不该拿
 * 未来的四天凑出一个「你还欠 4 次」；翻到过去的期则整期都算。
 *
 * 分母只认规则：删掉某一期不会让这里少一次 —— 删除只影响完成数（见文件头）。
 * 这样「完成 N/M」不会因为清理历史而变小；被删的那次若本来就没做，会如实显示成没完成。
 *
 * 算不出来的就不给分母（界面退回只写完成了几次）：
 *   · 系列没有重复规则（老数据，或用户把当前这一期的规则清掉了）
 *   · 'afterCompletion'：下一期取决于什么时候勾完，规则里没有固定排期
 *   · 规则读不懂、或本期整体落在这条系列出现之前
 *
 * 规则中途改过的话，历史那段按最新规则估算，是近似值。补勾、漏勾后补做导致
 * 分子大于分母时不在这里夹 —— core 只管如实展开，显示层按完成次数兜底。
 */
const EXPECTED_MAX = 400

export function expectedInRange(tasks: Task[], start: number, end: number,
                                now = Date.now()): Map<string, number> {
  const keyOf = keyMaker(tasks)
  type Info = { rule: RepeatRule; ruleAt: number; anchor: number }
  const info = new Map<string, Info>()
  for (const t of tasks) {
    if (!isAlive(t) || !t.repeat || t.repeat.mode === 'afterCompletion') continue
    const key = keyOf(t)
    if (key === null) continue
    // 相位取最早那一期；规则取最近那一期（和 RepeatGroup.rule 一个口径）
    const when = t.startAt ?? t.createdAt
    const recent = t.completedAt ?? t.createdAt
    const cur = info.get(key)
    if (!cur) info.set(key, { rule: t.repeat, ruleAt: recent, anchor: when })
    else {
      if (when < cur.anchor) cur.anchor = when
      if (recent >= cur.ruleAt) { cur.rule = t.repeat; cur.ruleAt = recent }
    }
  }

  const to = Math.min(end - 1, now)
  const out = new Map<string, number>()
  for (const [key, { rule, anchor }] of info) {
    if (anchor > to) continue
    const parsed = parseRrule(toRruleString(rule))
    if (!parsed) continue
    const from = Math.max(start, anchor)
    if (from > to) continue
    // cursor 比锚点早 1ms，锚点当天那一期才不会被 nextAfter 跳过（系列中途建的情况）
    let cursor = Math.max(from - 1, anchor - 1)
    let n = 0
    while (n < EXPECTED_MAX) {
      const at = nextAfter(parsed, anchor, cursor)
      if (at === null || at > to) break
      if (at >= from) n++
      cursor = at
    }
    if (n > 0) out.set(key, n)
  }
  return out
}
