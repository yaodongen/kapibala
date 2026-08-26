/**
 * RFC 5545 RRULE 的一个子集：够表达"每月第二个周二""每年""仅工作日"这类规则。
 *
 * 明确支持：FREQ（DAILY/WEEKLY/MONTHLY/YEARLY）、INTERVAL、BYDAY（可带序号，
 * 如 2TU 第二个周二、-1FR 最后一个周五）、BYMONTHDAY（含 -1 表示月末）、
 * BYMONTH、UNTIL。
 * 明确不支持：COUNT（要记已生成几次，和"完成时才生成下一个"的模型冲突）、
 * BYSETPOS、BYWEEKNO、BYYEARDAY、WKST（一律按周一为周首）。
 * 不支持的部分在解析时忽略，而不是假装懂 —— 假装懂会算出错的日期。
 */

import type { RepeatRule } from './types.ts'

export type Weekday = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA'
export const WEEKDAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export type ByDay = { ord?: number; day: Weekday }

export type Rrule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  byday?: ByDay[]
  bymonthday?: number[]
  bymonth?: number[]
  until?: number      // epoch ms，含当天
}

const DAY = 86400000

/** "FREQ=MONTHLY;BYDAY=2TU" → 结构体。看不懂就返回 null，绝不猜 */
export function parseRrule(src: string): Rrule | null {
  const parts = new Map<string, string>()
  for (const kv of (src ?? '').replace(/^RRULE:/i, '').split(';')) {
    const i = kv.indexOf('=')
    if (i > 0) parts.set(kv.slice(0, i).trim().toUpperCase(), kv.slice(i + 1).trim())
  }
  const freq = parts.get('FREQ')?.toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null

  const out: Rrule = { freq, interval: Math.max(1, Number(parts.get('INTERVAL') ?? 1) || 1) }

  const byday = parts.get('BYDAY')
  if (byday) {
    const list: ByDay[] = []
    for (const raw of byday.split(',')) {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(raw.trim())
      if (!m) continue
      const day = m[2]!.toUpperCase() as Weekday
      list.push(m[1] ? { ord: Number(m[1]), day } : { day })
    }
    if (list.length) out.byday = list
  }

  const nums = (key: string, keep: (n: number) => boolean) => {
    const v = parts.get(key)
    if (!v) return undefined
    const list = v.split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && keep(n))
    return list.length ? list : undefined
  }
  const bymonthday = nums('BYMONTHDAY', n => (n >= 1 && n <= 31) || n === -1)
  if (bymonthday) out.bymonthday = bymonthday
  const bymonth = nums('BYMONTH', n => n >= 1 && n <= 12)
  if (bymonth) out.bymonth = bymonth

  const until = parts.get('UNTIL')
  if (until) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(until)
    // UNTIL 到当天结束都算有效，否则"到 8 月 31 日"会把 31 号本身排除掉
    if (m) out.until = +new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
    else if (!Number.isNaN(Date.parse(until))) out.until = Date.parse(until)
  }
  return out
}

export function formatRrule(r: Rrule): string {
  const p = [`FREQ=${r.freq}`]
  if (r.interval > 1) p.push(`INTERVAL=${r.interval}`)
  if (r.byday?.length) p.push(`BYDAY=${r.byday.map(b => `${b.ord ?? ''}${b.day}`).join(',')}`)
  if (r.bymonthday?.length) p.push(`BYMONTHDAY=${r.bymonthday.join(',')}`)
  if (r.bymonth?.length) p.push(`BYMONTH=${r.bymonth.join(',')}`)
  if (r.until !== undefined) {
    const d = new Date(r.until)
    p.push(`UNTIL=${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`)
  }
  return p.join(';')
}

const dow = (d: Date) => WEEKDAYS[d.getDay()]!
const monthDays = (y: number, m: number) => new Date(y, m + 1, 0).getDate()

/** 这一天是本月第几个星期 X（1 起），以及倒数第几个（-1 起） */
function nthOfMonth(d: Date): { nth: number; fromEnd: number } {
  const nth = Math.floor((d.getDate() - 1) / 7) + 1
  const total = monthDays(d.getFullYear(), d.getMonth())
  const fromEnd = -Math.floor((total - d.getDate()) / 7) - 1
  return { nth, fromEnd }
}

function matchesByday(rule: Rrule, d: Date): boolean {
  if (!rule.byday?.length) return true
  const wd = dow(d)
  const { nth, fromEnd } = nthOfMonth(d)
  return rule.byday.some(b => {
    if (b.day !== wd) return false
    if (b.ord === undefined) return true
    return b.ord > 0 ? b.ord === nth : b.ord === fromEnd
  })
}

