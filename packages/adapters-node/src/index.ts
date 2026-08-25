import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import type { ClockPort, DirEntry, Env, FsPort, RandomPort } from '@kapibala/core'

const nil = (e: unknown) => (e as { code?: string }).code === 'ENOENT'

export class NodeFs implements FsPort {
  async readFile(p: string) {
    try { return new Uint8Array(await fs.readFile(p)) } catch (e) { if (nil(e)) return null; throw e }
  }
  async appendFile(p: string, d: Uint8Array) { await fs.appendFile(p, d) }
  /** 同目录 .tmp + rename。跨目录 rename 不是原子操作 */
  async writeAtomic(p: string, d: Uint8Array) {
    const tmp = `${p}.${process.pid}.tmp`
    await fs.writeFile(tmp, d)
    await fs.rename(tmp, p)
  }
  async readDir(p: string): Promise<DirEntry[]> {
    try {
      return (await fs.readdir(p, { withFileTypes: true }))
        .map(e => ({ name: e.name, isDir: e.isDirectory() }))
    } catch (e) { if (nil(e)) return []; throw e }
  }
  async mkdirp(p: string) { await fs.mkdir(p, { recursive: true }) }
  async size(p: string) {
    try { return (await fs.stat(p)).size } catch (e) { if (nil(e)) return 0; throw e }
  }
  /**
   * iCloud 会驱逐不常用文件，只留 .000001.jsonl.icloud 占位符。
   * 跳过占位符 = 静默丢掉一整台设备的历史，所以这里必须触发下载并等它完成。
   * 见 storage.zh.md §6.4
   */
  async ensureDownloaded(p: string, timeoutMs = 30_000) {
    const i = p.lastIndexOf('/')
    const dir = p.slice(0, i), base = p.slice(i + 1)
    const placeholder = `${dir}/.${base}.icloud`
    try { await fs.access(p); return } catch { /* 落地文件不存在，继续看占位符 */ }
    try { await fs.access(placeholder) } catch { return }   // 也没有占位符 → 文件真的不存在
    try { execFileSync('brctl', ['download', p], { stdio: 'ignore' }) } catch { /* 尽力而为 */ }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { await fs.access(p); return } catch {}
      await new Promise(r => setTimeout(r, 300))
    }
    throw new Error(`iCloud 文件下载超时：${p}`)
  }
}

export class NodeClock implements ClockPort { now() { return Date.now() } }
export class NodeRandom implements RandomPort { bytes(n: number) { return new Uint8Array(randomBytes(n)) } }

/** 跟着主板走。整机迁移后它会变，正是归属校验需要的信号 */
export function machineId(): string {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)
    if (m) return m[1]!
  } catch {}
  return `hostname:${hostname()}`
}

/** KAPIBALA_USER_DATA / KAPIBALA_MACHINE_ID 只为测试与 spike 而存在：
 *  用它们在一台机器上模拟两台 Mac（storage.zh.md §9.2 的 spike 2 和 4） */
export const userDataDir = () =>
  process.env['KAPIBALA_USER_DATA'] ?? `${homedir()}/Library/Application Support/Kapibala`

export function nodeEnv(overrides: Partial<Env> = {}): Env {
  return {
    fs: new NodeFs(), clock: new NodeClock(), random: new NodeRandom(),
    machineId: process.env['KAPIBALA_MACHINE_ID'] ?? machineId(),
    userDataDir: userDataDir(),
    label: process.env['KAPIBALA_LABEL'] ?? hostname().replace(/\.local$/, ''),
    ...overrides,
  }
}

/**
 * 同一台机器上 GUI 和 CLI 会抢同一个设备目录，必须锁。
 * 锁文件放在本地 userData —— 库目录里的锁在 iCloud 上跨机器毫无意义。
 * 见 storage.zh.md §4.3
 */
export async function withLock<T>(vaultId: string, fn: () => Promise<T>,
                                  waitMs = 2000): Promise<T> {
  const dir = `${userDataDir()}/locks`
  await fs.mkdir(dir, { recursive: true })
  const lock = `${dir}/${vaultId}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const h = await fs.open(lock, 'wx')
      await h.writeFile(String(process.pid)); await h.close()
      try { return await fn() } finally { await fs.rm(lock, { force: true }) }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
      // 判断持锁进程是否还活着，挡掉崩溃留下的死锁
      const pid = Number(await fs.readFile(lock, 'utf8').catch(() => '0'))
      let alive = false
      try { process.kill(pid, 0); alive = true } catch {}
      if (!alive) { await fs.rm(lock, { force: true }); continue }
      if (Date.now() > deadline) throw new Error('另一个 Kapibala 进程正在写这个库，稍后再试')
      await new Promise(r => setTimeout(r, 100))
    }
  }
}
