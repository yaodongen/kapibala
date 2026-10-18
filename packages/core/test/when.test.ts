import { describe, expect, it } from 'vitest'
import { REPEAT_PATTERNS, WHEN_PATTERNS, cnNumber, parseRepeatIn, parseWhenIn, whenToStart,
         type WhenHit } from '../src/when.ts'

/**
 * 把"现在"钉死在 2026-08-26（周三）10:30。
 * 相对说法（明天、下周三、next monday）的期望值都按这一天算 ——
 * 不然测试结果跟着跑测试的那天变，周五跑绿、周一跑红。
 */
const NOW = +new Date('2026-08-26T10:30:00')
const day = (s: string) => +new Date(`${s}T00:00:00`)
const at = (h: number, m = 0) => h * 60 + m

function parse(text: string): WhenHit | null {
  return parseWhenIn(text, NOW)
}

function expectDay(text: string, iso: string) {
  const hit = parse(text)
  expect(hit, text).not.toBeNull()
  expect(new Date(hit!.day!), text).toEqual(new Date(day(iso)))
  expect(hit!.allDay, text).toBe(true)
}

function expectAt(text: string, iso: string, h: number, m = 0) {
  const hit = parse(text)
  expect(hit, text).not.toBeNull()
  expect(new Date(hit!.day!), text).toEqual(new Date(day(iso)))
  expect(hit!.minutes, text).toBe(at(h, m))
  expect(hit!.allDay, text).toBe(false)
}

function expectTimeOnly(text: string, h: number, m = 0) {
  const hit = parse(text)
  expect(hit, text).not.toBeNull()
  expect(hit!.day, text).toBeUndefined()
  expect(hit!.minutes, text).toBe(at(h, m))
}

describe('中文日期', () => {
  it('相对日子', () => {
    expectDay('今天开会', '2026-08-26')
    expectDay('明天开会', '2026-08-27')
    expectDay('后天开会', '2026-08-28')
    expectDay('大后天开会', '2026-08-29')
    expectDay('昨天开会', '2026-08-25')
    expectDay('前天开会', '2026-08-24')
  })

  it('星期说法', () => {
    expectDay('周三开会', '2026-08-26')       // 今天就是周三，算今天
    expectDay('周四开会', '2026-08-27')
    expectDay('星期三开会', '2026-08-26')
    expectDay('礼拜五开会', '2026-08-28')
    expectDay('下周三开会', '2026-09-02')
    expectDay('下个星期三开会', '2026-09-02')
    expectDay('本周五开会', '2026-08-28')
    expectDay('这周五开会', '2026-08-28')
    expectDay('上周三开会', '2026-08-19')
    expectDay('周末去露营', '2026-08-29')     // 周末算最近的周六
    expectDay('下周末去露营', '2026-09-05')
  })

  it('下周 / 本周 / 上周（没有具体星期几）', () => {
    expectDay('下周交报告', '2026-08-31')     // 落在下周一
    expectDay('本周交报告', '2026-08-24')
    expectDay('上周交报告', '2026-08-17')
  })

  it('绝对日期', () => {
    expectDay('3月5日交报告', '2027-03-05')   // 今年 3 月已过，顺延到明年
    expectDay('9月1日交报告', '2026-09-01')
    expectDay('2026年8月28日交报告', '2026-08-28')
    expectDay('2027年3月5日交报告', '2027-03-05')
    expectDay('5号交报告', '2026-09-05')      // 本月 5 号已过 → 下月
    expectDay('28号交报告', '2026-08-28')     // 本月还没到 → 本月
    expectDay('下个月5号交报告', '2026-09-05')
    expectDay('本月28号交报告', '2026-08-28')
  })

  it('N 天 / N 周 / N 月 / N 年以后', () => {
    expectDay('3天后交报告', '2026-08-29')
    expectDay('再过两周交报告', '2026-09-09')
    expectDay('两个月以后交报告', '2026-10-26')
    expectDay('一年后交报告', '2027-08-26')
  })

  it('月底 / 年底', () => {
    expectDay('月底交报告', '2026-08-31')
    expectDay('下个月底交报告', '2026-09-30')
    expectDay('明年底交报告', '2027-12-31')
  })
})

