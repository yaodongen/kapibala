const DAY = 86400000
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WD_KEY: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
}

export const dayStart = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return +d }
export const today = () => dayStart(Date.now())
export const weekday = (ts: number) => WD[new Date(ts).getDay()]!

/** today | tomorrow | 2026-08-28 | +3d | fri | 周五 | 2026-08-28T19:30 */
export function parseWhen(s: string): { at: number; allDay: boolean } | null {
  const v = s.trim().toLowerCase()
  if (!v) return null
  if (v === 'today' || v === '今天') return { at: today(), allDay: true }
  if (v === 'tomorrow' || v === '明天') return { at: today() + DAY, allDay: true }
  const rel = /^\+(\d+)([dw])$/.exec(v)
  if (rel) return { at: today() + Number(rel[1]) * (rel[2] === 'w' ? 7 : 1) * DAY, allDay: true }
  const wd = WD_KEY[v.replace(/^周/, '')] ?? WD_KEY[v]
  if (wd !== undefined) {
    const t = today(), cur = new Date(t).getDay()
    return { at: t + ((wd - cur + 7) || 7) * DAY, allDay: true }
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?$/.exec(v)
  if (iso) {
    const [, y, m, d, hh, mm] = iso
    const at = +new Date(Number(y), Number(m) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0))
    return { at, allDay: hh === undefined }
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (hm) return { at: today() + Number(hm[1]) * 3600000 + Number(hm[2]) * 60000, allDay: false }
  return null
}

export function labelOf(ts: number): string {
  const t = today(), d = dayStart(ts)
  if (d === t) return `今天 ${weekday(ts)}`
  if (d === t + DAY) return `明天 ${weekday(ts)}`
  const x = new Date(ts)
  return `${x.getMonth() + 1}月${x.getDate()}日 ${weekday(ts)}`
}
export const hhmm = (ts: number) =>
  `${String(new Date(ts).getHours()).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`
