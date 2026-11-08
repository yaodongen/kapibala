import { describe, expect, it } from 'vitest'
import { STATS_YEAR_WEEKS, countsInRange, expectedInRange, groupPeriodBuckets, periodView,
         seriesDoneCount, shiftAnchor, statsEligibleRule, summarize } from '../src/stats.ts'
import type { RepeatRule, Task } from '../src/types.ts'

/** 固定一个周三中午：本周（周一 11-02 起）还剩四天没到，点阵的留白才有得测 */
const NOW = new Date(2026, 10, 4, 12, 0).getTime()
const at = (m: number, d: number, h = 9) => new Date(2026, m - 1, d, h).getTime()
const day = (m: number, d: number) => new Date(2026, m - 1, d).getTime()

const task = (o: Partial<Task> & { id: string }): Task => ({
  title: '任务', isAllDay: true, reminders: [], order: '',
  inProgress: false, important: false, createdAt: 0, deleted: false, ...o,
})

const RULE = { rrule: 'FREQ=DAILY' }
/** 一个系列里的一期。id 里带序号，createdAt 也跟着涨，pending 才有得挑 */
const occ = (n: number, doneAt?: number, extra: Partial<Task> = {}): Task => task({
  id: `S-${n}`, title: '每天读书', seriesId: 'SERIES', repeat: RULE,
  createdAt: n, ...(doneAt === undefined ? {} : { completedAt: doneAt }), ...extra,
})

describe('统计 · 空库和最近一年的点阵', () => {
  it('什么都没有时全部归零，滚动 53 周照铺，只有未来几天留白', () => {
    const s = summarize([], NOW)
    expect(s.totalDone).toBe(0)
    expect(s.repeatDone).toBe(0)
    expect(s.last30).toBe(0)
    expect(s.activeDays).toBe(0)
    expect(s.groups).toEqual([])
    // 最后一列是本周（11/2 周一起），往前 52 周到去年 11/3，跨年是连着的
    expect(s.weeks).toHaveLength(STATS_YEAR_WEEKS)
    expect(s.weeks.every(w => w.days.length === 7 && w.count === 0)).toBe(true)
    expect(s.weeks[0]!.start).toBe(new Date(2025, 10, 3).getTime())
    expect(s.weeks.at(-1)!.start).toBe(day(11, 2))
    expect(s.weeks[0]!.days.every(x => x === 0)).toBe(true)
    // 本周（11/2 起）周四到周日还没到，留白而不是「欠了几天」
    expect(s.weeks.at(-1)!.days.filter(x => x === null)).toHaveLength(4)
  })

  it('滚动一年不按自然年切：去年 11 月那次还画在第一列里', () => {
    const s = summarize([
      task({ id: 'lastNov', completedAt: new Date(2025, 10, 5, 9).getTime(), seriesId: 'A', repeat: RULE }),
    ], NOW)
    expect(s.weeks[0]!.days[2]).toBe(1)       // 去年 11/5 是周三
    expect(s.activeDays).toBe(1)
    expect(s.totalDone).toBe(1)
  })

  it('一周从周一起：周一落在第一格，周日落在上一周的最后一格', () => {
    const s = summarize([
      task({ id: 'mon', completedAt: at(11, 2) }),
      task({ id: 'sun', completedAt: at(11, 1) }),
    ], NOW)
    const thisWeek = s.weeks.find(w => w.start === day(11, 2))!
    const prevWeek = s.weeks.find(w => w.start === day(10, 26))!
    expect(thisWeek.days[0]).toBe(1)
    expect(prevWeek.days[6]).toBe(1)
    expect(thisWeek.count).toBe(1)
    expect(s.activeDays).toBe(2)
  })
})

