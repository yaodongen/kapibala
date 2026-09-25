/**
 * 拖拽排序用的字符串分数索引（fractional indexing，也就是通常说的 LexoRank）。
 * 见 docs/storage.zh.md §7.3：`order` 是字符串，**字典序就是显示顺序**。
 *
 * 为什么不是整数：插入时要重编号一片任务 → 一次拖拽几十条 op，而且两台机器同时
 * 拖拽会得到交错的混乱结果。在中间插一个键只写一条 op，并发插入也只在极端情况下
 * 撞成相同的值（那时用 id 兜底，见下面的 compareOrder）。
 *
 * 字母表按 ASCII 码顺序排，这是整套算法成立的前提：只有"字符在字母表里的下标"和
 * "字符的 ASCII 码"同序，按字符串比较才等于按它表示的那个分数比较。数字在 ASCII 里
 * 本来就排在字母前面，所以 0.0.x 留下的 16 位纯数字 key 和新 key 可以直接混着比。
 *
 * **不变量：本模块产出的 key 非空、不以零位结尾。** 这条不能省 —— 一个以零位结尾的
 * key 和它自己去掉尾零的形式表示同一个分数，两者之间再也塞不进任何字符串。
 * 但 0.0.x 的老 key（16 位零填充时间戳）**不满足**这条，而且成对出现时（`…789` 和
 * `…790`）中间确实可能没有空位。这种情况不抛错，`orderBetween` 返回 null 让调用方
 * 去把那一格重排（见 app.ts 的 spread）。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ZERO = DIGITS[0]!
/** 中间那个位。空集合里第一条任务就拿它 */
const MID = DIGITS[Math.floor(DIGITS.length / 2)]!

/** 每个字符都在字母表里。老 key 是纯数字，也在里面 */
function inAlphabet(s: string): boolean { return [...s].every(c => DIGITS.includes(c)) }

/** 本模块会产出的那种 key：非空、不以零位结尾、每个字符都在字母表里 */
export function isValidOrder(key: string): boolean {
  return key.length > 0 && key[key.length - 1] !== ZERO && inAlphabet(key)
}

/** 排在 a 后面。末位往上抬一格的一半；抬不动（已经是最大位）就往后补一位 */
function keyAfter(a: string): string {
  const ia = DIGITS.indexOf(a[a.length - 1] ?? ZERO)
  if (ia < DIGITS.length - 1) return a.slice(0, -1) + DIGITS[Math.floor((ia + DIGITS.length) / 2)]!
  return a + MID
}

/** 排在 b 前面。递归一定收敛：每借一位 b 就短一位 */
function keyBefore(b: string): string | null {
  // 递归到底了。返回哪个 key 都行 —— 前面那一层已经保证整体小于 b
  if (b === '') return MID
  // 全是零位：字母表里没有比它更小的字符串了（'0' 就是全局最小）
  if (!/[^0]/.test(b)) return null
  const ib = DIGITS.indexOf(b[0]!)
  // 首位还有空位：取它和自己之间的一半，一位就够
  if (ib > 1) return DIGITS[Math.floor(ib / 2)]!
  // 首位是 '0' 或 '1'：一位数里没有可用的（'0' 会造出尾零，'1' 下面只剩 '0'），
  // 只能借一位往下问。借出来的首位严格小于 b 的首位，结果一定在 b 前面
  const rest = keyBefore(b.slice(1))
  return rest === null ? null : ZERO + rest
}

/**
 * 夹在 a 和 b 之间的 key，没有就返回 null。
 * a 可能比 b 短（老 key 之间是等长的，但和手排 key 混着就可能不等长）——
 * 短的那些位按零位算，这样"字典序"和"它表示的分数"才始终一致。
 */
