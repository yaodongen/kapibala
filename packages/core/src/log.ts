import type { FsPort } from './ports.ts'
import type { Op, Snapshot, State } from './types.ts'
import { cmpHlc } from './hlc.ts'
import { flatten } from './state.ts'

export const SEGMENT_MAX_BYTES = 2 * 1024 * 1024
const SEG_RE = /^(\d{6})\.jsonl$/
export const segName = (i: number) => `${String(i).padStart(6, '0')}.jsonl`

/** iCloud 会把没下载的文件显示成 .000001.jsonl.icloud，扫描时要还原真名 */
export function realName(name: string): string {
  const m = /^\.(.+)\.icloud$/.exec(name)
  return m ? m[1]! : name
}

export type ParseResult = { ops: Op[]; badLines: number; droppedTail: boolean }

/** 绝不因为一行坏数据拒绝启动，见 storage.zh.md §6.1 */
export function parseSegment(bytes: Uint8Array): ParseResult {
  const text = new TextDecoder().decode(bytes)
  if (!text) return { ops: [], badLines: 0, droppedTail: false }
  const lines = text.split('\n')
  // 最后一行没有换行符 = 写入中途崩溃或同步到一半，只允许丢弃最后一行
  const droppedTail = !text.endsWith('\n') && lines[lines.length - 1] !== ''
  if (droppedTail) lines.pop()
  const ops: Op[] = []
  let badLines = 0
  for (const line of lines) {
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o.hlc === 'string' && typeof o.e === 'string' &&
          typeof o.id === 'string' && typeof o.f === 'string') ops.push(o as Op)
      else badLines++
    } catch { badLines++ }
  }
  return { ops, badLines, droppedTail }
}

/** snapshot 里的 hlc 少了设备段，读取时必须还原——只允许在这里出现一次 */
export function rehydrate(snap: Snapshot): Op[] {
  const st: State = {}
  for (const e of Object.keys(snap.state)) {
    st[e] = {}
    for (const id of Object.keys(snap.state[e]!)) {
      st[e]![id] = {}
      for (const [f, c] of Object.entries(snap.state[e]![id]!))
        st[e]![id]![f] = { val: c.val, hlc: `${c.hlc}:${snap.deviceId}` }
    }
  }
  return flatten(st)
}

export function dehydrate(deviceId: string, state: State, lastSegment: number, hlcMax: string): Snapshot {
  const out: State = {}
  for (const e of Object.keys(state)) {
    out[e] = {}
    for (const id of Object.keys(state[e]!)) {
      out[e]![id] = {}
      for (const [f, c] of Object.entries(state[e]![id]!))
        out[e]![id]![f] = { val: c.val, hlc: c.hlc.split(':').slice(0, 2).join(':') }
    }
  }
  return { schema: 1, deviceId, lastSegment, hlcMax, state: out }
}

export type DeviceRead = {
  deviceId: string
  ops: Op[]
  segments: number[]
  lastSegment: number       // snapshot 覆盖到的段
  badLines: number
  droppedTail: boolean
  incomplete: boolean       // 有文件读不出来
}

export async function readDevice(fs: FsPort, devicesDir: string, deviceId: string): Promise<DeviceRead> {
  const dir = `${devicesDir}/${deviceId}`
  const entries = await fs.readDir(dir)
  const names = entries.map(e => realName(e.name))
  const r: DeviceRead = { deviceId, ops: [], segments: [], lastSegment: 0,
                          badLines: 0, droppedTail: false, incomplete: false }

  // 先把占位符全部触发下载，否则会静默丢掉这台设备的历史
  for (const n of names) {
    try { await fs.ensureDownloaded(`${dir}/${n}`) } catch { r.incomplete = true }
  }

  if (names.includes('snapshot.json')) {
    try {
      const raw = await fs.readFile(`${dir}/snapshot.json`)
      if (raw) {
        const snap = JSON.parse(new TextDecoder().decode(raw)) as Snapshot
        if (snap.schema <= 1) { r.ops.push(...rehydrate(snap)); r.lastSegment = snap.lastSegment }
      }
    } catch { r.incomplete = true }
  }

  r.segments = names.map(n => SEG_RE.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
  for (const i of r.segments) {
    if (i <= r.lastSegment) continue
    let raw: Uint8Array | null = null
    try { raw = await fs.readFile(`${dir}/${segName(i)}`) } catch { raw = null }
    // 整个段读不出来：跳过并如实报告历史不完整，绝不静默当成空
    if (!raw) { r.incomplete = true; continue }
    const p = parseSegment(raw)
    r.ops.push(...p.ops); r.badLines += p.badLines; r.droppedTail ||= p.droppedTail
  }
  return r
}

export type VaultRead = { ops: Op[]; devices: DeviceRead[] }

export async function readVault(fs: FsPort, vaultPath: string): Promise<VaultRead> {
  const devicesDir = `${vaultPath}/devices`
  const dirs = (await fs.readDir(devicesDir)).filter(e => e.isDir).map(e => e.name)
  const devices: DeviceRead[] = []
  for (const id of dirs.sort()) devices.push(await readDevice(fs, devicesDir, id))
  const ops = devices.flatMap(d => d.ops).sort((a, b) => cmpHlc(a.hlc, b.hlc))
  return { ops, devices }
}

export function encodeOps(ops: Op[]): Uint8Array {
  return new TextEncoder().encode(ops.map(o => JSON.stringify(o)).join('\n') + '\n')
}
