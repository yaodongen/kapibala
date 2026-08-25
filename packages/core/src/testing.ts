import type { ClockPort, DirEntry, Env, FsPort, RandomPort } from './ports.ts'

/** 全内存文件系统：属性测试跑几千个 case 不碰磁盘 */
export class MemFs implements FsPort {
  files = new Map<string, Uint8Array>()
  dirs = new Set<string>(['/'])
  /** 故障注入：路径匹配就抛错，用来测坏数据容错 */
  failOn?: RegExp

  private check(p: string) { if (this.failOn?.test(p)) throw new Error(`注入的 I/O 错误: ${p}`) }
  private touchDirs(p: string) {
    const parts = p.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) this.dirs.add('/' + parts.slice(0, i).join('/'))
  }
  async readFile(p: string) { this.check(p); return this.files.get(p) ?? null }
  async appendFile(p: string, d: Uint8Array) {
    this.check(p)
    const prev = this.files.get(p) ?? new Uint8Array()
    const out = new Uint8Array(prev.byteLength + d.byteLength)
    out.set(prev); out.set(d, prev.byteLength)
    this.files.set(p, out); this.touchDirs(p.slice(0, p.lastIndexOf('/')))
  }
  async writeAtomic(p: string, d: Uint8Array) {
    this.check(p); this.files.set(p, d); this.touchDirs(p.slice(0, p.lastIndexOf('/')))
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const base = p.endsWith('/') ? p : p + '/'
    const out = new Map<string, DirEntry>()
    for (const f of this.files.keys())
      if (f.startsWith(base)) {
        const rest = f.slice(base.length)
        const seg = rest.split('/')[0]!
        out.set(seg, { name: seg, isDir: rest.includes('/') })
      }
    for (const d of this.dirs)
      if (d.startsWith(base) && d !== base.slice(0, -1)) {
        const seg = d.slice(base.length).split('/')[0]!
        if (seg) out.set(seg, { name: seg, isDir: true })
      }
    return [...out.values()]
  }
  async mkdirp(p: string) { this.touchDirs(p) }
  async size(p: string) { return this.files.get(p)?.byteLength ?? 0 }
  async ensureDownloaded(_p: string) {}
}

export class MemClock implements ClockPort {
  private t: number
  constructor(t = 1_760_000_000_000) { this.t = t }
  now() { return (this.t += 1) }
  set(t: number) { this.t = t }
}

/**
 * 确定性随机：同一个种子跑出同一串 ID，测试可复现。
 * 用 xorshift32 而不是 LCG —— LCG 的低位周期极短（低 8 位每 256 字节就重复），
 * 拿它当随机源会让同一毫秒内生成的 ULID 真的撞上。
 */
export class MemRandom implements RandomPort {
  private s: number
  constructor(seed = 1) { this.s = seed >>> 0 || 1 }
  bytes(n: number) {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      this.s ^= this.s << 13; this.s >>>= 0
      this.s ^= this.s >>> 17
      this.s ^= this.s << 5;  this.s >>>= 0
      out[i] = (this.s >>> 16) & 0xff
    }
    return out
  }
}

export function memEnv(opts: Partial<Env> & { fs?: MemFs } = {}): Env & { fs: MemFs } {
  const fs = opts.fs ?? new MemFs()
  return {
    fs,
    clock: opts.clock ?? new MemClock(),
    random: opts.random ?? new MemRandom(),
    machineId: opts.machineId ?? 'MACHINE-A',
    userDataDir: opts.userDataDir ?? '/userdata-a',
    label: opts.label ?? 'Mac A',
  }
}
