import { describe, expect, it } from 'vitest'
import { compareOrder } from '@kapibala/core/order'
import { pinCut, pinKey, pinRank } from '../src/pin.ts'

/** 某一天里按手排先后排好的一串：[id, order, 重要?]。主进程算落点时拿到的就是这个形状 */
type Peer = { id: string; order: string; important: boolean }
const peers = (...row: Array<[string, string, boolean?]>): Peer[] =>
  row.map(([id, order, important]) => ({ id, order, important: !!important }))

/**
 * 把某个 id 按算出来的 key 插进那一串，返回最终的先后（用界面同一个比较器排）。
 * front 的取值就是主进程那两种标记传的：标重要、以及本来就重要再标 Doing，都是 true。
 */
function place(row: Peer[], id: string, front: boolean): string[] {
  const { cut, key } = pinKey(row, front)
  // key 为 null 时调用方要整格重铺：正好就是"按 cut 插进去"
  return key === null
    ? [...row.slice(0, cut).map(x => x.id), id, ...row.slice(cut).map(x => x.id)]
    : [...row, { id, order: key, important: false }].sort(compareOrder).map(x => x.id)
}

describe('档位', () => {
  it('重要 + 进行中 > 重要 > 进行中 > 普通', () => {
    expect(pinRank({ important: true, inProgress: true })).toBe(0)
    expect(pinRank({ important: true, inProgress: false })).toBe(1)
    expect(pinRank({ important: false, inProgress: true })).toBe(2)
    expect(pinRank({ important: false, inProgress: false })).toBe(3)
  })
})

describe('标记之后落在哪', () => {
  // 重要任务不一定连着排在最上面：用户可以把手排的普通任务拖上去
  const day = peers(
    ['imp-1', 'V', true],
    ['normal-1', 'W'],
    ['imp-2', 'X', true],
    ['normal-2', 'Y'],
  )

  it('重要排到那一天最前面', () => {
    expect(place(day, 'new', true)).toEqual(['new', 'imp-1', 'normal-1', 'imp-2', 'normal-2'])
  })

  it('本来就重要、再标 Doing：顶到所有重要任务前面', () => {
    // 按"只是进行中"处理会落到最后一个重要任务（imp-2）后面 —— 那正是用户不要的
    expect(place(day, 'new', false)).toEqual(['imp-1', 'normal-1', 'imp-2', 'new', 'normal-2'])
    expect(place(day, 'new', true)).toEqual(['new', 'imp-1', 'normal-1', 'imp-2', 'normal-2'])
  })

  it('只是标 Doing：插在最后一个重要任务后面，其余任务照旧在它下面', () => {
    expect(pinCut(day, false)).toBe(3)
    expect(place(day, 'new', false)).toEqual(['imp-1', 'normal-1', 'imp-2', 'new', 'normal-2'])
  })

  it('那一天一条重要的都没有：怎么标都到最前面', () => {
    const plain = peers(['a', 'V'], ['b', 'W'], ['c', 'X'])
    expect(pinCut(plain, false)).toBe(0)
    expect(place(plain, 'new', false)).toEqual(['new', 'a', 'b', 'c'])
  })

  it('那一天是空的：插进去就是了', () => {
    expect(place([], 'new', true)).toEqual(['new'])
    expect(place([], 'new', false)).toEqual(['new'])
  })

  it('挤不出空位时给出 null，并按落点整格重铺（顺序不变，只多一条）', () => {
    // '…679' 是 '…6790' 去掉尾零的形式，两者之间一个空位都没有（见 core 的 order 测试）
    const tight = peers(
      ['imp', '000175612345679', true],
      ['normal', '0001756123456790'],
    )
    // 只是标 Doing 时要插在 imp 和 normal 之间 —— 那正好是挤满的位置
    const { cut, key } = pinKey(tight, false)
    expect(cut).toBe(1)
    expect(key).toBeNull()
    expect(place(tight, 'new', false)).toEqual(['imp', 'new', 'normal'])
  })
})
