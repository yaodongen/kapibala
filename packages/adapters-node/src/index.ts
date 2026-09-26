import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname } from 'node:path'
import type { ClockPort, DirEntry, Env, FsPort, RandomPort } from '@kapibala/core'

const nil = (e: unknown) => (e as { code?: string }).code === 'ENOENT'
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

/** 让宿主（桌面版）能把这里的观察写进它的日志 */
let note: (msg: string, extra?: unknown) => void = () => {}
export const setNoteLogger = (fn: typeof note) => { note = fn }

/**
 * iCloud 没下载的文件在目录里显示为 .原名.icloud。
 * 用 dirname/basename 拼，不按 '/' 切字符串 —— Windows 上路径是反斜杠，
 * 按 '/' 切会切出一个不存在的怪路径（它只喂给 existsSync，不致命，但没必要留这个坑）。
 */
export const placeholderOf = (p: string) => `${dirname(p)}/.${basename(p)}.icloud`

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
   *
   * 触发下载并短暂等待。**不能久等**：第二台 Mac 打开同步过来的库时，
   * 整个库可能全是占位符，每个文件等 30 秒会让界面像死了一样。
   * 这里最多等 3 秒就放弃，让上层带着"历史不完整"先把界面显示出来，
   * 文件落地后 fs.watch 会自动触发重读。
   *
   * **只有 macOS 需要这一套。** Windows 上常见的同步盘（OneDrive / 坚果云）用的是
   * 另一套按需文件机制：在 fs 这一层它就是普通文件，水合由系统在真正读的时候做，
   * 没有"先看占位符、再命令它下载"这一步，也没有 brctl 这种命令可调。
   * 所以 Windows 上这里只回答"文件在不在"，剩下的交给系统的同步客户端。
   */
  async ensureDownloaded(p: string, timeoutMs = 3000) {
    try { await fs.access(p); return } catch { /* 落地文件不存在，继续看占位符 */ }
    if (!isMac) return
    try { await fs.access(placeholderOf(p)) } catch { return }  // 也没有占位符 → 文件真的不存在
    note('iCloud 占位符，触发下载', { path: p })
    try { execFileSync('brctl', ['download', p], { stdio: 'ignore' }) } catch { /* 尽力而为 */ }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { await fs.access(p); return } catch {}
      await new Promise(r => setTimeout(r, 200))
    }
    note('iCloud 文件还没下载下来，先跳过', { path: p, waitedMs: timeoutMs })
    throw new Error(`iCloud 文件还没下载下来：${p}`)
  }
}

export class NodeClock implements ClockPort { now() { return Date.now() } }
export class NodeRandom implements RandomPort { bytes(n: number) { return new Uint8Array(randomBytes(n)) } }

/**
 * 跟着主板走。整机迁移后它会变，正是归属校验需要的信号。
 * macOS 是 IOPlatformUUID，Windows 是注册表里的 MachineGuid —— 两者同一个性质：
 * 换机器/重装系统会变，平时不动。见 storage.zh.md §4.2。
 */
export function machineId(): string {
  return (isMac ? macMachineId() : isWin ? winMachineId() : '') || `hostname:${hostname()}`
}

function macMachineId(): string {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? ''
  } catch { return '' }
}

/** 显式 /reg:64：32 位进程默认会被重定向到 Wow6432Node，那条路下没有 MachineGuid */
function winMachineId(): string {
  try {
    const out = execFileSync('reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
      { encoding: 'utf8', windowsHide: true })
    return /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out)?.[1] ?? ''
  } catch { return '' }
}

/**
 * 本机状态（界面偏好、锁、日志）放哪。两个平台都按各自的约定走，
 * 共同点是**绝不放进库目录** —— 库目录会被同步到别的机器上，锁和界面偏好跟过去毫无意义。
 * 见 storage.zh.md §4.3
 *
 * KAPIBALA_USER_DATA 覆盖它只为测试与 spike 而存在：用它在一台机器上模拟两台 Mac
 * （storage.zh.md §9.2 的 spike 2 和 4）。
 */
export const userDataDir = () => {
  const forced = process.env['KAPIBALA_USER_DATA']
  if (forced) return forced
  if (isWin) return `${process.env['APPDATA'] || `${homedir()}\\AppData\\Roaming`}\\Kapibala`
  return `${homedir()}/Library/Application Support/Kapibala`
}

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