describe('中文时间', () => {
  it('钟点 + 时段', () => {
    expectAt('明天下午3点开会', '2026-08-27', 15, 0)
    expectAt('明天上午9点开会', '2026-08-27', 9, 0)
    expectAt('明天下午3点半开会', '2026-08-27', 15, 30)
    expectAt('明天15点30分开会', '2026-08-27', 15, 30)
    expectAt('明天15:30开会', '2026-08-27', 15, 30)   // 全角冒号也认
    expectAt('明天晚上8点半开会', '2026-08-27', 20, 30)
    expectAt('明天中午12点吃饭', '2026-08-27', 12, 0)
    expectAt('明天中午1点吃饭', '2026-08-27', 13, 0)
    expectAt('明天凌晨1点出发', '2026-08-27', 1, 0)
  })

  it('中文数字', () => {
    expectAt('明天三点半开会', '2026-08-27', 3, 30)
    expectAt('明天下午三点开会', '2026-08-27', 15, 0)
    expectAt('明天上午十点开会', '2026-08-27', 10, 0)
    expectAt('明天晚上十一点开会', '2026-08-27', 23, 0)
  })

  it('日子自带时段，和钟点合起来', () => {
    expectAt('今晚8点看电影', '2026-08-26', 20, 0)
    expectAt('今早9点开会', '2026-08-26', 9, 0)
    expectAt('明晚7点吃饭', '2026-08-27', 19, 0)
    expectAt('明早开会', '2026-08-27', 9, 0)              // 只有时段，落约定整点
    expectAt('今晚看电影', '2026-08-26', 20, 0)
  })

  it('光说到时段', () => {
    expectTimeOnly('下午三点开会', 15, 0)
    expectTimeOnly('下午开会', 15, 0)
    expectTimeOnly('上午开会', 9, 0)
    expectTimeOnly('中午吃饭', 12, 0)
    expectTimeOnly('晚上开会', 20, 0)
  })

  it('绝对日期 + 时间', () => {
    expectAt('3月5号下午2点交报告', '2027-03-05', 14, 0)
    expectAt('2026-08-28T19:30 上线', '2026-08-28', 19, 30)
  })
})

describe('英文日期', () => {
  it('相对日子', () => {
    expectDay('meeting today', '2026-08-26')
    expectDay('meeting tomorrow', '2026-08-27')
    expectDay('meeting yesterday', '2026-08-25')
    expectDay('meeting the day after tomorrow', '2026-08-28')
    expectDay('meeting in 3 days', '2026-08-29')
    expectDay('meeting in 2 weeks', '2026-09-09')
    expectDay('meeting 3 days from now', '2026-08-29')
    expectDay('meeting next week', '2026-08-31')
    expectDay('meeting next month', '2026-09-26')
  })

  it('星期说法', () => {
    expectDay('meeting on friday', '2026-08-28')
    expectDay('meeting on mon', '2026-08-31')
    expectDay('meeting next monday', '2026-08-31')
    expectDay('meeting this fri', '2026-08-28')
    expectDay('meeting last wed', '2026-08-19')
    expectDay('meeting on wednesday', '2026-08-26')   // 今天就是周三
  })

  it('月份 + 日', () => {
    expectDay('due jan 5', '2027-01-05')            // 已过 → 明年
    expectDay('due january 5th, 2027', '2027-01-05')
    expectDay('due 5 jan', '2027-01-05')
    expectDay('due sep 1', '2026-09-01')
  })

  it('数字日期', () => {
    expectDay('due 2026-08-28', '2026-08-28')
    expectDay('due 2026/08/28', '2026-08-28')
    expectDay('due 8/28', '2026-08-28')
    expectDay('due 8/28/2026', '2026-08-28')
    expectDay('due end of month', '2026-08-31')
    expectDay('due end of year', '2026-12-31')
  })
})

describe('英文时间', () => {
  it('am / pm', () => {
    expectTimeOnly('meeting at 3pm', 15, 0)
    expectTimeOnly('meeting at 3:30pm', 15, 30)
    expectTimeOnly('meeting at 11 a.m.', 11, 0)
    expectTimeOnly('meeting at 12am', 0, 0)
    expectTimeOnly('meeting at 12pm', 12, 0)
  })

  it('24 小时制和其他写法', () => {
    expectTimeOnly('meeting at 15:30', 15, 30)
    expectTimeOnly('meeting at 9:05', 9, 5)
    expectTimeOnly('meeting at 3', 3, 0)
    expectTimeOnly("meeting at 3 o'clock", 3, 0)
    expectTimeOnly('meeting at 3 in the afternoon', 15, 0)
  })

  it('时段', () => {
    expectTimeOnly('meeting in the morning', 9, 0)
    expectTimeOnly('meeting in the afternoon', 15, 0)
    expectTimeOnly('meeting at night', 20, 0)
    expectTimeOnly('meeting at noon', 12, 0)
  })

  it('日子 + 时间', () => {
    expectAt('tomorrow at 9:30am standup', '2026-08-27', 9, 30)
    expectAt('tomorrow morning standup', '2026-08-27', 9, 0)
    expectAt('next monday at 3pm review', '2026-08-31', 15, 0)
    expectAt('tonight at 8pm movie', '2026-08-26', 20, 0)
    expectAt('tonight movie', '2026-08-26', 20, 0)
  })
})

