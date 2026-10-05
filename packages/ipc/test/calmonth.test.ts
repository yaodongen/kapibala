import { describe, expect, it } from 'vitest'
import { monthAt, monthFirst, monthNo, monthWeekStart, monthWeeks } from '../src/index.ts'

const day = (s: string) => +new Date(`${s}T00:00`)
/** 星期几：0 = 周日。测试里直接看日期，比记"2026-08-01 是周六"可靠 */
const wd = (s: string) => new Date(day(s)).getDay()

describe('monthNo / monthAt：月份一律走"月序号"', () => {
  it('同一个月里哪天都是同一个序号', () => {
    expect(monthNo(day('2026-08-01'))).toBe(monthNo(day('2026-08-31')))
  })

  it('相邻月差 1，跨年也对', () => {
    expect(monthNo(day('2027-01-01')) - monthNo(day('2026-12-01'))).toBe(1)
    expect(monthNo(day('2026-01-01')) - monthNo(day('2025-12-31'))).toBe(1)
  })

  it('月序号换回时间戳：就是那个月 1 号的零点', () => {
    expect(monthAt(monthNo(day('2026-08-17')))).toBe(day('2026-08-01'))
    expect(monthFirst(day('2026-08-17'))).toBe(day('2026-08-01'))
  })

  it('31 号退一个月不溢出 —— 直接 setMonth 会停在原地（踩过）', () => {
    const no = monthNo(day('2026-07-31'))
    expect(monthAt(no - 1)).toBe(day('2026-06-01'))
    // 反例：拿 7/31 去 setMonth(5) 会溢出成 7 月 1 日，序号根本没往前
    const d = new Date(day('2026-07-31'))
    d.setMonth(d.getMonth() - 1)
    expect(monthNo(+d)).toBe(monthNo(day('2026-07-31')))
  })

  it('跨年往前退：1 月 - 1 个月是去年 12 月', () => {
    const no = monthNo(day('2027-01-15'))
    expect(monthAt(no - 1)).toBe(day('2026-12-01'))
  })

  it('1970 年之前（月序号为负）也算得对', () => {
    expect(monthAt(monthNo(day('1969-03-10')))).toBe(day('1969-03-01'))
    expect(monthNo(day('1969-12-01')) - monthNo(day('1970-01-01'))).toBe(-1)
  })
})

describe('monthWeekStart：格子从哪个周一开始画', () => {
  it('1 号是周一时不退，正好是 1 号', () => {
    // 2026-06-01 是周一
    expect(wd('2026-06-01')).toBe(1)
    expect(monthWeekStart(monthNo(day('2026-06-01')))).toBe(day('2026-06-01'))
  })

  it('1 号是周日时往回退 6 天（周一开头，不是周日）', () => {
    // 2026-02-01 是周日
    expect(wd('2026-02-01')).toBe(0)
    expect(monthWeekStart(monthNo(day('2026-02-01')))).toBe(day('2026-01-26'))
  })

  it('月中随便一天进去，画起的还是那个周一', () => {
    // 2026-08-01 是周六，它那一周的周一是 7/27
    expect(wd('2026-08-01')).toBe(6)
    expect(monthWeekStart(monthNo(day('2026-08-01')))).toBe(day('2026-07-27'))
  })

  it('跨年那一个月也退得对', () => {
    // 2027-01-01 是周五 → 周一落在 2026-12-28
    expect(wd('2027-01-01')).toBe(5)
    expect(monthWeekStart(monthNo(day('2027-01-01')))).toBe(day('2026-12-28'))
  })
})

describe('monthWeeks：这个月要铺几周', () => {
  it('周一开头 + 28 天（2026 年 2 月，1 号是周日）→ 5 周', () => {
    expect(monthWeeks(monthNo(day('2026-02-01')))).toBe(5)
  })

  it('周六开头 + 31 天（2026 年 8 月）→ 6 周', () => {
    expect(monthWeeks(monthNo(day('2026-08-01')))).toBe(6)
  })

  it('周一开头 + 30 天正好 5 周排满', () => {
    // 2026-06-01 是周一，30 天 → 30/7 = 4.28 → 5 周
    expect(monthWeeks(monthNo(day('2026-06-01')))).toBe(5)
  })

  it('闰年 2 月（2028 年，1 号是周二）也是 5 周', () => {
    expect(wd('2028-02-01')).toBe(2)
    expect(monthWeeks(monthNo(day('2028-02-01')))).toBe(5)
  })

  it('铺出来的周数一定装得下这个月，且不会多出整整一周', () => {
    for (let i = 0; i < 240; i++) {
      const ts = +new Date(2020, i, 1)
      const no = monthNo(ts)
      const start = monthWeekStart(no)
      const days = monthWeeks(no) * 7
      const end = new Date(start)
      end.setDate(end.getDate() + days - 1)
      // 头一天一定是周一，最后一天一定是周日
      expect(new Date(start).getDay()).toBe(1)
      expect(new Date(+end).getDay()).toBe(0)
      // 这个月整个落在里面
      const last = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth() + 1, 0)
      expect(start).toBeLessThanOrEqual(ts)
      expect(+end).toBeGreaterThanOrEqual(+last)
      // 少一周就装不下：多余的那一周去掉后，最后一天必须早于月末
      const shorter = new Date(start)
      shorter.setDate(shorter.getDate() + days - 8)
      expect(+shorter).toBeLessThan(+last)
    }
  })
})
