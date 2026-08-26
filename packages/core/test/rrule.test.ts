import { describe, expect, it } from 'vitest'
import { describeRrule, formatRrule, nextAfter, parseRrule, presetsFor } from '../src/rrule.ts'
import { nextOccurrence, toRruleString } from '../src/repeat.ts'
import type { Task } from '../src/types.ts'

const at = (s: string) => +new Date(s)
const day = (ts: number | null) => (ts === null ? 'null' : new Date(ts).toString().slice(0, 15))

/** 从 anchor 开始连续取 n 次 */
function series(rrule: string, anchor: string, n: number): string[] {
  const rule = parseRrule(rrule)!
  const a = at(anchor)
  const out: string[] = []
  let cur = a
  for (let i = 0; i < n; i++) {
    const next = nextAfter(rule, a, cur)
    if (next === null) break
    out.push(day(next))
    cur = next
  }
  return out
}

describe('RRULE 解析', () => {
  it('解析 FREQ / INTERVAL / BYDAY / BYMONTHDAY / BYMONTH / UNTIL', () => {
    const r = parseRrule('FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU,-1FR;BYMONTHDAY=1,-1;BYMONTH=3;UNTIL=20270131')!
    expect(r.freq).toBe('MONTHLY')
    expect(r.interval).toBe(2)
    expect(r.byday).toEqual([{ ord: 2, day: 'TU' }, { ord: -1, day: 'FR' }])
    expect(r.bymonthday).toEqual([1, -1])
    expect(r.bymonth).toEqual([3])
    expect(new Date(r.until!).getDate()).toBe(31)
  })

  it('UNTIL 当天仍然有效，不能把最后一天排除掉', () => {
    const r = parseRrule('FREQ=DAILY;UNTIL=20260830')!
    expect(nextAfter(r, at('2026-08-28T09:00'), at('2026-08-29T09:00'))).toBe(at('2026-08-30T09:00'))
    expect(nextAfter(r, at('2026-08-28T09:00'), at('2026-08-30T09:00'))).toBeNull()
  })

  it('看不懂的规则返回 null，绝不猜', () => {
    expect(parseRrule('')).toBeNull()
    expect(parseRrule('FREQ=HOURLY')).toBeNull()
    expect(parseRrule('BYDAY=MO')).toBeNull()
  })

  it('parse → format 往返', () => {
    const src = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'
    expect(formatRrule(parseRrule(src)!)).toBe(src)
  })
})