describe('统计 · 周期系列做过几次', () => {
  it('三期完成 = 做过 3 次，首次 / 最近 / 待做的下一期都对得上', () => {
    const s = summarize([
      occ(1, at(9, 1)), occ(2, at(10, 1)), occ(3, at(11, 2)), occ(4),
    ], NOW)
    expect(s.groups).toHaveLength(1)
    const g = s.groups[0]!
    expect(g.count).toBe(3)
    expect(g.firstAt).toBe(at(9, 1))
    expect(g.lastAt).toBe(at(11, 2))
    expect(g.latestId).toBe('S-3')
    expect(g.pendingId).toBe('S-4')
    expect(g.rule).toEqual(RULE)
    expect(s.totalDone).toBe(3)
    expect(s.repeatDone).toBe(3)
    expect(s.last30).toBe(1)
    expect(s.activeDays).toBe(3)
  })

  it('系列首期自己没写 seriesId，靠后续实例的 seriesId 也能认回同一组', () => {
    const s = summarize([
      task({ id: 'SERIES', title: '每天读书', repeat: RULE, completedAt: at(10, 20) }),
      task({ id: 'NEXT', title: '每天读书', seriesId: 'SERIES', repeat: RULE, completedAt: at(10, 21) }),
    ], NOW)
    expect(s.groups).toHaveLength(1)
    expect(s.groups[0]!.count).toBe(2)
    expect(s.groups[0]!.firstAt).toBe(at(10, 20))
    expect(s.groups[0]!.lastAt).toBe(at(10, 21))
  })

  it('系列中途改过标题，统计跟到派生出来的待做期；取消勾选的那期不算', () => {
    const s = summarize([
      occ(1, at(10, 1)),
      occ(2, at(10, 2), { title: '每天读书 30 分钟' }),
      occ(3, undefined, { title: '每天读书 30 分钟' }),   // 派生出来的待做期继承新标题
    ], NOW)
    expect(s.groups[0]!.title).toBe('每天读书 30 分钟')
    expect(s.groups[0]!.count).toBe(2)
    expect(s.groups[0]!.pendingId).toBe('S-3')
  })

  it('只改了待做那一期的标题 / 周期，列表就按当前这一期显示和判断', () => {
    const renamed = summarize([
      occ(1, at(10, 1)),
      occ(2, at(10, 2)),
      occ(3, undefined, { title: '每天读书 30 分钟' }),
    ], NOW)
    expect(renamed.groups[0]!.title).toBe('每天读书 30 分钟')

    // 待做期把周期换成每两周：当前规则 > 7 天，这一行立刻不进排行；
    // 已完成的 2 次仍算进累计 / 其中周期性任务。
    const retimed = summarize([
      occ(1, at(10, 1)),
      occ(2, at(10, 2)),
      occ(3, undefined, { repeat: { rrule: 'FREQ=WEEKLY;INTERVAL=2' } }),
    ], NOW)
    expect(retimed.groups).toEqual([])
    expect(retimed.repeatDone).toBe(2)
  })

  it('垃圾桶里的、清空过的都不算：删掉的是那一次', () => {
    const s = summarize([
      occ(1, at(10, 1)),
      occ(2, at(10, 2), { deleted: true }),
      occ(3, at(10, 3), { purgedAt: at(10, 4) }),
      occ(4),
    ], NOW)
    expect(s.groups[0]!.count).toBe(1)
    expect(s.totalDone).toBe(1)
  })

  it('不同系列同名不会被硬凑到一起；按次数降序、同次数按最近完成降序', () => {
    const s = summarize([
      task({ id: 'a1', title: '喝水', seriesId: 'A', completedAt: at(9, 2) }),
      task({ id: 'b1', title: '喝水', seriesId: 'B', completedAt: at(11, 2) }),
      task({ id: 'b2', title: '喝水', seriesId: 'B', completedAt: at(11, 3) }),
      task({ id: 'c1', title: '散步', seriesId: 'C', completedAt: at(10, 1) }),
    ], NOW)
    expect(s.groups).toHaveLength(3)
    expect(s.groups.map(g => [g.key, g.count])).toEqual([
      ['s:B', 2], ['s:C', 1], ['s:A', 1],
    ])
    // A、C 都做过一次，C 完成得更晚，排在前面
    expect(s.groups[1]!.key).toBe('s:C')
  })

  it('待做的那一期不存在时只给最近完成那一期的 id', () => {
    const s = summarize([occ(1, at(10, 1))], NOW)
    expect(s.groups[0]!.pendingId).toBeUndefined()
    expect(s.groups[0]!.latestId).toBe('S-1')
  })
})