function midpoint(a: string, b: string): string | null {
  let i = 0
  while (i < b.length) {
    const ca = i < a.length ? a[i]! : ZERO
    const cb = b[i]!
    if (ca !== cb) {
      const da = DIGITS.indexOf(ca)
      const db = DIGITS.indexOf(cb)
      // 这一位中间还有空档，直接取一位就完事
      if (db - da > 1) return a.slice(0, i) + DIGITS[Math.round((da + db) / 2)]!
      // 两位挨着：抄下 a 的这一位，再到 a 的尾巴后面继续找。
      // head 要显式带上补的那个零位，否则算出来的 key 会跑到 b 后面去
      const head = i + 1 <= a.length ? a.slice(0, i + 1) : a + ZERO.repeat(i + 1 - a.length)
      return head + keyAfter(a.slice(i + 1))
    }
    i++
  }
  // 一路到 b 的末尾都没差出来：b 是 a 后面接了一串零位，两者之间没有空位
  return null
}

/**
 * 算出"夹在 a 和 b 之间"的 key。a 为 null 表示插在最前，b 为 null 表示插在最后。
 * 空串（0.0.x 没写过 order 字段的任务）按 null 处理。
 *
 * 返回 null = **这两个邻居之间一个空位都没有了**，调用方得先把那一格的 order 重排。
 * 老库的 16 位时间戳 key 挨得特别近（相差 1 毫秒）时会走到这条路。
 */
export function orderBetween(a: string | null, b: string | null): string | null {
  const lo = !a ? null : a
  const hi = !b ? null : b
  // 认不出来的字符（数据坏了）当"没有空位"处理，让调用方去重排那一格
  if (lo !== null && !inAlphabet(lo)) return null
  if (hi !== null && !inAlphabet(hi)) return null
  if (lo === null && hi === null) return MID
  if (lo === null) return keyBefore(hi!)
  if (hi === null) return keyAfter(lo)
  // 两台机器同时往同一处拖，可能拿到相同的 order（见 §7.3 的 tiebreaker 那段）。
  // 这时退回"排在 lo 后面"：位置可能差一格，但不会抛错、也不会写出坏 key
  if (lo >= hi) return keyAfter(lo)
  return midpoint(lo, hi)
}

/** 按当前顺序把一串任务均匀铺开。一格里再也挤不下东西时用它整格重排，顺序不变 */
export function spreadOrders(ids: string[]): Array<{ id: string; key: string }> {
  const out: Array<{ id: string; key: string }> = []
  let prev: string | null = null
  for (const id of ids) {
    const key: string = orderBetween(prev, null)!
    out.push({ id, key })
    prev = key
  }
  return out
}

/**
 * 新任务的 order：`'z'` + 零填充时间戳 + 一个非零位。
 *
 * 这是**界外调用**（CLI、测试、周期任务派生出的下一个实例）的兜底。界面自己会算
 * 落点（它知道"哪一天"，见 app.ts 的 orderForNewDay），因为"排在那天最后"要按本地
 * 日期分组，而 core 不碰时区。
 *
 * 为什么带 `'z'` 前缀：它是字母表里最大的位，凡是**不以 'z' 开头**的 key 都排在它前面
 *（老 key 是纯数字，手排 key 从 'V' 起步、从两头往外长，绝大多数都不是 'z' 打头）。
 * 时间戳保证同一天里建的几条按创建顺序排；末尾那个非零位是为了不破坏上面那条不变量。
 *
 * 它给不了"绝对排在那天最后"—— 'zV' 这种 key 仍然排在它前面。真正"排在那天最后"
 * 由界面算（见 orderForNewDay），这里只是界外调用能拿到的最好近似。
 */
export function orderKey(now: number): string { return 'z' + String(now).padStart(16, '0') + MID }

/**
 * 同一天里的先后。**手排的 order 说了算，时间只当标签。**
 * order 相同时（并发拖拽）用 id 兜底，保证哪台机器上算出来的顺序都一样。
 */
export function compareOrder(a: { id: string; order: string }, b: { id: string; order: string }): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
