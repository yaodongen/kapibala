/**
 * 「重要 → 进行中」的位置规则。**只有这一份**：主进程标记时按它写 order（见 main.ts 的
 * pinOrder），渲染进程在"手排管不着"的那几处显示时按它兜底（见 renderer/app.ts 的 pinFirst）。
 * 两边各写一遍的话，同一批任务在两处露头的先后迟早对不上。
 *
 * 四档：**重要 + 进行中 > 重要 > 进行中 > 其余**。
 * 一条已经在做的重要任务就是当下最该露头的那条，所以它排在只标了重要的那些前面。
 */
import { orderBetween } from '@kapibala/core/order'

/** 0 重要 + 进行中、1 重要、2 进行中、3 普通。比较时就是比这个数 */
export type PinRank = 0 | 1 | 2 | 3
export const pinRank = (t: { important: boolean; inProgress: boolean }): PinRank =>
  t.important ? (t.inProgress ? 0 : 1) : t.inProgress ? 2 : 3

/**
 * 标记之后该插进那一串（同一天里没做完的、按当前先后排好的 peers）的第几个位置。
 *
 * `front` 打开 = 顶到最前面，比所有重要任务都靠前；关着 = 插到最后一个重要任务之后
 *（那一天一条重要任务都没有时，落点也还是最前面）。按位置找最后一个重要任务，而不是数
 * 一共有几条：用户可以把手排的普通任务拖到重要任务上面去，那时候最后一条并不在数组末尾。
 *
 * `front` 什么时候打开 —— 看**标记之后这条是不是重要任务**：
 *   - 标「重要」：是（它可能本来就在做，那更是"重要 + 进行中"，更该在最前）
 *   - 标「进行中」：本来就重要才是 —— 这就是"已经重要的任务再标 Doing，顶到重要任务最前面"
 */
export function pinCut(peers: Array<{ important: boolean }>, front: boolean): number {
  if (front) return 0
  let cut = 0
  for (let i = 0; i < peers.length; i++) if (peers[i]!.important) cut = i + 1
  return cut
}

/**
 * 那条 order 本身：`{ cut, key }`。key 为 null = 这两个邻居之间一个空位都没了
 * （老库那种挨得极近的 key），调用方得把这一格按 cut 重铺一遍（见 main.ts 的 pinOrder）。
 */
export function pinKey(peers: Array<{ order: string; important: boolean }>, front: boolean):
  { cut: number; key: string | null } {
  const cut = pinCut(peers, front)
  return { cut, key: orderBetween(cut ? peers[cut - 1]!.order : null, peers[cut]?.order ?? null) }
}