describe('统计 · 同名的一次性任务不算周期性任务', () => {
  it('同一标题反复出现也不会被按标题合并；完成仍计入累计 / 最近 30 天 / 点阵', () => {
    const s = summarize([
      task({ id: 'x1', title: '取快递', completedAt: at(10, 20) }),
      task({ id: 'x2', title: '  取快递  ', completedAt: at(10, 21) }),
      task({ id: 'y1', title: '交电费', completedAt: at(10, 22) }),
      task({ id: 'z1', title: 'Water  the plants', completedAt: at(10, 23) }),
      task({ id: 'z2', title: 'water the PLANTS', completedAt: at(10, 24) }),
    ], NOW)
    expect(s.groups).toEqual([])
    expect(s.totalDone).toBe(5)
    expect(s.repeatDone).toBe(0)
    expect(s.last30).toBe(5)
    expect(s.activeDays).toBe(5)
  })

  it('同名任务即使删过一期也不会被当成系列', () => {
    const s = summarize([
      task({ id: 't1', title: '买菜', completedAt: at(11, 1) }),
      task({ id: 't2', title: '买菜', completedAt: at(11, 2), deleted: true }),
      task({ id: 't3', title: '买菜', completedAt: at(11, 3) }),
    ], NOW)
    expect(s.groups).toEqual([])
    expect(s.totalDone).toBe(2)
    expect(s.repeatDone).toBe(0)
  })
})

describe('统计 · 详情栏那枚「已做过 N 次」', () => {
  it('选中系列里的任意一期都报整个系列的累计，勾完一期就 +1', () => {
    const list = [occ(1, at(10, 1)), occ(2, at(10, 2)), occ(3)]
    expect(seriesDoneCount(list, list[0]!)).toBe(2)
    expect(seriesDoneCount(list, list[2]!)).toBe(2)   // 待做的下一期也看得到
    const after = [occ(1, at(10, 1)), occ(2, at(10, 2)), occ(3, at(10, 3)), occ(4)]
    expect(seriesDoneCount(after, after[3]!)).toBe(3)
  })

  it('一次性任务、以及一次都没做过的周期性任务不显示', () => {
    const one = task({ id: 'a', completedAt: at(10, 1) })
    expect(seriesDoneCount([one], one)).toBeNull()
    expect(seriesDoneCount([occ(1)], occ(1))).toBeNull()
  })
})

describe('统计 · 周 / 月 / 年', () => {
  /** 本周一 09:00、周一 15:00、周三 10:00，另有一次在上个月 */
  const list = [
    occ(1, at(11, 2, 9)), occ(2, at(11, 2, 15)), occ(3, at(11, 4, 10)), occ(4, at(10, 20, 9)),
    occ(5, at(11, 3, 9), { deleted: true }),   // 垃圾桶里的不算
    occ(6),                                    // 还活着的待做期：这一系列没有放弃
  ]

  it('周视图：7 根柱、周一起、按天分桶，本期 3 次', () => {
    const p = periodView(list, 'week', NOW)
    expect(p.buckets).toHaveLength(7)
    expect(p.buckets[0]!.start).toBe(day(11, 2))
    expect(p.buckets.map(b => b.count)).toEqual([2, 0, 1, 0, 0, 0, 0])
    expect(p.total).toBe(3)
    expect(p.hasNext).toBe(false)               // 本期还没过完，不能往后翻
  })

  it('月视图：这个月每天一根柱，上个月的不进来', () => {
    const p = periodView(list, 'month', NOW)
    expect(p.buckets).toHaveLength(30)          // 2026 年 11 月
    expect(p.total).toBe(3)
    expect(p.buckets[1]!.count).toBe(2)         // 11/2
  })

  it('年视图：12 个月，上个月那次也在这一年里', () => {
    const p = periodView(list, 'year', NOW)
    expect(p.buckets).toHaveLength(12)
    expect(p.total).toBe(4)
    expect(p.buckets[9]!.count).toBe(1)         // 10 月
    expect(p.buckets[10]!.count).toBe(3)        // 11 月
  })

  it('翻页：从期首加减，1 月 31 日 +1 个月不会跳到 3 月', () => {
    expect(shiftAnchor(NOW, 'week', -1)).toBe(day(10, 26))
    expect(shiftAnchor(NOW, 'month', -1)).toBe(day(10, 1))
    expect(shiftAnchor(NOW, 'year', -1)).toBe(new Date(2025, 0, 1).getTime())
    expect(shiftAnchor(new Date(2026, 0, 31).getTime(), 'month', 1)).toBe(day(2, 1))
  })

  it('本期里每一组做过几次：key 和 summarize 对得上', () => {
    const s = summarize(list, NOW)
    const c = countsInRange(list, day(11, 2), day(11, 9))
    expect(c.get(s.groups[0]!.key)).toBe(3)
    expect(c.get('s:不存在')).toBeUndefined()
  })

  it('分组明细：桶和「完成分布」一一对应，看得出具体哪天做掉', () => {
    const s = summarize(list, NOW)
    const d = groupPeriodBuckets(list, 'week', NOW)
    expect(d.buckets).toHaveLength(7)
    expect(d.byGroup.get(s.groups[0]!.key)).toEqual([2, 0, 1, 0, 0, 0, 0])
    expect(d.byGroup.get('s:不存在')).toBeUndefined()
  })

  it('分组明细跟着周期变：月看每天、年看 12 个月', () => {
    const s = summarize(list, NOW)
    const m = groupPeriodBuckets(list, 'month', NOW)
    expect(m.buckets).toHaveLength(30)
    expect(m.byGroup.get(s.groups[0]!.key)![1]).toBe(2)        // 11/2
    const y = groupPeriodBuckets(list, 'year', NOW)
    expect(y.buckets).toHaveLength(12)
    expect(y.byGroup.get(s.groups[0]!.key)![10]).toBe(3)       // 11 月
    expect(y.byGroup.get(s.groups[0]!.key)![9]).toBe(1)        // 10 月
  })

  it('翻到上一周，明细跟着换一批桶', () => {
    const s = summarize(list, NOW)
    const prev = groupPeriodBuckets(list, 'week', day(10, 28))
    expect(prev.buckets[0]!.start).toBe(day(10, 26))
    const arr = prev.byGroup.get(s.groups[0]!.key)
    expect(arr?.reduce((a, b) => a + b, 0) ?? 0).toBe(0)      // 那一周这个系列没做
  })
})

