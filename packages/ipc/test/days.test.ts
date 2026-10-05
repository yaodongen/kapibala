import { describe, expect, it } from 'vitest'
import { addDays } from '../src/index.ts'

const day = (s: string) => +new Date(`${s}T00:00`)

/**
 * 连续日历往前/往后接日子全靠它，所以单独盯着。
 * **别改成"加 n × 86400000"**：跨夏令时切换那天两个零点差 23 或 25 小时，
 * 那么加会落到前一天 23 点或后一天 1 点 —— 接出来的日子会带上时分秒，
 * 按天分桶就全错位了。
 */
describe('addDays：日期加减不碰毫秒', () => {
  it('往后 / 往前都对，跨月跨年也对', () => {
    expect(addDays(day('2026-08-31'), 1)).toBe(day('2026-09-01'))
    expect(addDays(day('2026-01-01'), -1)).toBe(day('2025-12-31'))
    expect(addDays(day('2028-02-28'), 1)).toBe(day('2028-02-29'))
    expect(addDays(day('2026-03-01'), -1)).toBe(day('2026-02-28'))
  })

  it('带时分秒的先进到当天零点再加', () => {
    expect(addDays(day('2026-08-01') + 13 * 3600_000, 1)).toBe(day('2026-08-02'))
    expect(addDays(day('2026-08-01') + 23 * 3600_000 + 59_000, 0)).toBe(day('2026-08-01'))
  })

  it('接一大段也一步不差：往前 5 年再往后 5 年回到原地', () => {
    const t0 = day('2026-10-05')
    const back = addDays(t0, -366 * 5)
    expect(addDays(back, 366 * 5)).toBe(t0)
    // 一天一天数回去，和一次减 100 天是同一个落点
    let slow = t0
    for (let i = 0; i < 100; i++) slow = addDays(slow, -1)
    expect(slow).toBe(addDays(t0, -100))
  })
})
