import { describe, expect, it } from 'vitest'
import { HlcClock, cmpHlc, parseHlc } from '../src/hlc.ts'
import { MemClock } from '../src/testing.ts'

describe('HLC', () => {
  it('同一毫秒内递增计数器，字典序 = 时间序', () => {
    const clock = { now: () => 1000 }
    const c = new HlcClock(clock, 'DEV-A')
    const a = c.tick(), b = c.tick(), d = c.tick()
    expect(cmpHlc(a, b)).toBe(-1)
    expect(cmpHlc(b, d)).toBe(-1)
    expect(parseHlc(a).counter).toBe(0)
    expect(parseHlc(b).counter).toBe(1)
  })

  it('observe 之后本机的新 op 一定大于观察到的远端 op', () => {
    const c = new HlcClock(new MemClock(1000), 'DEV-A')
    const remote = '0000000000009999:0007:DEV-B'
    c.observe(remote)
    expect(cmpHlc(c.tick(), remote)).toBe(1)
  })

  it('系统时钟回拨后，新改动仍然胜过旧改动', () => {
    const clock = new MemClock(1_000_000)
    const c = new HlcClock(clock, 'DEV-A')
    const before = c.tick()
    clock.set(500_000)              // 用户把时间往后调了
    const after = c.tick()
    expect(cmpHlc(after, before)).toBe(1)
  })

  it('设备 ID 做最终 tiebreaker，不存在平票', () => {
    const a = new HlcClock({ now: () => 1000 }, 'DEV-A').tick()
    const b = new HlcClock({ now: () => 1000 }, 'DEV-B').tick()
    expect(cmpHlc(a, b)).not.toBe(0)
  })
})
