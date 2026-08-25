import { describe, expect, it } from 'vitest'
import { derivedId, ulid } from '../src/ids.ts'
import { MemClock, MemRandom } from '../src/testing.ts'

describe('确定性实例 ID', () => {
  it('同一系列同一天算出同一个 ID（两台 Mac 不会各生成一个实例）', () => {
    expect(derivedId('S1', '2026-09-01')).toBe(derivedId('S1', '2026-09-01'))
  })
  it('不同的天、不同的系列 → 不同的 ID', () => {
    const ids = new Set([derivedId('S1', '2026-09-01'), derivedId('S1', '2026-09-08'), derivedId('S2', '2026-09-01')])
    expect(ids.size).toBe(3)
  })
  it('26 个字符全部来自哈希 —— 用 sha1 只有 20 字节，尾部会全是 0，短 id 就会撞', () => {
    for (const id of [derivedId('S1', '2026-09-01'), derivedId('S9', '2027-01-31')]) {
      expect(id).toHaveLength(26)
      expect(id.slice(-6)).not.toBe('000000')
    }
  })
})

describe('ULID', () => {
  it('26 个字符，字典序 = 时间序', () => {
    const clock = new MemClock(1_000_000), random = new MemRandom(7)
    const a = ulid(clock, random), b = ulid(clock, random)
    expect(a).toHaveLength(26)
    expect(a < b).toBe(true)
  })
  it('同一毫秒内也不重复', () => {
    const clock = { now: () => 1_700_000_000_000 }, random = new MemRandom(3)
    const ids = new Set(Array.from({ length: 200 }, () => ulid(clock, random)))
    expect(ids.size).toBe(200)
  })
})
