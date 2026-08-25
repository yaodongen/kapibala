import { createHash } from 'node:crypto'
import type { ClockPort, RandomPort } from './ports.ts'

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   // Crockford，去掉 I L O U

/** ULID：48 位时间 + 80 位随机，字典序 = 时间序 */
export function ulid(clock: ClockPort, random: RandomPort): string {
  let t = clock.now(), time = ''
  for (let i = 0; i < 10; i++) { time = B32[t % 32]! + time; t = Math.floor(t / 32) }
  const b = random.bytes(10)
  let rand = ''
  for (let i = 0; i < 16; i++) {
    // 每 5 bit 取一个字符
    const bit = i * 5
    const byte = bit >> 3, shift = bit & 7
    const v = ((b[byte]! << 8) | (b[byte + 1] ?? 0)) >> (11 - shift)
    rand += B32[v & 31]!
  }
  return time + rand
}

export function randomHex(random: RandomPort, n: number): string {
  return [...random.bytes(n)].map(x => x.toString(16).padStart(2, '0')).join('')
}

const NS = 'a6f1c0de-kapibala-namespace'

/**
 * 周期任务的下一个实例必须用确定性 ID：两台 Mac 各自完成同一次，
 * 算出同一个 ID，字段级 LWW 一合并就是一个任务。见 storage.zh.md §7.2
 */
export function derivedId(seriesId: string, occurrenceKey: string): string {
  // 必须用 sha256：26 个字符需要 26 个字节，sha1 只有 20 个，后 6 位会全变成 '0'
  const h = createHash('sha256').update(`${NS}|${seriesId}|${occurrenceKey}`).digest()
  let out = ''
  for (let i = 0; i < 26; i++) out += B32[h[i]! & 31]!
  return out
}
