import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWhen } from '../src/dates.ts'

/**
 * 把"现在"钉死在 2026-10-07（周三）12:00。
 * parseWhen 自己读 Date.now()（不像 core 的 parseWhenIn 可以把 now 传进去），
 * 所以这里只能用假时钟 —— 不然期望值会跟着跑测试的那天变，周三跑绿、周四跑红。
 */
const NOW = new Date(2026, 9, 7, 12, 0, 0)
const local = (iso: string, h = 0, m = 0) => {
  const [y, mo, d] = iso.split('-').map(Number)
  return +new Date(y!, mo! - 1, d!, h, m)
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

function expectDay(text: string, iso: string) {
  const hit = parseWhen(text)
  expect(hit, text).not.toBeNull()
  expect(new Date(hit!.at), text).toEqual(new Date(local(iso)))
  expect(hit!.allDay, text).toBe(true)
}

function expectTime(text: string, iso: string, h: number, m: number) {
  const hit = parseWhen(text)
  expect(hit, text).not.toBeNull()
  expect(new Date(hit!.at), text).toEqual(new Date(local(iso, h, m)))
  expect(hit!.allDay, text).toBe(false)
}

describe('parseWhen 认得的写法', () => {
  it('今天 / 明天', () => {
    expectDay('today', '2026-10-07')
    expectDay('今天', '2026-10-07')
    expectDay('tomorrow', '2026-10-08')
    expectDay('明天', '2026-10-08')
  })

  it('相对天数 / 周数：+3d、+2w', () => {
    expectDay('+3d', '2026-10-10')
    expectDay('+2w', '2026-10-21')
  })

  it('具体日期，带时间就不是全天', () => {
    expectDay('2026-08-28', '2026-08-28')          // 过去的日子照收
    expectTime('2026-08-28T19:30', '2026-08-28', 19, 30)
    expectTime('2026-08-28 19:30', '2026-08-28', 19, 30)
  })

  it('只给时间就是今天那个点', () => {
    expectTime('19:30', '2026-10-07', 19, 30)
    expectTime('7:30', '2026-10-07', 7, 30)
  })

  it('大小写不敏感', () => {
    expectDay('FRI', '2026-10-09')
  })
})

describe('星期取最近的那一次（和界面 when.ts 同口径）', () => {
  it('今天之后的那几天都在本周内', () => {
    // 回归：这里曾经少一个 % 7，周三说 fri 会被推到 10-16（下周五），
    // 而同样的写法 sun/mon/tue 却是最近的那天 —— 同一个命令两套口径
    expectDay('thu', '2026-10-08')
    expectDay('fri', '2026-10-09')
    expectDay('sat', '2026-10-10')
    expectDay('周四', '2026-10-08')
    expectDay('周五', '2026-10-09')
    expectDay('周六', '2026-10-10')
  })

  it('本周已经过去的那几天落在下周，不是今天之前', () => {
    expectDay('sun', '2026-10-11')
    expectDay('mon', '2026-10-12')
    expectDay('tue', '2026-10-13')
    expectDay('周日', '2026-10-11')
    expectDay('周一', '2026-10-12')
    expectDay('周二', '2026-10-13')
  })

  it('今天就是那天：算下一周，不是今天', () => {
    expectDay('wed', '2026-10-14')
    expectDay('周三', '2026-10-14')
  })

  it('给的是全天，不带上一个时刻', () => {
    expect(parseWhen('周五')!.allDay).toBe(true)
  })
})

describe('看不懂的返回 null', () => {
  it('空串、自然语言、单位数的日期都不认', () => {
    // 界面那套自然语言（下周三、3天后）不归 CLI 管，--at 只认上面列的那几种
    for (const s of ['', '   ', '下周三', '3天后', '2026-8-28', '瞎写'])
      expect(parseWhen(s), s).toBeNull()
  })
})
