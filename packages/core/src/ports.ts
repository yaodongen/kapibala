/** core 不许直接 import node:fs —— 所有 I/O 走这些端口，见 architecture.zh.md §4 */

export type DirEntry = { name: string; isDir: boolean }

export interface FsPort {
  readFile(path: string): Promise<Uint8Array | null>   // 不存在返回 null，不抛
  appendFile(path: string, data: Uint8Array): Promise<void>
  writeAtomic(path: string, data: Uint8Array): Promise<void>  // 同目录 .tmp + rename
  readDir(path: string): Promise<DirEntry[]>            // 不存在返回 []
  mkdirp(path: string): Promise<void>
  size(path: string): Promise<number>                   // 不存在返回 0
  /** iCloud 占位符：确保文件真的下载下来了，见 storage.zh.md §6.4 */
  ensureDownloaded(path: string): Promise<void>
}

export interface ClockPort { now(): number }
export interface RandomPort { bytes(n: number): Uint8Array }

export type Env = {
  fs: FsPort
  clock: ClockPort
  random: RandomPort
  machineId: string
  userDataDir: string
  label: string
}