function matchesMonthday(rule: Rrule, d: Date): boolean {
  if (!rule.bymonthday?.length) return true
  const last = monthDays(d.getFullYear(), d.getMonth())
  return rule.bymonthday.some(n => (n === -1 ? d.getDate() === last : d.getDate() === n))
}

/** 间隔对齐：以 anchor（这一系列的当前实例）为基准 */
function alignedWith(rule: Rrule, anchor: Date, d: Date): boolean {
  const n = rule.interval
  if (n <= 1) return true
  if (rule.freq === 'DAILY') {
    return Math.round((startOfDay(d) - startOfDay(anchor)) / DAY) % n === 0
  }
  if (rule.freq === 'WEEKLY') {
    const w = (x: Date) => Math.floor((startOfDay(x) - startOfWeek(anchor)) / (7 * DAY))
    return w(d) % n === 0
  }
  const months = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth())
  if (rule.freq === 'MONTHLY') return months % n === 0
  return (d.getFullYear() - anchor.getFullYear()) % n === 0
}

const startOfDay = (d: Date) => +new Date(d.getFullYear(), d.getMonth(), d.getDate())
function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))     // 一律按周一为周首
  return +x
}

function matchesDate(rule: Rrule, anchor: Date, d: Date): boolean {
  if (!alignedWith(rule, anchor, d)) return false
  if (rule.bymonth?.length && !rule.bymonth.includes(d.getMonth() + 1)) return false
  if (!matchesByday(rule, d)) return false
  if (!matchesMonthday(rule, d)) return false

  // 没写 BY* 的时候，按 anchor 的"同一天"理解
  if (rule.freq === 'WEEKLY' && !rule.byday?.length) return dow(d) === dow(anchor)
  if (rule.freq === 'MONTHLY' && !rule.byday?.length && !rule.bymonthday?.length)
    return d.getDate() === anchor.getDate()
  if (rule.freq === 'YEARLY' && !rule.byday?.length && !rule.bymonthday?.length && !rule.bymonth?.length)
    return d.getMonth() === anchor.getMonth() && d.getDate() === anchor.getDate()
  return true
}

/**
 * anchor 之后的下一次。逐天前扫而不是解析式推算 ——
 * 慢一点（最多几千次判断，微秒级），但"1 月 31 日 + 每月"这类边界不会算错：
 * 2 月没有 31 号就跳过，跟 RFC 一致。
 */
export function nextAfter(rule: Rrule, anchorMs: number, afterMs: number): number | null {
  const anchor = new Date(anchorMs)
  const hh = anchor.getHours(), mm = anchor.getMinutes(), ss = anchor.getSeconds()
  const limit = 366 * 4 * Math.max(1, rule.interval)     // 够覆盖"每 4 年 2 月 29 日"
  let d = new Date(Math.max(afterMs, anchorMs))
  d.setHours(hh, mm, ss, 0)
  if (+d <= afterMs) d.setDate(d.getDate() + 1)

  for (let i = 0; i < limit; i++) {
    if (rule.until !== undefined && +d > rule.until) return null
    if (matchesDate(rule, anchor, d)) return +d
    d.setDate(d.getDate() + 1)
    d.setHours(hh, mm, ss, 0)     // 跨夏令时后把时间拨回原样
  }
  return null
}

/** 界面语言。拿不准的语言一律按中文，见 apps/desktop/src/i18n.ts 的 langOf */
export type Lang = 'zh' | 'en'

const CN_DAY: Record<Weekday, string> = {
  SU: '周日', MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六',
}
const CN_ORD = ['', '第一个', '第二个', '第三个', '第四个', '第五个']
const EN_DAY: Record<Weekday, string> = {
  SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday',
  TH: 'Thursday', FR: 'Friday', SA: 'Saturday',
}
const EN_MONTH = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']