describe('统计 · 累计与时间范围', () => {
  it('点阵只画最近一年，更早的完成仍计入累计次数', () => {
    const s = summarize([
      task({ id: 'tooOld', completedAt: new Date(2024, 4, 5, 9).getTime(), seriesId: 'OLD', repeat: RULE }),
      task({ id: 'inRange', completedAt: at(11, 2), seriesId: 'NEW', repeat: RULE }),
    ], NOW)
    expect(s.totalDone).toBe(2)
    expect(s.last30).toBe(1)
    expect(s.activeDays).toBe(1)
    expect(s.weeks.reduce((n, w) => n + w.count, 0)).toBe(1)
    expect(s.groups).toHaveLength(2)
    expect(s.groups.every(g => g.count === 1)).toBe(true)
  })

  it('最近 30 天含今天，按完成时刻算而不是按安排日期', () => {
    const s = summarize([
      task({ id: 'a', startAt: at(1, 1), completedAt: at(11, 4, 8) }),  // 排在一月、今天完成
      task({ id: 'b', startAt: at(11, 4), completedAt: at(10, 5) }),    // 排在今天、上月完成
    ], NOW)
    expect(s.last30).toBe(1)
    expect(s.totalDone).toBe(2)
  })
})

describe('统计 · 本期按规则应该完成几次', () => {
  /** 一期 = 一条实例。startAt 是排期，completedAt 是勾完的时刻 */
  const occ2 = (n: number, start: number, rrule: string, doneAt?: number) => task({
    id: `E-${n}`, title: '每天读书', seriesId: 'EXPECTED', repeat: { rrule },
    startAt: start, createdAt: start,
    ...(doneAt === undefined ? {} : { completedAt: doneAt }),
  })
  const daily = [
    occ2(1, at(10, 26, 9), 'FREQ=DAILY', at(10, 26, 9)),
    occ2(2, at(11, 2, 9), 'FREQ=DAILY', at(11, 2, 9)),
    occ2(3, at(11, 3, 9), 'FREQ=DAILY', at(11, 3, 9)),
    occ2(4, at(11, 4, 9), 'FREQ=DAILY'),           // 当前待做的那一期
  ]

  it('本周只算到此刻：周三中午，每天的任务应完成 3 次，不把周四周日算进来', () => {
    const m = expectedInRange(daily, day(11, 2), day(11, 9), NOW)
    expect(m.get('s:EXPECTED')).toBe(3)
    // key 和 summarize 的分组对得上，界面才能直接查表
    expect(summarize(daily, NOW).groups[0]!.key).toBe('s:EXPECTED')
  })

  it('翻到已经过去的那一周，整周 7 次都算', () => {
    expect(expectedInRange(daily, day(10, 26), day(11, 2), NOW).get('s:EXPECTED')).toBe(7)
  })

  it('月视图：本月到今天 4 次；每周一三五：本周到今天 2 次', () => {
    expect(expectedInRange(daily, day(11, 1), day(12, 1), NOW).get('s:EXPECTED')).toBe(4)
    const weekdays = [
      occ2(1, at(10, 26, 9), 'FREQ=WEEKLY;BYDAY=MO,WE,FR', at(10, 26, 9)),
      occ2(2, at(10, 28, 9), 'FREQ=WEEKLY;BYDAY=MO,WE,FR', at(10, 28, 9)),
    ]
    expect(expectedInRange(weekdays, day(11, 2), day(11, 9), NOW).get('s:EXPECTED')).toBe(2)
  })

  it('算不出来的不给分母：没设周期的任务 / 完成后再排期 / 本期在系列之前 / 读不懂的规则', () => {
    const m = expectedInRange([
      task({ id: 'plain', title: '买菜', completedAt: at(11, 2) }),
      task({ id: 'after', title: '浇水', seriesId: 'AFTER',
             repeat: { rrule: 'FREQ=DAILY', mode: 'afterCompletion' }, startAt: at(11, 1) }),
      occ2(9, at(11, 1, 9), 'GARBAGE'),
      ...daily,
    ], day(11, 2), day(11, 9), NOW)
    expect(m.get('s:EXPECTED')).toBe(3)
    expect([...m.keys()]).toEqual(['s:EXPECTED'])
    expect(m.has('s:AFTER')).toBe(false)
    expect(expectedInRange(daily, day(9, 1), day(9, 8), NOW).has('s:EXPECTED')).toBe(false)
  })

  it('间隔规则按系列首期相位展开，不会从期首重新数', () => {
    const every3 = [
      occ2(1, at(10, 25, 9), 'FREQ=DAILY;INTERVAL=3', at(10, 25, 9)),
      occ2(2, at(10, 28, 9), 'FREQ=DAILY;INTERVAL=3', at(10, 28, 9)),
      occ2(3, at(10, 31, 9), 'FREQ=DAILY;INTERVAL=3', at(10, 31, 9)),
      occ2(4, at(11, 3, 9), 'FREQ=DAILY;INTERVAL=3'),   // 11/3 待做
    ]
    // 本期从 11/2 起、到今天中午：相位落在 11/3，只排到一期
    expect(expectedInRange(every3, day(11, 2), day(11, 9), NOW).get('s:EXPECTED')).toBe(1)
  })

  it('规则里的 UNTIL 之后不再排期', () => {
    const ended = [occ2(1, at(10, 26, 9), 'FREQ=DAILY;UNTIL=20261101', at(10, 26, 9))]
    expect(expectedInRange(ended, day(11, 2), day(11, 9), NOW).has('s:EXPECTED')).toBe(false)
  })
})

