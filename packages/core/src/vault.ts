import type { Env } from './ports.ts'
import { APP_ID, SCHEMA_VERSION, type DeviceIdentity, type VaultEntry,
         type VaultMeta, type VaultsFile } from './types.ts'
import { randomHex, ulid } from './ids.ts'

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o, null, 2) + '\n')
const dec = <T,>(b: Uint8Array | null): T | null => {
  if (!b) return null
  try { return JSON.parse(new TextDecoder().decode(b)) as T } catch { return null }
}

/** 判断"空目录"时要忽略的系统垃圾。Finder 逛一遍就会留下 .DS_Store，
 *  拿它当"非空"会把用户挡在门外 */
const JUNK = new Set(['.DS_Store', '.localized', 'Icon\r', '.Trashes', '.fseventsd',
                      '.Spotlight-V100', '.TemporaryItems', 'desktop.ini', 'Thumbs.db'])
export const isJunk = (name: string) => JUNK.has(name) || name.endsWith('.icloud')

/** "文件还没从 iCloud 落地"和"根本不是库"是两件事，报错不能混 */
export const NOT_DOWNLOADED = 'KAPIBALA_NOT_DOWNLOADED'
export const isNotDownloaded = (e: unknown) =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === NOT_DOWNLOADED

export const registryPath = (userDataDir: string) => `${userDataDir}/vaults.json`

export async function readRegistry(env: Env): Promise<VaultsFile> {
  const f = dec<VaultsFile>(await env.fs.readFile(registryPath(env.userDataDir)))
  return f && Array.isArray(f.vaults) ? f : { version: 1, vaults: [] }
}
export async function writeRegistry(env: Env, reg: VaultsFile): Promise<void> {
  await env.fs.mkdirp(env.userDataDir)
  await env.fs.writeAtomic(registryPath(env.userDataDir), enc(reg))
}

export type OpenResult = {
  meta: VaultMeta
  entry: VaultEntry
  device: DeviceIdentity
  readOnly: boolean          // 库的 schema 比本机新 → 只读，绝不能让旧客户端写新格式
  forked: boolean            // 设备目录不属于本机，已换新身份
}

function newDevice(env: Env): DeviceIdentity {
  return {
    deviceId: ulid(env.clock, env.random),
    claimToken: randomHex(env.random, 32),
    machineId: env.machineId,
    label: env.label,
  }
}

/**
 * 归属校验：令牌匹配 **且** 还是同一台物理机。
 * 只看令牌挡不住"用迁移助理整机搬到新 Mac、旧机器还在用"——那种情况下令牌也被复制了。
 * 见 storage.zh.md §4.2
 */
async function claimDevice(env: Env, vaultPath: string, known?: DeviceIdentity):
    Promise<{ device: DeviceIdentity; forked: boolean }> {
  if (known) {
    const owner = dec<DeviceIdentity>(
      await env.fs.readFile(`${vaultPath}/devices/${known.deviceId}/owner.json`))
    if (owner && owner.claimToken === known.claimToken && owner.machineId === env.machineId)
      return { device: known, forked: false }
  }
  const device = newDevice(env)
  await env.fs.mkdirp(`${vaultPath}/devices/${device.deviceId}`)
  await env.fs.writeAtomic(`${vaultPath}/devices/${device.deviceId}/owner.json`, enc(device))
  return { device, forked: !!known }
}

async function upsertEntry(env: Env, entry: VaultEntry): Promise<void> {
  const reg = await readRegistry(env)
  const i = reg.vaults.findIndex(v => v.id === entry.id)
  if (i >= 0) reg.vaults[i] = entry; else reg.vaults.push(entry)
  reg.lastVaultId = entry.id
  await writeRegistry(env, reg)
}

export async function createVault(env: Env, vaultPath: string, name?: string): Promise<OpenResult> {
  const existing = dec<VaultMeta>(await env.fs.readFile(`${vaultPath}/.kapibala/meta.json`))
  if (existing) return openVault(env, vaultPath)
  const entries = (await env.fs.readDir(vaultPath)).filter(e => !isJunk(e.name))
  if (entries.length)
    throw new Error(`这个文件夹里已经有别的文件了，换一个空文件夹，或者选一个已有的 Kapibala 库：${vaultPath}`)

  const meta: VaultMeta = {
    appId: APP_ID, vaultId: ulid(env.clock, env.random), schema: SCHEMA_VERSION,
    createdAt: env.clock.now(), createdBy: 'kapibala/0.0.1',
  }
  await env.fs.mkdirp(`${vaultPath}/.kapibala`)
  await env.fs.writeAtomic(`${vaultPath}/.kapibala/meta.json`, enc(meta))
  const { device } = await claimDevice(env, vaultPath)
  const entry: VaultEntry = {
    id: meta.vaultId, path: vaultPath, name: name ?? vaultPath.split('/').filter(Boolean).pop() ?? 'Kapibala',
    lastOpenedAt: env.clock.now(), device,
  }
  await upsertEntry(env, entry)
  return { meta, entry, device, readOnly: false, forked: false }
}

export async function openVault(env: Env, vaultPath: string): Promise<OpenResult> {
  // meta.json 自己也可能是 iCloud 占位符 —— 不先触发下载就会被当成"这不是一个库"
  try { await env.fs.ensureDownloaded(`${vaultPath}/.kapibala/meta.json`) } catch { /* 下面会报错 */ }
  const meta = dec<VaultMeta>(await env.fs.readFile(`${vaultPath}/.kapibala/meta.json`))
  if (!meta) {
    // 占位符还在，说明这确实是个库，只是文件没落地 —— 别谎报"不是库"
    const pending = (await env.fs.readDir(`${vaultPath}/.kapibala`))
      .some(e => e.name === '.meta.json.icloud')
    if (pending)
      throw Object.assign(new Error('库文件还在从 iCloud 下载，稍等一下再试'), { code: NOT_DOWNLOADED })
    throw new Error(`这不是一个 Kapibala 库（缺 .kapibala/meta.json）：${vaultPath}`)
  }
  if (meta.appId !== APP_ID) throw new Error(`这个目录属于别的应用：${meta.appId}`)

  const reg = await readRegistry(env)
  const known = reg.vaults.find(v => v.id === meta.vaultId)
  const { device, forked } = await claimDevice(env, vaultPath, known?.device)
  const entry: VaultEntry = {
    id: meta.vaultId, path: vaultPath,
    name: known?.name ?? vaultPath.split('/').filter(Boolean).pop() ?? 'Kapibala',
    lastOpenedAt: env.clock.now(), device,
  }
  await upsertEntry(env, entry)
  return { meta, entry, device, readOnly: meta.schema > SCHEMA_VERSION, forked }
}