describe('紧凑数字日期与点分隔日期', () => {
  it('8 位 YYYYMMDD，后面可跟紧凑时刻', () => {
    expectDay('20260630 吃饭', '2026-06-30')
    expectDay('20261231 吃饭', '2026-12-31')
    expectAt('20260630T1930 吃饭', '2026-06-30', 19, 30)
    expectAt('20260630 1930 吃饭', '2026-06-30', 19, 30)
  })

  it('6 位 YYMMDD，00–79 归 20xx、80–99 归 19xx', () => {
    expectDay('260630 吃饭', '2026-06-30')
    expectAt('260630T1930 吃饭', '2026-06-30', 19, 30)
  })

  it('4 位 MMDD，今年这天过了就顺延到明年', () => {
    expectDay('0630 吃饭', '2027-06-30')     // 2026-06-30 已过
    expectDay('1231 吃饭', '2026-12-31')     // 还没到
    expectDay('0101 吃饭', '2027-01-01')
    expectAt('0630 1930 吃饭', '2027-06-30', 19, 30)
  })

  it('点分隔的完整日期', () => {
    expectDay('2026.06.30 吃饭', '2026-06-30')
    expectDay('2026.6.30 吃饭', '2026-06-30')
    expectDay('due 2026.06.30', '2026-06-30')
    expectAt('2026.06.30 19:30 吃饭', '2026-06-30', 19, 30)
  })

  it('该不认的还是不认', () => {
    for (const s of ['20261340 吃饭', '99999999 吃饭', '0063 吃饭', '12345 吃饭',
                     '202606301 吃饭', '2606 吃饭'])
      expect(parse(s), s).toBeNull()
  })
})

describe('年份窗口：只认今年 ~ 今年 + 10 年', () => {
  it('窗口里的照认（下沿今年 1 月 1 日、上沿 10 年后年底）', () => {
    expectDay('20260101 吃饭', '2026-01-01')
    expectDay('20361231 吃饭', '2036-12-31')
    expectDay('10年后交报告', '2036-08-26')
  })

  it('窗口外的一律不认 —— 多半是编号或写错的年份', () => {
    for (const s of ['991231 吃饭', '000630 吃饭', '20990630 吃饭', '20370101 吃饭',
                     '1999-12-31 吃饭', '2037-01-01 吃饭', '11年后交报告', '20年后交报告'])
      expect(parse(s), s).toBeNull()
  })

  it('数字串被 - / . 切开时，里面的片段不能单独当日期', () => {
    // 少了这层保护，`2037-01-01` 会被 num.mmdd 从中间掏出"0101"当 1 月 1 日
    for (const s of ['2037-01-01 吃饭', '2037/01/01 吃饭', '2037.01.01 吃饭'])
      expect(parse(s), s).toBeNull()
  })

  it('1 月初说"前天"跨到去年时挡掉，"昨天"还在今年就照认', () => {
    const jan2 = +new Date('2026-01-02T10:00:00')
    expect(parseWhenIn('前天开会', jan2)).toBeNull()                    // 2025-12-31
    expect(parseWhenIn('昨天开会', jan2)?.day).toBe(day('2026-01-01'))  // 2026-01-01
  })
})


describe('认不出来就说认不出来', () => {
  it('没有日期时间的文本', () => {
    for (const s of ['买5个苹果', '写一份报告', '开会', '', '   ', '3.5 小时', 'fix the parser'])
      expect(parse(s), s).toBeNull()
  })

  it('非法日期不当日期', () => {
    expect(parse('2026-13-40')).toBeNull()
    // "2月30日"不成日期，但"30日"本身是个合法说法，退回认它 —— 这里只保证不会算成 3 月 2 日
    expect(parse('2月30日')?.day).not.toEqual(day('2026-03-02'))
  })
})