describe('下一次是哪天', () => {
  it('每月第二个周二', () => {
    // 2026-08-11 是八月的第二个周二
    expect(series('FREQ=MONTHLY;BYDAY=2TU', '2026-08-11T09:00', 3))
      .toEqual(['Tue Sep 08 2026', 'Tue Oct 13 2026', 'Tue Nov 10 2026'])
  })

  it('每月最后一个周五', () => {
    expect(series('FREQ=MONTHLY;BYDAY=-1FR', '2026-08-28T09:00', 3))
      .toEqual(['Fri Sep 25 2026', 'Fri Oct 30 2026', 'Fri Nov 27 2026'])
  })

  it('仅工作日：周五的下一次是周一', () => {
    expect(series('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-08-28T09:00', 4))
      .toEqual(['Mon Aug 31 2026', 'Tue Sep 01 2026', 'Wed Sep 02 2026', 'Thu Sep 03 2026'])
  })

  it('每年', () => {
    expect(series('FREQ=YEARLY', '2026-08-26T09:00', 2))
      .toEqual(['Thu Aug 26 2027', 'Sat Aug 26 2028'])
  })

  it('每年 2 月 29 日：只落在闰年，中间的年份跳过', () => {
    expect(series('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2028-02-29T09:00', 2))
      .toEqual(['Sun Feb 29 2032', 'Fri Feb 29 2036'])
  })

  it('每月 31 日：没有 31 号的月份跳过，跟 RFC 一致', () => {
    expect(series('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T09:00', 3))
      .toEqual(['Tue Mar 31 2026', 'Sun May 31 2026', 'Fri Jul 31 2026'])
  })

  it('每月最后一天：会正确落在 28/29/30/31', () => {
    expect(series('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31T09:00', 3))
      .toEqual(['Sat Feb 28 2026', 'Tue Mar 31 2026', 'Thu Apr 30 2026'])
  })

  it('每 2 周的周一', () => {
    expect(series('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '2026-08-24T09:00', 3))
      .toEqual(['Mon Sep 07 2026', 'Mon Sep 21 2026', 'Mon Oct 05 2026'])
  })

  it('每 3 天', () => {
    expect(series('FREQ=DAILY;INTERVAL=3', '2026-08-26T09:00', 3))
      .toEqual(['Sat Aug 29 2026', 'Tue Sep 01 2026', 'Fri Sep 04 2026'])
  })

  it('时间部分保留不变', () => {
    const r = parseRrule('FREQ=WEEKLY')!
    const next = nextAfter(r, at('2026-08-26T19:30'), at('2026-08-26T19:30'))!
    expect(new Date(next).getHours()).toBe(19)
    expect(new Date(next).getMinutes()).toBe(30)
  })
})

describe('中文描述', () => {
  it.each([
    ['FREQ=DAILY', '每天'],
    ['FREQ=DAILY;INTERVAL=3', '每 3 天'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '工作日'],
    ['FREQ=WEEKLY;BYDAY=TU', '每周二'],
    ['FREQ=MONTHLY;BYDAY=2TU', '每月第二个周二'],
    ['FREQ=MONTHLY;BYDAY=-1FR', '每月最后一个周五'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', '每月最后一天'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', '每月15 日'],
    ['FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=26', '每年 8 月 26 日'],
  ])('%s → %s', (src, want) => {
    expect(describeRrule(src)).toBe(want)
  })
})

describe('英文描述', () => {
  it.each([
    ['FREQ=DAILY', 'Daily'],
    ['FREQ=DAILY;INTERVAL=3', 'Every 3 days'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Weekdays'],
    ['FREQ=WEEKLY;BYDAY=TU', 'Every Tuesday'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'Every 2 weeks on Monday'],
    ['FREQ=MONTHLY;BYDAY=2TU', 'Monthly on the 2nd Tuesday'],
    ['FREQ=MONTHLY;BYDAY=-1FR', 'Monthly on the last Friday'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'Monthly on the last day'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', 'Monthly on the 15th'],
    ['FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=26', 'Yearly on August 26'],
  ])('%s → %s', (src, want) => {
    expect(describeRrule(src, 'en')).toBe(want)
  })

  it('序数词的边界：11/12/13 是 th，21/22/23 才是 st/nd/rd', () => {
    const day = (n: number) => describeRrule(`FREQ=MONTHLY;BYMONTHDAY=${n}`, 'en')
    expect([1, 2, 3, 11, 12, 13, 21, 22, 23].map(day)).toEqual([
      'Monthly on the 1st', 'Monthly on the 2nd', 'Monthly on the 3rd',
      'Monthly on the 11th', 'Monthly on the 12th', 'Monthly on the 13th',
      'Monthly on the 21st', 'Monthly on the 22nd', 'Monthly on the 23rd',
    ])
  })

  it('看不懂的规则在英文里也不猜', () => {
    expect(describeRrule('FREQ=HOURLY', 'en')).toBe('Repeats')
  })

  it('默认还是中文 —— CLI 和旧调用点没传语言', () => {
    expect(describeRrule('FREQ=MONTHLY;BYDAY=2TU')).toBe('每月第二个周二')
  })
})

describe('界面预设', () => {
  it('从一个具体日期推出六个预设', () => {
    // 2026-08-11 是八月第二个周二
    const opts = presetsFor(at('2026-08-11T09:00'))
    expect(opts.map(o => o.label)).toEqual([
      '每天', '每周周二', '工作日（周一至周五）', '每月 11 日', '每月第二个周二', '每年 8 月 11 日',
    ])
    expect(opts[4]!.rrule).toBe('FREQ=MONTHLY;BYDAY=2TU')
  })

  it('英文预设：规则一模一样，只有 label 换语言', () => {
    const at = +new Date('2026-08-11T09:00')
    const zh = presetsFor(at)
    const en = presetsFor(at, 'en')
    expect(en.map(o => o.rrule)).toEqual(zh.map(o => o.rrule))
    expect(en.map(o => o.label)).toEqual([
      'Daily', 'Weekly on Tuesday', 'Weekdays (Mon–Fri)', 'Monthly on the 11th',
      'Monthly on the 2nd Tuesday', 'Yearly on August 11',
    ])
  })
})

describe('向后兼容 0.0.x 的形状', () => {
  it('{freq, interval} 仍然读得懂', () => {
    expect(toRruleString({ freq: 'WEEKLY', interval: 2 })).toBe('FREQ=WEEKLY;INTERVAL=2')
    expect(toRruleString({ freq: 'MONTHLY' })).toBe('FREQ=MONTHLY')
    expect(toRruleString({ rrule: 'FREQ=MONTHLY;BYDAY=2TU' })).toBe('FREQ=MONTHLY;BYDAY=2TU')
  })

  it('旧数据完成后照样生成下一个实例', () => {
    const t: Task = {
      id: 'T', title: '旧任务', isAllDay: false, reminders: [], order: '', createdAt: 0,
      deleted: false, startAt: at('2026-08-26T09:00'), repeat: { freq: 'WEEKLY' },
    }
    const next = nextOccurrence(t, at('2026-08-26T10:00'))!
    expect(day(next.startAt)).toBe('Wed Sep 02 2026')
  })
})

describe('周期实例的生成', () => {
  const base = (repeat: Task['repeat'], startAt: string): Task => ({
    id: 'T', title: '吃药', isAllDay: false, reminders: [], order: '', createdAt: 0,
    deleted: false, startAt: at(startAt), repeat,
  })

  it('固定周期会跳过已经过去的那些，不补历史', () => {
    const t = base({ rrule: 'FREQ=WEEKLY;BYDAY=WE' }, '2026-08-26T09:00')
    const next = nextOccurrence(t, at('2026-09-20T10:00'))!   // 拖了三周半才完成
    expect(day(next.startAt)).toBe('Wed Sep 23 2026')
  })

  it('UNTIL 到了就没有下一次了', () => {
    const t = base({ rrule: 'FREQ=DAILY;UNTIL=20260827' }, '2026-08-26T09:00')
    expect(nextOccurrence(t, at('2026-08-27T10:00'))).toBeNull()
  })

  it('两台机器各自完成同一次，实例 ID 相同（不会分叉）', () => {
    const t = base({ rrule: 'FREQ=MONTHLY;BYDAY=2TU' }, '2026-08-11T09:00')
    const a = nextOccurrence(t, at('2026-08-11T20:00'))!
    const b = nextOccurrence(t, at('2026-08-11T21:30'))!
    expect(a.id).toBe(b.id)
    expect(a.startAt).toBe(b.startAt)
  })

  it('afterCompletion 模式从完成那天推，且按天取整', () => {
    const t = base({ rrule: 'FREQ=DAILY;INTERVAL=3', mode: 'afterCompletion' }, '2026-08-26T09:00')
    const a = nextOccurrence(t, at('2026-09-10T08:00'))!
    const b = nextOccurrence(t, at('2026-09-10T23:00'))!
    expect(day(a.startAt)).toBe('Sun Sep 13 2026')
    expect(a.id).toBe(b.id)                       // 同一天内多次完成不分叉
  })
})
