import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { replay, flatten } from '../src/state.ts'
import { dehydrate, rehydrate } from '../src/log.ts'
import { formatHlc } from '../src/hlc.ts'
import type { Op } from '../src/types.ts'

const arbOp = (devices: string[]) => fc.record({
  v: fc.constant(1 as const),
  physical: fc.integer({ min: 1, max: 50 }),
  counter: fc.integer({ min: 0, max: 3 }),
  dev: fc.constantFrom(...devices),
  e: fc.constantFrom('task', 'list', '未来版本的类型'),
  id: fc.constantFrom('t1', 't2', 't3'),
  f: fc.constantFrom('title', 'startAt', '_deleted', '未来版本的字段'),
  val: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
}).map(({ physical, counter, dev, ...rest }): Op => ({ ...rest, hlc: formatHlc(physical, counter, dev) }))

const arbLog = (devices: string[]) => fc.array(arbOp(devices), { maxLength: 60 })
const norm = (s: object) => JSON.parse(JSON.stringify(s))

describe('收敛性', () => {
  it('任意打乱重放，结果完全相同', () => {
    fc.assert(fc.property(arbLog(['DEV-A', 'DEV-B', 'DEV-C']), (ops) => {
      const a = replay(ops)
      const b = replay([...ops].reverse())
      const c = replay([...ops].sort((x, y) => x.id.localeCompare(y.id)))
      expect(norm(b)).toEqual(norm(a))
      expect(norm(c)).toEqual(norm(a))
    }), { numRuns: 300 })
  })

  it('两台机器各自重放各自的顺序，结果一致', () => {
    fc.assert(fc.property(arbLog(['DEV-A']), arbLog(['DEV-B']), (a, b) => {
      expect(norm(replay([...a, ...b]))).toEqual(norm(replay([...b, ...a])))
    }), { numRuns: 300 })
  })
})

describe('压实等价性', () => {
  it('merge(A全量, B) === merge(snapshot(A), B)，且 hlc 的设备段被正确还原', () => {
    fc.assert(fc.property(arbLog(['DEV-A']), arbLog(['DEV-B']), (a, b) => {
      const full = replay([...a, ...b])
      const snap = dehydrate('DEV-A', replay(a), 1, '')
      const viaSnapshot = replay([...rehydrate(snap), ...b])
      expect(norm(viaSnapshot)).toEqual(norm(full))
    }), { numRuns: 300 })
  })

  it('snapshot 保留不认识的字段和 entity 类型', () => {
    const ops: Op[] = [
      { v: 1, hlc: formatHlc(1, 0, 'DEV-A'), e: '未来的实体', id: 'x', f: '未来的字段', val: { deep: [1, 2] } },
    ]
    const round = replay(rehydrate(dehydrate('DEV-A', replay(ops), 1, '')))
    expect(round['未来的实体']!['x']!['未来的字段']!.val).toEqual({ deep: [1, 2] })
  })

  it('flatten(replay(ops)) 是幂等的', () => {
    fc.assert(fc.property(arbLog(['DEV-A', 'DEV-B']), (ops) => {
      const once = replay(ops)
      expect(norm(replay(flatten(once)))).toEqual(norm(once))
    }), { numRuns: 200 })
  })
})

describe('畸形输入下的收敛性', () => {
  it('HLC 相同但值不同（日志被损坏或重复写入）时，重放顺序仍然不影响结果', () => {
    const hlc = formatHlc(5, 0, 'DEV-A')
    const a: Op = { v: 1, hlc, e: 'task', id: 't1', f: 'title', val: '甲' }
    const b: Op = { v: 1, hlc, e: 'task', id: 't1', f: 'title', val: '乙' }
    expect(norm(replay([a, b]))).toEqual(norm(replay([b, a])))
  })
})
