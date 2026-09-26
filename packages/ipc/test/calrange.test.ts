import { describe, expect, it } from 'vitest'
import { CUSTOM_CAL_MAX_DAYS, LEGACY_SLOT_KEYS, calRangeDays, clampCalRange, isWinSlot, normCalRange,
         readCalRange, viewSlot } from '../src/index.ts'

const DAY = 86_400_000
const day = (s: string) => +new Date(`${s}T00:00`)

describe('normCalRange：界面发上来的一段范围', () => {
  it('两天的零点原样接受', () => {
    expect(normCalRange({ from: day('2026-09-01'), to: day('2026-09-14') }))
      .toEqual({ from: day('2026-09-01'), to: day('2026-09-14') })
  })

  it('倒着存的也认，排好序再给', () => {
    expect(normCalRange({ from: day('2026-09-14'), to: day('2026-09-01') }))
      .toEqual({ from: day('2026-09-01'), to: day('2026-09-14') })
  })

  it('带时分秒的一律归到当天零点', () => {
    const from = day('2026-09-01') + 13 * 3600_000 + 45_000
    expect(normCalRange({ from, to: from })).toEqual({ from: day('2026-09-01'), to: day('2026-09-01') })
  })

  it('同一天是合法的（1 天）', () => {
    const d = day('2026-09-01')
    expect(normCalRange({ from: d, to: d })).toEqual({ from: d, to: d })
  })

  it('形状不对的给 null', () => {
    for (const bad of [null, undefined, 0, 'x', [], {}, { from: 1 }, { from: 'a', to: 'b' },
                       { from: NaN, to: 1 }, { from: Infinity, to: 1 }]) {
      expect(normCalRange(bad), JSON.stringify(bad) ?? String(bad)).toBeNull()
    }
  })

  it('超 36 天**夹到 36 天**，不是拒绝（拖选来回过界是过程，不是错误）', () => {
    expect(normCalRange({ from: day('2026-09-01'), to: day('2026-10-20') }))
      .toEqual({ from: day('2026-09-01'), to: day('2026-10-06') })
    // 正好 36 天要原样认：从 9/1 起数 36 天是 10/6
    expect(normCalRange({ from: day('2026-09-01'), to: day('2026-10-06') }))
      .toEqual({ from: day('2026-09-01'), to: day('2026-10-06') })
  })
})

describe('readCalRange：ui.json 里躺着的一段范围', () => {
  it('正常范围照收', () => {
    expect(readCalRange({ from: day('2026-09-01'), to: day('2026-09-14') }))
      .toEqual({ from: day('2026-09-01'), to: day('2026-09-14') })
  })

  it('超过 36 天的当没选过 —— 那不是拖出来的，是盘上的怪值', () => {
    expect(readCalRange({ from: day('2026-09-01'), to: day('2026-10-20') })).toBeNull()
    // 正好 36 天还是认
    expect(readCalRange({ from: day('2026-09-01'), to: day('2026-10-06') }))
      .toEqual({ from: day('2026-09-01'), to: day('2026-10-06') })
  })

  it('形状不对的也是没选过', () => {
    for (const bad of [null, 'x', {}, { from: 1, to: 'a' }]) expect(readCalRange(bad)).toBeNull()
  })
})

describe('clampCalRange：拖过头时砍到 36 天', () => {
  it('没超就原样返回', () => {
    const r = { from: day('2026-09-01'), to: day('2026-09-10') }
    expect(clampCalRange(r)).toEqual(r)
  })

  it('超了砍尾巴，起点不动', () => {
    const got = clampCalRange({ from: day('2026-09-01'), to: day('2026-12-31') })
    expect(got.from).toBe(day('2026-09-01'))
    expect(got.to).toBe(day('2026-10-06'))
    expect(calRangeDays(got)).toBe(CUSTOM_CAL_MAX_DAYS)
  })

  it('跨月、跨年的边界都对得上', () => {
    expect(clampCalRange({ from: day('2026-12-20'), to: day('2027-03-01') }).to).toBe(day('2027-01-24'))
  })

  it('天数按日历算，不按毫秒除 —— 跨夏令时那天也不差一天', () => {
    // 美国 2026 年 11 月 1 日切冬令时：那两天之间只有 25 小时
    expect(calRangeDays({ from: day('2026-10-31'), to: day('2026-11-02') })).toBe(3)
    // 这段正好压着切换点，按毫秒除会算成 2 天
    expect(calRangeDays({ from: day('2026-10-01'), to: day('2026-11-05') })).toBe(36)
  })
})

describe('视图 → 窗口大小分组', () => {
  it('三个日历视图共用 calendar 一份，其余共用一个 other', () => {
    expect(viewSlot('calendar7')).toBe('calendar')
    expect(viewSlot('calendar14')).toBe('calendar')
    expect(viewSlot('calendarCustom')).toBe('calendar')
    expect(viewSlot('today')).toBe('other')
    expect(viewSlot('all')).toBe('other')
  })

  it('认得出的分组就那两个，别的挡在外面', () => {
    for (const s of ['other', 'calendar']) expect(isWinSlot(s)).toBe(true)
    // 分家时代的旧名字不再当合法分组用（读旧偏好走 LEGACY_SLOT_KEYS，不是走这里）
    for (const s of ['calendar7', 'calendar14', 'calendarCustom', 'calendarcustom', '', null, 0]) {
      expect(isWinSlot(s)).toBe(false)
    }
  })

  it('合并之后要给主进程一张旧键对照表，老用户的设置才不会丢', () => {
    expect(LEGACY_SLOT_KEYS.calendar).toEqual(['calendar7', 'calendar14'])
    // 'other' 没有改过名字，不该有旧键
    expect(LEGACY_SLOT_KEYS.other).toBeUndefined()
  })
})
