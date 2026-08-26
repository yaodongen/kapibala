import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { userDataDir } from '@kapibala/adapters-node'

const DIR = `${userDataDir()}/logs`
const FILE = `${DIR}/kapibala.log`
const MAX = 512 * 1024

/** 日志只写本地，从不上传。用户自己决定要不要把内容发给开发者 */
export function log(level: 'info' | 'error', msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}` +
    (extra === undefined ? '' : ' ' + safe(extra)) + '\n'
  try {
    mkdirSync(DIR, { recursive: true })
    try { if (statSync(FILE).size > MAX) renameSync(FILE, `${FILE}.1`) } catch { /* 还没有日志文件 */ }
    appendFileSync(FILE, line)
  } catch { /* 连日志都写不了就算了，不能让记日志本身把应用弄崩 */ }
  ;(level === 'error' ? console.error : console.log)(line.trimEnd())
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`
  try { return JSON.stringify(v) } catch { return String(v) }
}

export function readLog(maxLines = 400): string {
  try {
    const text = readFileSync(FILE, 'utf8').split('\n')
    return text.slice(-maxLines).join('\n').trim()
  } catch { return '（还没有日志）' }
}

export const logPath = () => FILE
