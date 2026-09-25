import { describe, expect, it } from 'vitest'
import { compareOrder, isValidOrder, orderBetween, orderKey, spreadOrders } from '../src/order.ts'

/** 确定性随机，测试可复现 */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Row = { id: string; order: string }

/**
 * 界面里"拖到第 at 个位置"做的全部事情：算中间 key，算不出来就整格重排。
 * 返回这一步是否走了重排（用来确认那条兜底路径真的被测到了）。
 */
function place(row: Row[], from: number, at: number): boolean {
  const [moved] = row.splice(from, 1)
  row.splice(at, 0, moved!)
  const key = orderBetween(row[at - 1]?.order ?? null, row[at + 1]?.order ?? null)
  if (key === null) {
    for (const s of spreadOrders(row.map(r => r.id))) row.find(r => r.id === s.id)!.order = s.key
    return true
  }
  moved!.order = key
  return false
}

const ids = (row: Row[]) => [...row].sort(compareOrder).map(r => r.id)

describe('分数索引 order', () => {
  it('空集合、最前、最后、中间', () => {
    const only = orderBetween(null, null)!
    expect(isValidOrder(only)).toBe(true)

    const head = orderBetween(null, only)!
    expect(head < only).toBe(true)

    const tail = orderBetween(only, null)!
    expect(tail > only).toBe(true)

    const mid = orderBetween(head, tail)!
    expect(head < mid && mid < tail).toBe(true)
  })

  it('产出的 key 永远合法，且严格落在两个邻居之间', () => {
    const rnd = mulberry32(7)
    let row: Row[] = []
    for (let i = 0; i < 400; i++) {
      const at = Math.floor(rnd() * (row.length + 1))
      const key = orderBetween(row[at - 1]?.order ?? null, row[at]?.order ?? null)!
      expect(key).not.toBeNull()
      expect(isValidOrder(key)).toBe(true)
      expect(row[at - 1] === undefined || row[at - 1]!.order < key).toBe(true)
      expect(row[at] === undefined || key < row[at]!.order).toBe(true)
      row = [...row.slice(0, at), { id: `t${i}`, order: key }, ...row.slice(at)]
    }
  })

  it('反复往最前面插，key 长度是线性的、不会炸', () => {
    const keys: string[] = []
    let first: string | null = null
    for (let i = 0; i < 500; i++) {
      first = orderBetween(null, first)
      keys.push(first!)
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i]! < keys[i - 1]!).toBe(true)
    // 每插一条最多长一位。真炸了（比如某处重复拼前缀）这里会立刻发现
    expect(Math.max(...keys.map(k => k.length))).toBeLessThanOrEqual(keys.length)
  })

  it('随机拖动 3000 次，每次都落在期望的那一格', () => {
    const rnd = mulberry32(42)
    const row: Row[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, order: orderKey(1000 + i) }))
    for (let step = 0; step < 3000; step++) {
      place(row, Math.floor(rnd() * row.length), Math.floor(rnd() * row.length))
      expect(ids(row)).toEqual(row.map(r => r.id))
    }
  })

  it('一格里只有两条来回拖 3000 次也不会退化', () => {
    const row: Row[] = [
      { id: 'a', order: orderBetween(null, null)! },
      { id: 'b', order: orderBetween(null, null)! },
    ]
    row.sort(compareOrder)
    for (let step = 0; step < 3000; step++) {
      place(row, 0, 1)
      expect(ids(row)).toEqual(row.map(r => r.id))
      place(row, 1, 0)
      expect(ids(row)).toEqual(row.map(r => r.id))
    }
    // 相邻两位之间反复二分，key 会慢慢变长，但不该长到离谱
    expect(Math.max(...row.map(r => r.order.length))).toBeLessThan(200)
  })

  it('邻居 order 相同（两台机器同时往同一处拖）不抛错', () => {
    const same = orderBetween(null, null)!
    const key = orderBetween(same, same)!
    expect(isValidOrder(key)).toBe(true)
    expect(key > same).toBe(true)
  })

  it('空串（老数据没写过 order）当成没有下界', () => {
    expect(orderBetween('', '')).toBe(orderBetween(null, null))
    expect(orderBetween('V', '')).toBe(orderBetween('V', null))
  })

  it('compareOrder 用 id 兜底', () => {
    expect(compareOrder({ id: 'b', order: 'V' }, { id: 'a', order: 'V' })).toBeGreaterThan(0)
    expect(compareOrder({ id: 'a', order: 'V' }, { id: 'a', order: 'V' })).toBe(0)
    expect(compareOrder({ id: 'z', order: 'F' }, { id: 'a', order: 'V' })).toBeLessThan(0)
  })
})