describe('解析出来的原文位置', () => {
  it('spans 指向原文里的说法，且不重复', () => {
    const hit = parse('明天下午3点开会')!
    expect(hit.text).toBe('明天下午3点')
    expect(hit.spans).toEqual([{ start: 0, end: 2 }, { start: 2, end: 6 }])
  })

  it('全角数字的位置也对得上', () => {
    const hit = parse('明天１５：３０开会')!
    expect(hit.minutes).toBe(at(15, 30))
    expect(hit.text).toBe('明天１５：３０')
  })

  it('时刻的 span 不吃前面的空格', () => {
    const hit = parse('6月30日 19:30 吃饭')!
    expect(hit.spans).toEqual([{ start: 0, end: 5 }, { start: 6, end: 11 }])
    expect(hit.text).toBe('6月30日 19:30')
  })
})

describe('落成时间戳', () => {
  it('有日期没时刻 → 全天', () => {
    const hit = parse('明天开会')!
    const out = whenToStart(hit, NOW)!
    expect(new Date(out.startAt)).toEqual(new Date(day('2026-08-27')))
    expect(out.isAllDay).toBe(true)
  })

  it('有日期有时刻 → 精确到点', () => {
    const hit = parse('明天下午3点开会')!
    const out = whenToStart(hit, NOW)!
    expect(out.isAllDay).toBe(false)
    const d = new Date(out.startAt)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()])
      .toEqual([2026, 8, 27, 15, 0])
  })

  it('只有时刻 → 按今天算', () => {
    const hit = parse('下午3点开会')!
    const out = whenToStart(hit, NOW)!
    expect(out.isAllDay).toBe(false)
    const d = new Date(out.startAt)
    expect([d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([8, 26, 15])
  })
})

describe('中文数字', () => {
  it('0–99', () => {
    expect(cnNumber('三')).toBe(3)
    expect(cnNumber('十')).toBe(10)
    expect(cnNumber('十五')).toBe(15)
    expect(cnNumber('二十')).toBe(20)
    expect(cnNumber('二十三')).toBe(23)
    expect(cnNumber('两')).toBe(2)
    expect(cnNumber('30')).toBe(30)
    expect(cnNumber('九十')).toBe(90)
  })

  it('认不出返回 null', () => {
    for (const s of ['', 'abc', '百']) expect(cnNumber(s), s).toBeNull()
  })
})

