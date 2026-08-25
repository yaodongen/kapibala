import type { ClockPort } from './ports.ts'

/** hlc = <16 位零填充毫秒>:<4 位零填充计数器>:<设备ID>，零填充保证字典序 = 时间序 */
export function formatHlc(physical: number, counter: number, deviceId: string): string {
  return `${String(physical).padStart(16, '0')}:${String(counter).padStart(4, '0')}:${deviceId}`
}
export function parseHlc(hlc: string): { physical: number; counter: number; deviceId: string } {
  const [p = '0', c = '0', ...rest] = hlc.split(':')
  return { physical: Number(p), counter: Number(c), deviceId: rest.join(':') }
}
/** 字符串比较即可 */
export const cmpHlc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export class HlcClock {
  private physical = 0
  private counter = 0
  private clock: ClockPort
  readonly deviceId: string
  constructor(clock: ClockPort, deviceId: string) { this.clock = clock; this.deviceId = deviceId }

  /** 本地产生一个新 op */
  tick(): string {
    const now = this.clock.now()
    if (now > this.physical) { this.physical = now; this.counter = 0 }
    else this.counter++
    return formatHlc(this.physical, this.counter, this.deviceId)
  }

  /**
   * 读到任何 op（包括自己的历史）时必须推进本地时钟。
   * 这不是优化：本机时钟慢 10 分钟时，不推进会导致新改动永远输不过对方的旧改动。
   * 顺带也解决了时钟回拨——自己上次的 op 就在日志里。见 storage.zh.md §5.2
   */
  observe(hlc: string): void {
    const r = parseHlc(hlc)
    const now = this.clock.now()
    const p = Math.max(now, this.physical, r.physical)
    if (p === this.physical && p === r.physical) this.counter = Math.max(this.counter, r.counter) + 1
    else if (p === this.physical) this.counter++
    else if (p === r.physical) this.counter = r.counter + 1
    else this.counter = 0
    this.physical = p
  }
}