describe('统计 · 周期 > 7 天的不进周期性任务列表', () => {
  it('按 freq + interval 折算天数：日 1~7、周 1 保留，其余剔除', () => {
    const cases: Array<[RepeatRule | undefined, boolean]> = [
      [undefined, true],                                    // 没规则（老数据 / 清掉规则的系列）不拦
      [{ rrule: 'FREQ=DAILY' }, true],
      [{ rrule: 'FREQ=DAILY;INTERVAL=7' }, true],           // 正好 7 天算「不大于」
      [{ rrule: 'FREQ=DAILY;INTERVAL=8' }, false],
      [{ rrule: 'FREQ=DAILY;INTERVAL=17' }, false],
      [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' }, true],
      [{ rrule: 'FREQ=WEEKLY;BYDAY=SA,SU' }, true],
      [{ rrule: 'FREQ=WEEKLY;INTERVAL=2' }, false],
      [{ rrule: 'FREQ=MONTHLY;BYDAY=2TU' }, false],
      [{ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' }, false],  // 一月两次也还是月周期
      [{ rrule: 'FREQ=YEARLY' }, false],
      [{ freq: 'DAILY', interval: 3 }, true],               // 0.0.x 留下的老格式
      [{ freq: 'MONTHLY' }, false],
      [{ rrule: 'GARBAGE' }, true],                         // 读不懂的规则不猜，照旧统计
    ]
    for (const [rule, want] of cases)
      expect(statsEligibleRule(rule), JSON.stringify(rule)).toBe(want)
  })

  it('长周期不进 groups，但累计完成 / 其中周期性任务 / 点阵照旧记着它', () => {
    const s = summarize([
      task({ id: 'd', seriesId: 'D', repeat: { rrule: 'FREQ=DAILY' }, completedAt: at(11, 2) }),
      task({ id: 'm', seriesId: 'M', repeat: { rrule: 'FREQ=MONTHLY;BYDAY=2TU' }, completedAt: at(11, 3) }),
      task({ id: 'e', seriesId: 'E', repeat: { rrule: 'FREQ=DAILY;INTERVAL=17' }, completedAt: at(11, 4) }),
      task({ id: 'p', completedAt: at(11, 4, 10) }),        // 一次性任务
    ], NOW)
    expect(s.groups.map(g => g.key)).toEqual(['s:D'])
    expect(s.totalDone).toBe(4)
    expect(s.repeatDone).toBe(3)      // 三个周期系列都算，不随列表过滤变
    expect(s.last30).toBe(4)
    expect(s.activeDays).toBe(3)      // 11/2、11/3、11/4 三天都有完成
  })

  it('详情栏「已做过 N 次」是任务自己的成就反馈，不受列表过滤影响', () => {
    const monthly = task({ id: 'm', seriesId: 'M', repeat: { rrule: 'FREQ=MONTHLY' },
                           completedAt: at(11, 3) })
    expect(seriesDoneCount([monthly], monthly)).toBe(1)
  })
})

describe('统计 · 已删除的任务', () => {
  const R = { rrule: 'FREQ=DAILY' }
  const occ = (id: string, d: number, extra: Partial<Task> = {}) => task({
    id, title: '每天读书', seriesId: 'DEL', repeat: R,
    startAt: at(11, d, 9), createdAt: at(11, d, 9),
    ...(extra.completedAt === undefined && d <= 3 ? { completedAt: at(11, d, 9) } : {}),
    ...extra,
  })

  it('垃圾桶里 / 已清空的一期不算完成 / 待做 / 分组；规则排到的槽位仍计入分母', () => {
    const list = [
      occ('d1', 2),
      occ('d2', 3, { deleted: true }),
      occ('d3', 4, { purgedAt: at(11, 5) }),
      occ('d4', 5),                                  // 当前待做的那一期
    ]
    const s = summarize(list, NOW)
    expect(s.totalDone).toBe(1)
    expect(s.last30).toBe(1)
    expect(s.repeatDone).toBe(1)
    expect(s.groups).toHaveLength(1)
    expect(s.groups[0]!.count).toBe(1)
    expect(s.groups[0]!.pendingId).toBe('d4')
    expect(countsInRange(list, day(11, 2), day(11, 9)).get('s:DEL')).toBe(1)
    expect(periodView(list, 'week', NOW).total).toBe(1)
    // 分母是规则在这一期排到的次数：11/2、11/3、11/4 三格照算。
    // 删掉实例只影响完成数，不会把规则里那个槽位一起抹掉。
    expect(expectedInRange(list, day(11, 2), day(11, 9), NOW).get('s:DEL')).toBe(3)
  })

  it('删掉当前待做的那一期 = 这条周期任务不做了，不再列入排行', () => {
    const list = [
      occ('a1', 2),
      occ('a2', 3, { completedAt: undefined, deleted: true }),
    ]
    const s = summarize(list, NOW)
    expect(s.groups).toEqual([])
    // 但完成的史实不抹：累计、其中周期性任务、点阵、分布照旧记着
    expect(s.totalDone).toBe(1)
    expect(s.repeatDone).toBe(1)
    expect(s.activeDays).toBe(1)
    expect(countsInRange(list, day(11, 2), day(11, 9)).get('s:DEL')).toBe(1)
  })

  it('只删掉旧的一期、后面还有待做的，系列照旧留着，那一次不算', () => {
    const s = summarize([
      occ('k1', 2, { deleted: true }),
      occ('k2', 3),
      occ('k3', 5, { completedAt: undefined }),
    ], NOW)
    expect(s.groups.map(g => g.key)).toEqual(['s:DEL'])
    expect(s.groups[0]!.count).toBe(1)
    expect(s.totalDone).toBe(1)
  })

  it('自然结束（UNTIL）的系列，删掉一条旧完成记录仍留在排行', () => {
    const R2 = { rrule: 'FREQ=DAILY;UNTIL=20261103' }
    const s = summarize([
      occ('e1', 2, { repeat: R2 }),
      occ('e2', 3, { repeat: R2, deleted: true }),
    ], NOW)
    expect(s.groups.map(g => [g.key, g.count])).toEqual([['s:DEL', 1]])
    expect(s.totalDone).toBe(1)
  })

  it('整组都删光了就一行都不出现', () => {
    const s = summarize([
      occ('x1', 2, { deleted: true }),
      occ('x2', 3, { completedAt: undefined, purgedAt: at(11, 4) }),
    ], NOW)
    expect(s.groups).toEqual([])
    expect(s.totalDone).toBe(0)
  })

})