describe('重复说法', () => {
  const rule = (text: string) => parseRepeatIn(text)?.rrule ?? null

  it('每天 / 每 N 天', () => {
    expect(rule('每天看书')).toBe('FREQ=DAILY')
    expect(rule('每日看书')).toBe('FREQ=DAILY')
    expect(rule('每天都要喝水')).toBe('FREQ=DAILY')
    expect(rule('天天跑步')).toBe('FREQ=DAILY')
    expect(rule('每一天都要喝水')).toBe('FREQ=DAILY')
    expect(rule('每 2 天浇花')).toBe('FREQ=DAILY;INTERVAL=2')
    expect(rule('每两天浇花')).toBe('FREQ=DAILY;INTERVAL=2')
    expect(rule('每三天浇花')).toBe('FREQ=DAILY;INTERVAL=3')
    expect(rule('每２天浇花')).toBe('FREQ=DAILY;INTERVAL=2')   // 全角数字
  })

  it('每周某天 / 周末 / 工作日', () => {
    expect(rule('每周一 9:00 站会')).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(rule('每星期三开会')).toBe('FREQ=WEEKLY;BYDAY=WE')
    expect(rule('每礼拜天休息')).toBe('FREQ=WEEKLY;BYDAY=SU')
    expect(rule('每周末都需要跑步')).toBe('FREQ=WEEKLY;BYDAY=SA,SU')
    expect(rule('每个周末跑步')).toBe('FREQ=WEEKLY;BYDAY=SA,SU')
    expect(rule('每个工作日吃药')).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    expect(rule('每工作日吃药')).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    expect(rule('每周一次复盘')).toBe('FREQ=WEEKLY')          // "每周一"后面跟"次"不是周一
    expect(rule('每周两次健身')).toBeNull()                    // 一周两次表示不了，不猜
    expect(rule('每周八开会')).toBeNull()
  })

  it('每月：某日 / 最后一天 / 第几个周几', () => {
    expect(rule('每月19日交房租')).toBe('FREQ=MONTHLY;BYMONTHDAY=19')
    expect(rule('每个月 19 号交房租')).toBe('FREQ=MONTHLY;BYMONTHDAY=19')
    expect(rule('每月的19号交房租')).toBe('FREQ=MONTHLY;BYMONTHDAY=19')
    expect(rule('每月最后一天复盘')).toBe('FREQ=MONTHLY;BYMONTHDAY=-1')
    expect(rule('每个月的最后一天复盘')).toBe('FREQ=MONTHLY;BYMONTHDAY=-1')
    expect(rule('每月第二个周二开例会')).toBe('FREQ=MONTHLY;BYDAY=2TU')
    expect(rule('每月最后一个周五聚餐')).toBe('FREQ=MONTHLY;BYDAY=-1FR')
    expect(rule('每月交房租')).toBe('FREQ=MONTHLY')
    // 数值不合法时整句落空，不能退化成"每月一次"
    expect(rule('每月32号交房租')).toBeNull()
    expect(rule('每月第六个周二开会')).toBeNull()
    expect(rule('每月最后一个工作日复盘')).toBeNull()       // 表示不了，不猜
  })

  it('每年：某月某日 / 每年', () => {
    expect(rule('每年10月19日纪念')).toBe('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=19')
    expect(rule('每年的 2 月 29 日检查')).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')
    expect(rule('每年纪念')).toBe('FREQ=YEARLY')
    expect(rule('每年一次体检')).toBe('FREQ=YEARLY')
    expect(rule('每年的 2 月 30 日检查')).toBeNull()          // 那天不存在
    expect(rule('每年级开会')).toBeNull()                      // 每个年级，不是一年一次
  })

  it('英文', () => {
    expect(rule('every day run')).toBe('FREQ=DAILY')
    expect(rule('Daily standup')).toBe('FREQ=DAILY')
    expect(rule('every weekend run')).toBe('FREQ=WEEKLY;BYDAY=SA,SU')
    expect(rule('every Monday standup')).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(rule('every fri retro')).toBe('FREQ=WEEKLY;BYDAY=FR')
    expect(rule('every 2 days water')).toBe('FREQ=DAILY;INTERVAL=2')
    expect(rule('monthly report')).toBe('FREQ=MONTHLY')
    expect(rule('weekly sync')).toBe('FREQ=WEEKLY')
    expect(rule('yearly review')).toBe('FREQ=YEARLY')
    expect(rule('every 1000 days')).toBeNull()
  })

  it('没有重复说法就不碰：普通标题、只有日期、认不出来的星期', () => {
    for (const s of ['买菜', '明天买菜', '下周三开会', '周五开会', '3天后交报告', ''])
      expect(rule(s), s).toBeNull()
  })

  it('命中原文和位置按原样给（全角数字、大写都还回去）', () => {
    const a = parseRepeatIn('早上每天跑步')!
    expect(a.text).toBe('每天')
    expect(a.spans).toEqual([{ start: 2, end: 4 }])
    const b = parseRepeatIn('EVERY 2 DAYS watering')!
    expect(b.text).toBe('EVERY 2 DAYS')
    expect(b.spans).toEqual([{ start: 0, end: 12 }])
  })

  it('dateSpan 标出日子那一段，界面据此判断它是不是长在重复说法里', () => {
    const hit = parse('每周五 9:00 开会')!
    expect(hit.dateSpan).toBeDefined()
    const rep = parseRepeatIn('每周五 9:00 开会')!
    expect(hit.dateSpan!.start).toBeGreaterThanOrEqual(rep.spans[0]!.start)
    expect(hit.dateSpan!.end).toBeLessThanOrEqual(rep.spans[0]!.end)
    // 另写的日期不在重复说法里面
    const other = parse('明天每天跑步')!
    expect(other.dateSpan!.start).toBeLessThan(parseRepeatIn('明天每天跑步')!.spans[0]!.start)
  })
})

describe('具名正则清单', () => {
  it('覆盖中英文的日期和时间，名字不重复', () => {
    const names = WHEN_PATTERNS.map(p => p.name)
    const all = [...WHEN_PATTERNS, ...REPEAT_PATTERNS].map(p => p.name)
    expect(new Set(all).size).toBe(all.length)          // 两份清单之间也不能重名
    expect(names).toContain('cn.relative-day')
    expect(names).toContain('cn.weekday')
    expect(names).toContain('cn.period-clock')
    expect(names).toContain('en.relative-day')
    expect(names).toContain('en.weekday')
    expect(names).toContain('en.ampm')
    expect(WHEN_PATTERNS.length).toBeGreaterThanOrEqual(20)
    expect(REPEAT_PATTERNS.length).toBeGreaterThanOrEqual(15)
    for (const p of [...WHEN_PATTERNS, ...REPEAT_PATTERNS]) {
      expect(p.note.length, p.name).toBeGreaterThan(0)
      expect(p.re.global, p.name).toBe(false)      // 共享的正则不能带 g，会串 lastIndex
    }
  })
})