/** 1 → 1st，2 → 2nd，-1 → last。序数词只在英文里需要 */
function ord(n: number): string {
  if (n === -1) return 'last'
  const suffix = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`
}

const WORKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR']
const isWorkweek = (days: Weekday[]) =>
  days.length === 5 && WORKDAYS.every(d => days.includes(d))

/** 英文描述，比如 "Monthly on the 2nd Tuesday" */
function describeEn(r: Rrule): string {
  const days = r.byday?.map(b => b.day) ?? []
  const n = r.interval

  if (r.freq === 'DAILY') return n > 1 ? `Every ${n} days` : 'Daily'
  if (r.freq === 'WEEKLY') {
    if (isWorkweek(days)) return 'Weekdays'
    const list = days.map(d => EN_DAY[d]).join(', ')
    if (!days.length) return n > 1 ? `Every ${n} weeks` : 'Weekly'
    return n > 1 ? `Every ${n} weeks on ${list}` : `Every ${list}`
  }
  if (r.freq === 'MONTHLY') {
    const unit = n > 1 ? `Every ${n} months` : 'Monthly'
    const b = r.byday?.[0]
    if (b?.ord) return `${unit} on the ${ord(b.ord)} ${EN_DAY[b.day]}`
    if (r.bymonthday?.length)
      return `${unit} on the ${r.bymonthday.map(x => (x === -1 ? 'last day' : ord(x))).join(', ')}`
    return unit
  }
  const unit = n > 1 ? `Every ${n} years` : 'Yearly'
  if (r.bymonth?.length && r.bymonthday?.length)
    return `${unit} on ${EN_MONTH[r.bymonth[0]! - 1]} ${r.bymonthday[0]}`
  return unit
}

/** 给界面用的描述，比如"每月第二个周二"。默认中文 */
export function describeRrule(src: string | Rrule, lang: Lang = 'zh'): string {
  const r = typeof src === 'string' ? parseRrule(src) : src
  if (!r) return lang === 'en' ? 'Repeats' : '重复'
  if (lang === 'en') return describeEn(r)
  const every = r.interval > 1 ? `每 ${r.interval} ` : '每'
  const days = r.byday?.map(b => b.day) ?? []

  if (r.freq === 'DAILY') return r.interval > 1 ? `每 ${r.interval} 天` : '每天'
  if (r.freq === 'WEEKLY') {
    if (isWorkweek(days)) return '工作日'
    if (!days.length) return r.interval > 1 ? `每 ${r.interval} 周` : '每周'
    return `${every}${r.interval > 1 ? '周 ' : '周'}${days.map(d => CN_DAY[d]).join('、')}`
      .replace('每周周', '每周')
  }
  if (r.freq === 'MONTHLY') {
    const unit = r.interval > 1 ? `每 ${r.interval} 个月` : '每月'
    const b = r.byday?.[0]
    if (b?.ord) return `${unit}${b.ord === -1 ? '最后一个' : CN_ORD[b.ord] ?? ''}${CN_DAY[b.day]}`
    if (r.bymonthday?.length)
      return `${unit}${r.bymonthday.map(n => (n === -1 ? '最后一天' : `${n} 日`)).join('、')}`
    return unit
  }
  const unit = r.interval > 1 ? `每 ${r.interval} 年` : '每年'
  if (r.bymonth?.length && r.bymonthday?.length) return `${unit} ${r.bymonth[0]} 月 ${r.bymonthday[0]} 日`
  return unit
}

/**
 * 0.0.x 写下的 `{freq, interval}` 形状要继续读得懂 —— 用户库里已经有这种数据。
 * 新数据写 `rrule` 字符串。这正是"只增字段、不改语义"那条规则的用法。
 */
export function toRruleString(rule: RepeatRule): string {
  if (rule.rrule) return rule.rrule
  const n = Math.max(1, rule.interval ?? 1)
  const freq = rule.freq ?? 'DAILY'
  return n > 1 ? `FREQ=${freq};INTERVAL=${n}` : `FREQ=${freq}`
}

export const describeRepeat = (rule: RepeatRule, lang: Lang = 'zh'): string =>
  describeRrule(toRruleString(rule), lang)

/** 从一个具体日期推出常用预设，界面上直接给选项用 */
export function presetsFor(at: number, lang: Lang = 'zh'): { label: string; rrule: string }[] {
  const d = new Date(at)
  const wd = dow(d)
  const day = d.getDate()
  const month = d.getMonth() + 1
  const { nth, fromEnd } = nthOfMonth(d)
  const nthOrd = fromEnd === -1 ? -1 : nth
  const labels = lang === 'en'
    ? ['Daily', `Weekly on ${EN_DAY[wd]}`, 'Weekdays (Mon–Fri)', `Monthly on the ${ord(day)}`,
       `Monthly on the ${ord(nthOrd)} ${EN_DAY[wd]}`, `Yearly on ${EN_MONTH[month - 1]} ${day}`]
    : ['每天', `每周${CN_DAY[wd]}`, '工作日（周一至周五）', `每月 ${day} 日`,
       `每月${nthOrd === -1 ? '最后一个' : CN_ORD[nthOrd]}${CN_DAY[wd]}`, `每年 ${month} 月 ${day} 日`]
  const rrules = [
    'FREQ=DAILY',
    `FREQ=WEEKLY;BYDAY=${wd}`,
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    `FREQ=MONTHLY;BYMONTHDAY=${day}`,
    `FREQ=MONTHLY;BYDAY=${nthOrd}${wd}`,
    `FREQ=YEARLY;BYMONTH=${month};BYMONTHDAY=${day}`,
  ]
  return rrules.map((rrule, i) => ({ label: labels[i]!, rrule }))
}
