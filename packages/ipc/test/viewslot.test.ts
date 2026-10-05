import { describe, expect, it } from 'vitest'
import { LEGACY_SLOT_KEYS, LEGACY_VIEW_IDS, MONTH_CAL_COLS, isViewId, isWinSlot, normMonthCalCols,
         restorableView, viewSlot } from '../src/index.ts'

describe('视图 → 窗口大小分组', () => {
  it('三个日历视图共用 calendar 一份，其余共用一个 other', () => {
    expect(viewSlot('calendar7')).toBe('calendar')
    expect(viewSlot('calendar14')).toBe('calendar')
    expect(viewSlot('calendarFlow')).toBe('calendar')
    expect(viewSlot('today')).toBe('other')
    expect(viewSlot('all')).toBe('other')
  })

  it('认得出的分组就那两个，别的挡在外面', () => {
    for (const s of ['other', 'calendar']) expect(isWinSlot(s)).toBe(true)
    // 分家时代的旧名字不再当合法分组用（读旧偏好走 LEGACY_SLOT_KEYS，不是走这里）
    for (const s of ['calendar7', 'calendar14', 'calendarFlow', '', null, 0]) {
      expect(isWinSlot(s)).toBe(false)
    }
  })

  it('合并之后要给主进程一张旧键对照表，老用户的设置才不会丢', () => {
    expect(LEGACY_SLOT_KEYS.calendar).toEqual(['calendar7', 'calendar14'])
    // 'other' 没有改过名字，不该有旧键
    expect(LEGACY_SLOT_KEYS.other).toBeUndefined()
  })
})

describe('restorableView：ui.json 里躺着的视图 id', () => {
  it('认得的原样返回', () => {
    for (const v of ['today', 'next7', 'next30', 'calendar7', 'calendar14', 'calendarFlow', 'all']) {
      expect(restorableView(v)).toBe(v)
    }
  })

  it('撤掉的视图都折算到接替它的那一屏 —— 不能当成没存过，那样下次打开会莫名跳回今天', () => {
    // 自定义日历：整屏撤了，诉求并进连续日历
    expect(LEGACY_VIEW_IDS['calendarCustom']).toBe('calendarFlow')
    expect(restorableView('calendarCustom')).toBe('calendarFlow')
    // 连续日历自己的上一个名字（当时叫"一月一块的真月历"），老 ui.json 里存的就是它
    expect(LEGACY_VIEW_IDS['calendarMonth']).toBe('calendarFlow')
    expect(restorableView('calendarMonth')).toBe('calendarFlow')
    // 新的那个 id 本身当然是合法的（别把"改名"写成"两边都认不出来"）
    expect(restorableView('calendarFlow')).toBe('calendarFlow')
  })

  it('已完成 / 垃圾桶不记（那里只是顺路看一眼），严格来说不是"存过"', () => {
    for (const v of ['done', 'trash']) {
      expect(isViewId(v)).toBe(true)
      expect(restorableView(v)).toBeNull()
    }
  })

  it('看不懂的一律当没存过', () => {
    for (const bad of ['', 'calendarmonth', 'CALENDARMONTH', null, undefined, 0, {}, []]) {
      expect(restorableView(bad), JSON.stringify(bad) ?? String(bad)).toBeNull()
    }
  })
})

describe('月历每行几列', () => {
  it('3~7 都认，默认 5', () => {
    expect(MONTH_CAL_COLS).toEqual({ min: 3, max: 7, def: 5 })
    for (let n = 3; n <= 7; n++) expect(normMonthCalCols(n)).toBe(n)
  })

  it('越界、手改过的、旧版本写的一律回默认 5，不抛错', () => {
    for (const bad of [2, 8, 0, -5, 1e9, NaN, Infinity, null, undefined, {}, [], 'x']) {
      expect(normMonthCalCols(bad), String(bad)).toBe(5)
    }
  })

  it('小数和数字字符串照收（ui.json 是手写也不奇怪的纯文本）', () => {
    expect(normMonthCalCols(4.0)).toBe(4)
    expect(normMonthCalCols('6')).toBe(6)
    // 4.6 这种是"写歪了"，取整到 5 而不是当越界
    expect(normMonthCalCols(4.6)).toBe(5)
  })
})