describe('和 0.0.x 的 16 位数字 key 混排', () => {
  const legacy = ['0001756123456789', '0001756123456790', '0001756123456791']

  it('老 key 本身不满足"不以零位结尾"，但照样能算出中间的 key', () => {
    // …789 和 …790 差在倒数第二位，中间还有空位
    const mid = orderBetween(legacy[0]!, legacy[1]!)
    expect(mid).not.toBeNull()
    expect(isValidOrder(mid!)).toBe(true)
    expect(legacy[0]! < mid! && mid! < legacy[1]!).toBe(true)

    const head = orderBetween(null, legacy[0]!)!
    expect(head < legacy[0]!).toBe(true)

    const tail = orderBetween(legacy[2]!, null)!
    expect(tail > legacy[2]!).toBe(true)
  })

  it('两邻居之间真的没有空位时返回 null，而不是抛错', () => {
    // 这正是"挤满了"的形状：b 是 a 后面接了一个零位。
    // 手排 key '…679' 会正好落在两个挨着的老 key 中间，下一次再往里插就撞上
    const a = '000175612345679'
    const b = '0001756123456790'
    expect(isValidOrder(a)).toBe(true)
    expect(orderBetween(a, b)).toBeNull()
  })

  it('重排之后，那一格的 key 全部合法且顺序不变', () => {
    const idsIn = ['x', 'y', 'z']
    const spread = spreadOrders(idsIn)
    expect(spread.map(s => s.id)).toEqual(idsIn)
    for (const s of spread) expect(isValidOrder(s.key)).toBe(true)
    for (let i = 1; i < spread.length; i++) expect(spread[i]!.key > spread[i - 1]!.key).toBe(true)
  })

  it('老库上随机拖动，落点仍然准确', () => {
    const rnd = mulberry32(99)
    // 挨得极近的一排老 key：相差 1 毫秒的 16 位时间戳
    const row: Row[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      order: '000' + String(1756123456789 + i),
    }))
    row.sort(compareOrder)
    for (let step = 0; step < 2000; step++)
      place(row, Math.floor(rnd() * row.length), Math.floor(rnd() * row.length))
    expect(ids(row)).toEqual(row.map(r => r.id))
  })

  it('那一格挤满时整格重排，不抛错也不丢顺序', () => {
    // '…679' 就是 '…6790' 去掉尾零的形式，两者之间一个空位都没有
    const row: Row[] = [
      { id: 'a', order: '0001756123456790' },
      { id: 'b', order: '0001756123456791' },
      { id: 'prefix', order: '000175612345679' },
    ]
    row.sort(compareOrder)
    expect(row.map(r => r.id)).toEqual(['prefix', 'a', 'b'])
    // 把 b 拖到 prefix 和 a 中间：这一步只能靠整格重排
    expect(place(row, 2, 1)).toBe(true)
    expect(row.map(r => r.id)).toEqual(['prefix', 'b', 'a'])
    expect(ids(row)).toEqual(row.map(r => r.id))
    for (const r of row) expect(isValidOrder(r.order)).toBe(true)
  })
})

describe('新任务的 orderKey', () => {
  it('排在不以 z 开头的 key 之后，并且自己还能往前面插', () => {
    const k = orderKey(1_760_000_000_000)
    expect(isValidOrder(k)).toBe(true)
    // 'z' 是字母表里最大的位：任何不以 'z' 打头的 key 都排在它前面
    for (const other of [orderBetween(null, null)!, 'V', 'x', '0001756123456789'])
      expect(k > other).toBe(true)
    expect(orderBetween(null, k)! < k).toBe(true)
  })

  it('时间戳以 0 结尾也仍然合法（末尾补了非零位）', () => {
    const k = orderKey(1_760_000_000_000)     // 尾数是 0
    expect(k.endsWith('0')).toBe(false)
    expect(isValidOrder(k)).toBe(true)
  })

  it('同一毫秒里连建两条也不撞', () => {
    expect(orderKey(2) > orderKey(1)).toBe(true)
  })
})

describe('spreadOrders', () => {
  it('空列表不产出任何东西', () => {
    expect(spreadOrders([])).toEqual([])
  })

  it('重排后还能继续往中间插', () => {
    const spread = spreadOrders(['a', 'b', 'c'])
    const mid = orderBetween(spread[0]!.key, spread[1]!.key)
    expect(mid).not.toBeNull()
    expect(spread[0]!.key < mid! && mid! < spread[1]!.key).toBe(true)
  })
})
