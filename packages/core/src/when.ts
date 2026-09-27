/**
 * 从自由文本里认日期和时间 —— 中英文都认。
 *
 * 定位：**只认，不改**。给它一段文本和一个"现在"，它告诉你命中了哪一天、
 * 哪个时刻，以及命中片段的原文位置；标题原文一个字都不动（添加栏的规矩）。
 * 认不出来就返回 null，绝不拿近似值糊弄 —— 认错的日子比没认出来更烦人。
 *
 * 这里不碰存储、不碰时区配置：一律用运行环境的本地时区，和 rrule.ts 一个口径。
 * 所有"相对说法"（明天、下周三、in 3 days）都以传进来的 `now` 为基准算，
 * 这样单测可以把时间钉死，不看跑测试的那天是星期几。
 *
 * 下面 `WHEN_PATTERNS` 是给人和测试看的具名正则清单：一条说法一条正则，
 * 附一句它认什么。真正干活的是同名的 matcher —— 两者共用同一份 re，
 * 不会出现"文档写了一套、代码里是另一套"。
 */

/** 时段。单独出现（"下午"）时会落一个约定俗成的整点，见 DEFAULT_MINUTES */
export type PeriodKind = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'midnight'

/** 命中结果。day / minutes 至少有一个 */
export type WhenHit = {
  /** 命中的那一天，本地时区当天 00:00 的 epoch ms */
  day?: number
  /** 命中的时刻，当天 0 点起的分钟数（0–1439） */
  minutes?: number
  /** 只有日期、没认到时刻时为 true。界面据此决定要不要填时间、写不写 isAllDay */
  allDay: boolean
  /** 命中的原文：从第一个片段到最后一个片段整段切下来（调试用；界面不拿它改标题） */
  text: string
  /** 命中片段在原文里的位置，按出现顺序。用于日志、以后想做高亮 */
  spans: Array<{ start: number; end: number }>
}

export type WhenPattern = { name: string; re: RegExp; note: string }

/* ── 小工具：本地时区的日期运算 ──────────────────────────────────────────
 * 一律走 Date 的本地 get/set，而不是 `ts + n * 86400000`：夏令时那天只有
 * 23 或 25 小时，按固定毫秒加会算到前一天/后一天的半夜去。
 */

const startOfDay = (ts: number): number => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return +d
}

/** 加天数。先把时间归零，避免用到 Date 上残留的时分秒 */
function addDays(day: number, n: number): number {
  const d = new Date(day)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return +d
}

/** 加月数。目标月没有这一天（1月31日 + 1个月）就落到那个月的最后一天 */
function addMonths(day: number, n: number): number {
  const d = new Date(day)
  const dd = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(dd, last))
  d.setHours(0, 0, 0, 0)
  return +d
}

function addYears(day: number, n: number): number {
  const d = new Date(day)
  const m = d.getMonth()
  const dd = d.getDate()
  d.setDate(1)
  d.setFullYear(d.getFullYear() + n)
  d.setMonth(m)
  const last = new Date(d.getFullYear(), m + 1, 0).getDate()
  d.setDate(Math.min(dd, last))
  d.setHours(0, 0, 0, 0)
  return +d
}

/** 某天的 00:00 加上"当天第几分钟"。跨夏令时也落在正确的墙上时间 */
function atMinutes(day: number, minutes: number): number {
  const d = new Date(day)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return +d
}

/** 那一周的周一（周首一律按周一，和 rrule.ts 的 WKST 口径一致） */
const mondayOf = (day: number): number => addDays(day, -((new Date(day).getDay() + 6) % 7))

/** 当月最后一天 */
const endOfMonth = (day: number): number => {
  const d = new Date(day)
  return +new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

/* ── 归一化 ──────────────────────────────────────────────────────────────
 * 全角数字、全角冒号斜杠转成半角，英文转小写。替换全是 1 字符 ↔ 1 字符，
 * 所以 `match.index` 在原串上依然对得上，spans 可以直接用。
 */
const FULLWIDTH = '０１２３４５６７８９'

function normalize(src: string): string {
  let out = ''
  for (const ch of src) {
    const i = FULLWIDTH.indexOf(ch)
    out += i >= 0 ? String(i) : ch
  }
  return out.replace(/：/g, ':').replace(/／/g, '/').toLowerCase()
}

/* ── 中文数字 ───────────────────────────────────────────────────────────── */
const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** "三"→3、"十五"→15、"二十三"→23。只覆盖 0–99（够"点/分"用），认不出返回 null */
export function cnNumber(src: string): number | null {
  const s = src.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const ten = /^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/.exec(s)
  if (ten) return (ten[1] ? CN_DIGIT[ten[1]]! : 1) * 10 + (ten[2] ? CN_DIGIT[ten[2]]! : 0)
  if (s.length === 1 && CN_DIGIT[s] !== undefined) return CN_DIGIT[s]!
  return null
}

/* ── 时段 ──────────────────────────────────────────────────────────────── */

/** 时段单独出现、没有具体钟点时，落一个约定俗成的整点。界面上看得见、改得动 */
const DEFAULT_MINUTES: Record<PeriodKind, number> = {
  morning: 9 * 60,      // 上午 / morning
  noon: 12 * 60,        // 中午 / noon
  afternoon: 15 * 60,   // 下午 / afternoon
  evening: 20 * 60,     // 晚上 / evening
  night: 20 * 60,       // 夜里 / night
  midnight: 0,          // 凌晨 / midnight
}

const CN_PERIODS: Record<string, PeriodKind> = {
  凌晨: 'midnight', 清晨: 'morning', 早晨: 'morning', 早上: 'morning', 上午: 'morning',
  中午: 'noon', 正午: 'noon', 下午: 'afternoon',
  傍晚: 'evening', 晚上: 'evening', 夜里: 'night', 夜晚: 'night',
}
const EN_PERIODS: Record<string, PeriodKind> = {
  morning: 'morning', noon: 'noon', afternoon: 'afternoon',
  evening: 'evening', night: 'night', midnight: 'midnight',
}

/**
 * 把 12 小时制的"3 点"配上时段还原成 24 小时制。
 * 单独一个时段时（p 为 undefined）原样返回。
 * 中午按"中午 1 点 = 13:00、中午 12 点 = 12:00"处理，符合中文习惯。
 */
function applyPeriod(hour: number, period: PeriodKind | undefined): number {
  if (period === undefined) return hour
  switch (period) {
    case 'morning': return hour === 12 ? 0 : hour
    case 'noon': return hour <= 6 ? hour + 12 : hour
    case 'afternoon':
    case 'evening':
    case 'night': return hour < 12 ? hour + 12 : hour
    case 'midnight': return hour === 12 ? 0 : hour
  }
}

/* ── 星期 / 月份 ───────────────────────────────────────────────────────── */

const CN_WEEKDAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: 6,
}
const EN_WEEKDAY: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}
const EN_MONTH: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** 英文星期名（含缩写）。thu/thur/thurs/thursday 都要认 */
const EN_WEEKDAY_RE = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?"
/** 英文月份名（含缩写，可带点）。sep / sept / september 都要认 */
const EN_MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"

/* ── matcher ───────────────────────────────────────────────────────────── */

type DateRun = { day: number; period?: PeriodKind; minutes?: number }
type TimeRun = { minutes: number; period?: PeriodKind }

type Matcher = {
  name: string
  re: RegExp
  note: string
  /** 认"哪一天"。返回 null = 这条其实不该算数（比如月份非法） */
  date?: (m: RegExpExecArray, now: number) => DateRun | null
  /** 认"哪一刻"。返回 null = 同上 */
  time?: (m: RegExpExecArray, now: number) => TimeRun | null
}

const CN_PERIOD_RE = Object.keys(CN_PERIODS).join('|')
const CN_NUM_RE = `\\d{1,2}|[零〇一二两三四五六七八九十]{1,3}`

/* 中文日期 ─────────────────────────────────────────────────────────────── */

const CN_RELATIVE: Record<string, { days: number; period?: PeriodKind }> = {
  今天: { days: 0 }, 今日: { days: 0 },
  今晚: { days: 0, period: 'evening' }, 今早: { days: 0, period: 'morning' }, 今晨: { days: 0, period: 'morning' },
  明天: { days: 1 }, 明日: { days: 1 },
  明早: { days: 1, period: 'morning' }, 明晚: { days: 1, period: 'evening' },
  后天: { days: 2 }, 后日: { days: 2 }, 大后天: { days: 3 },
  昨天: { days: -1 }, 昨日: { days: -1 }, 前天: { days: -2 }, 前日: { days: -2 }, 大前天: { days: -3 },
}

/* 英文日期 ─────────────────────────────────────────────────────────────── */

const EN_RELATIVE: Record<string, { days: number; period?: PeriodKind }> = {
  today: { days: 0 }, tomorrow: { days: 1 }, yesterday: { days: -1 },
  tonight: { days: 0, period: 'evening' },
  'day after tomorrow': { days: 2 }, 'the day after tomorrow': { days: 2 },
}

/* matcher 清单：顺序有意义 —— 同一位置能匹配上多条时，取更长的（见 pickBest） */

const DATE_MATCHERS: Matcher[] = [
  {
    name: 'cn.relative-day',
    re: /(大后天|大前天|今天|今日|今晚|今早|今晨|明天|明日|明早|明晚|后天|后日|前天|前日|昨天|昨日)/,
    note: '今天/明天/后天/大后天/昨天/前天，以及今晚、明早这类"日子+时段"',
    date: (m, now) => {
      const hit = CN_RELATIVE[m[1]!]!
      return { day: addDays(startOfDay(now), hit.days), ...(hit.period ? { period: hit.period } : {}) }
    },
  },
  {
    name: 'cn.weekday',
    re: /(上|下|本|这)?\s*个?\s*(?:周|星期|礼拜)\s*([一二三四五六日天末])/,
    note: '周三/星期三/礼拜五、下周三、本周五、上周六；"周末"的末算周六',
    date: (m, now) => {
      const base = mondayOf(startOfDay(now))
      const target = addDays(base, (CN_WEEKDAY[m[2]!]! + 6) % 7)
      const p = m[1]
      if (p === '下') return { day: addDays(target, 7) }
      if (p === '上') return { day: addDays(target, -7) }
      if (p === '本' || p === '这') return { day: target }
      // 光说"周三"：取最近的一次，今天就是周三就算今天
      return { day: target < startOfDay(now) ? addDays(target, 7) : target }
    },
  },
  {
    name: 'cn.month-day',
    re: /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/,
    note: '3月5日、3月5号、2026年8月28日。没写年份且已经过了，就顺延到明年',
    date: (m, now) => {
      const t = startOfDay(now)
      const nowY = new Date(t).getFullYear()
      const year = m[1] ? Number(m[1]) : nowY
      const yearGiven = m[1] !== undefined
      const month = Number(m[2])
      const day = Number(m[3])
      if (month < 1 || month > 12 || day < 1 || day > 31) return null
      let d = +new Date(year, month - 1, day)
      if (+new Date(year, month - 1, day).getMonth() !== month - 1) return null   // 2月30日
      d = startOfDay(d)
      if (!yearGiven && d < t) d = +new Date(year + 1, month - 1, day)
      return { day: startOfDay(d) }
    },
  },
  {
    name: 'cn.day-of-month',
    re: /(下下个?月|下个?月|下月|本个?月|本月|这个月|这个)?\s*(\d{1,2})\s*[日号]/,
    note: '5号、5日；下个月5号、本月5号。光说"5号"：本月没过就算本月，过了算下月',
    date: (m, now) => {
      const t = startOfDay(now)
      const p = m[1] ?? ''
      const day = Number(m[2])
      if (day < 1 || day > 31) return null
      const base = p.includes('下下') ? addMonths(t, 2) : p.startsWith('下') ? addMonths(t, 1) : t
      const explicit = p !== ''
      const d = new Date(base)
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      if (day > last) return null
      let out = startOfDay(+new Date(d.getFullYear(), d.getMonth(), day))
      if (!explicit && out < t) out = startOfDay(addMonths(out, 1))
      return { day: out }
    },
  },
  {
    name: 'cn.after-days',
    re: /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(天|周|个?月|年)\s*(?:后|以后|之后)/,
    note: '3天后、两周以后、两个月以后、一年后',
    date: (m, now) => cnAfter(Number(m[1]) || cnNumber(m[1]!), m[2]!, now),
  },
  {
    name: 'cn.in-days',
    re: /(?:再过|还有)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(天|周|个?月|年)(?:后|以后|之后)?/,
    note: '再过3天、还有两周（"再过/还有"本身就说了是往后，可以不带"后"）',
    date: (m, now) => cnAfter(Number(m[1]) || cnNumber(m[1]!), m[2]!, now),
  },
  {
    name: 'cn.this-next-week',
    re: /(上|下|本|这)\s*个?\s*(?:周|星期|礼拜)(?![一二三四五六日天末])/,
    note: '下周/本周/这周/上周（光说"这周"就是本周一，光说"下周"就是下周一）',
    date: (m, now) => {
      const base = mondayOf(startOfDay(now))
      const p = m[1]
      if (p === '下') return { day: addDays(base, 7) }
      if (p === '上') return { day: addDays(base, -7) }
      return { day: base }
    },
  },
  {
    name: 'cn.end-of',
    re: /(?:(下下个?月|下个?月|下月|本个?月|本月|这个月|明年|今年)\s*(月底|月末|年底|年末|底)|(月底|月末|年底|年末))/,
    note: '月底/月末、年底/年末；下个月底、明年底',
    date: (m, now) => {
      const t = startOfDay(now)
      const p = m[1] ?? ''
      const kind = (m[2] ?? m[3])!
      // "明年底"的"底"归年，"下个月底"的"底"归月 —— 看前缀带的是年还是月
      const yearEnd = kind.includes('年') || (kind === '底' && (p === '明年' || p === '今年'))
      if (yearEnd) {
        const year = p === '明年' ? new Date(t).getFullYear() + 1 : new Date(t).getFullYear()
        return { day: startOfDay(+new Date(year, 11, 31)) }
      }
      const base = p.includes('下下') ? addMonths(t, 2) : p.startsWith('下') ? addMonths(t, 1) : t
      return { day: endOfMonth(base) }
    },
  },
  {
    name: 'cn.weekend',
    re: /(上|下|本|这)?\s*个?\s*周末/,
    note: '周末（算最近的周六）、这周末、下周末、上周末',
    date: (m, now) => {
      const base = mondayOf(startOfDay(now))
      const sat = addDays(base, 5)
      const p = m[1]
      if (p === '下') return { day: addDays(sat, 7) }
      if (p === '上') return { day: addDays(sat, -7) }
      if (p === '本' || p === '这') return { day: sat }
      return { day: sat < startOfDay(now) ? addDays(sat, 7) : sat }
    },
  },
  {
    name: 'en.relative-day',
    re: /\b(today|tomorrow|tonight|yesterday|day after tomorrow|the day after tomorrow)\b/,
    note: 'today / tomorrow / tonight / yesterday / the day after tomorrow',
    date: (m, now) => {
      const hit = EN_RELATIVE[m[1]!]!
      return { day: addDays(startOfDay(now), hit.days), ...(hit.period ? { period: hit.period } : {}) }
    },
  },
  {
    name: 'en.in-n',
    re: /\bin\s+(\d{1,3})\s+(days?|weeks?|months?)\b/,
    note: 'in 3 days / in 2 weeks / in 1 month',
    date: (m, now) => {
      const n = Number(m[1])
      const t = startOfDay(now)
      const unit = m[2]!
      if (unit.startsWith('day')) return { day: addDays(t, n) }
      if (unit.startsWith('week')) return { day: addDays(t, n * 7) }
      return { day: addMonths(t, n) }
    },
  },
  {
    name: 'en.n-from-now',
    re: /\b(\d{1,3})\s+(days?|weeks?|months?)\s+from now\b/,
    note: '3 days from now / 2 weeks from now',
    date: (m, now) => {
      const n = Number(m[1])
      const t = startOfDay(now)
      const unit = m[2]!
      if (unit.startsWith('day')) return { day: addDays(t, n) }
      if (unit.startsWith('week')) return { day: addDays(t, n * 7) }
      return { day: addMonths(t, n) }
    },
  },
  {
    name: 'en.week',
    re: /\b(next|this|last)\s+week\b/,
    note: 'next week / this week / last week（都落在那一周的周一）',
    date: (m, now) => {
      const base = mondayOf(startOfDay(now))
      const p = m[1]
      if (p === 'next') return { day: addDays(base, 7) }
      if (p === 'last') return { day: addDays(base, -7) }
      return { day: base }
    },
  },
  {
    name: 'en.weekday',
    re: new RegExp(`\\b(next|this|last)\\s+(${EN_WEEKDAY_RE})\\b`),
    note: 'next Monday / this Fri / last Wed',
    date: (m, now) => enWeekday(m[2]!, m[1]!, now),
  },
  {
    name: 'en.weekday-bare',
    re: new RegExp(`\\b(${EN_WEEKDAY_RE})\\b`),
    note: 'Monday / Mon / Fri；取最近的一次，今天就是这天就算今天',
    date: (m, now) => enWeekday(m[1]!, undefined, now),
  },
  {
    name: 'en.month-day',
    re: new RegExp(`\\b(${EN_MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`),
    note: 'Jan 5 / January 5th / Sep 3, 2026。没写年份且已经过了，就顺延到明年',
    date: (m, now) => enMonthDay(EN_MONTH[m[1]!.slice(0, 3)]!, Number(m[2]), m[3], now),
  },
  {
    name: 'en.day-month',
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${EN_MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?`),
    note: '5 Jan / 5th January 2026（英式写法）',
    date: (m, now) => enMonthDay(EN_MONTH[m[2]!.slice(0, 3)]!, Number(m[1]), m[3], now),
  },
  {
    name: 'en.big-endian',
    re: /\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)(?:[t\s](\d{1,2}):(\d{2}))?/,
    note: '2026-08-28、2026/08/28、2026.06.30（年在前，- / . 三种分隔符都认），后面可跟 19:30 / T19:30',
    date: (m) => {
      const d = makeDay(Number(m[1]), Number(m[2]), Number(m[3]))
      if (d === null) return null
      const out: DateRun = { day: d }
      if (m[4] !== undefined) {
        const h = Number(m[4])
        const mi = Number(m[5])
        if (h <= 23 && mi <= 59) out.minutes = h * 60 + mi
      }
      return out
    },
  },
  {
    name: 'num.yyyymmdd',
    re: /\b(\d{4})(\d{2})(\d{2})(?:t(\d{2})(\d{2})|\s+(\d{2})(\d{2}))?\b/,
    note: '20260630（8 位连着写，前 4 位当年），后面可跟 T1930 / 1930',
    date: (m) => numericDay(Number(m[1]), Number(m[2]), Number(m[3]), [m[4], m[5], m[6], m[7]]),
  },
  {
    name: 'num.yymmdd',
    re: /\b(\d{2})(\d{2})(\d{2})(?:t(\d{2})(\d{2})|\s+(\d{2})(\d{2}))?\b/,
    note: '260630（6 位，当 YYMMDD，26 → 2026；00–79 归 20xx，80–99 归 19xx），后面可跟 T1930 / 1930',
    date: (m) => {
      const yy = Number(m[1])
      return numericDay(yy <= 79 ? 2000 + yy : 1900 + yy, Number(m[2]), Number(m[3]), [m[4], m[5], m[6], m[7]])
    },
  },
  {
    name: 'num.mmdd',
    re: /\b(\d{2})(\d{2})(?:t(\d{2})(\d{2})|\s+(\d{2})(\d{2}))?\b/,
    note: '0630（4 位，当月/日；今年这天已过就顺延到明年），后面可跟 T1930 / 1930',
    date: (m, now) => {
      const t = startOfDay(now)
      const year = new Date(t).getFullYear()
      const month = Number(m[1])
      const day = Number(m[2])
      const t2 = [m[3], m[4], m[5], m[6]]
      const hit = numericDay(year, month, day, t2)
      if (hit && hit.day! < t) return numericDay(year + 1, month, day, t2)
      return hit
    },
  },
  {
    name: 'en.slash-md',
    re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
    note: '8/28 或 8/28/2026，按美式"月/日"读',
    date: (m, now) => {
      const t = startOfDay(now)
      const month = Number(m[1])
      const day = Number(m[2])
      if (month < 1 || month > 12 || day < 1 || day > 31) return null
      let year = m[3] !== undefined ? Number(m[3]) : new Date(t).getFullYear()
      if (year < 100) year += 2000
      const dt = new Date(year, month - 1, day)
      if (dt.getMonth() !== month - 1 || dt.getDate() !== day) return null
      let out = startOfDay(+dt)
      if (m[3] === undefined && out < t) out = startOfDay(+new Date(year + 1, month - 1, day))
      return { day: out }
    },
  },
  {
    name: 'en.next-month',
    re: /\bnext month\b/,
    note: 'next month（下个月的同一天）',
    date: (_m, now) => ({ day: addMonths(startOfDay(now), 1) }),
  },
  {
    name: 'en.end-of',
    re: /\bend of (?:the )?(month|year)\b/,
    note: 'end of month / end of the month / end of year',
    date: (m, now) => {
      const t = startOfDay(now)
      if (m[1] === 'year') return { day: startOfDay(+new Date(new Date(t).getFullYear(), 11, 31)) }
      return { day: endOfMonth(t) }
    },
  },
]

/** "N 天/周/月/年以后"的公共算法 */
function cnAfter(n: number | null, unit: string, now: number): DateRun | null {
  if (n === null) return null
  const t = startOfDay(now)
  if (unit === '天') return { day: addDays(t, n) }
  if (unit === '周') return { day: addDays(t, n * 7) }
  if (unit === '年') return { day: addYears(t, n) }
  return { day: addMonths(t, n) }
}

/** 星期：bare 取最近一次（含今天）；next/this/last 按周一为周首的周算 */
function enWeekday(name: string, prefix: string | undefined, now: number): DateRun | null {
  const idx = EN_WEEKDAY[name.slice(0, 3)]
  if (idx === undefined) return null
  const t = startOfDay(now)
  const target = addDays(mondayOf(t), (idx + 6) % 7)
  if (prefix === 'next') return { day: addDays(target, 7) }
  if (prefix === 'last') return { day: addDays(target, -7) }
  if (prefix === 'this') return { day: target }
  return { day: target < t ? addDays(target, 7) : target }
}

/** 月份 + 日。没写年份且已经过了就顺延到明年（和中文"3月5日"一个规矩） */
function enMonthDay(month: number, day: number, yearSrc: string | undefined, now: number): DateRun | null {
  if (month === undefined || day < 1 || day > 31) return null
  const t = startOfDay(now)
  const yearGiven = yearSrc !== undefined
  const year = yearGiven ? Number(yearSrc) : new Date(t).getFullYear()
  const d = new Date(year, month, day)
  if (d.getMonth() !== month || d.getDate() !== day) return null
  let out = startOfDay(+d)
  if (!yearGiven && out < t) out = startOfDay(+new Date(year + 1, month, day))
  return { day: out }
}

/** 年 + 月(1–12) + 日 → 当天零点；不是合法日期返回 null（2月30日、13月都要挡住） */
function makeDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const d = new Date(year, month - 1, day)
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return startOfDay(+d)
}

/**
 * 紧凑日期后面紧跟的时刻：`T1930` 或空格加 `1930`。
 * 认不出来或数字越界就当没写时刻 —— 时刻只是附带，不能因为它把日期也弄丢。
 */
function compactTime(g: Array<string | undefined>): number | undefined {
  const h = Number(g[0] ?? g[2])
  const mi = Number(g[1] ?? g[3])
  if (g[0] === undefined && g[2] === undefined) return undefined
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return undefined
  return h * 60 + mi
}

/** 紧凑数字日期（20260630 / 260630 / 0630）+ 可选的紧凑时刻 */
function numericDay(year: number, month: number, day: number, t: Array<string | undefined>): DateRun | null {
  const d = makeDay(year, month, day)
  if (d === null) return null
  const out: DateRun = { day: d }
  const minutes = compactTime(t)
  if (minutes !== undefined) out.minutes = minutes
  return out
}

/* 时间 ─────────────────────────────────────────────────────────────────── */

const TIME_MATCHERS: Matcher[] = [
  {
    name: 'cn.period-clock',
    // 时段那一截整个可选，连着它后面的空格一起 —— 写成 `(时段)?\s*` 的话，
    // 没有时段时 `\s*` 也会把钟点前面的空格吃进 span 里（" 19:30"）
    re: new RegExp(
      `(?:(${CN_PERIOD_RE})\\s*)?(?:(${CN_NUM_RE})\\s*[点時时]\\s*(?:(半)|(?:(${CN_NUM_RE})\\s*分?)?)|(\\d{1,2}):(\\d{2}))`,
    ),
    note: '3点 / 3点半 / 15点30分 / 三点半 / 下午3点 / 晚上8:30 / 15:30',
    time: (m) => {
      const period = m[1] ? CN_PERIODS[m[1]] : undefined
      let hour: number
      let min: number
      if (m[5] !== undefined) {
        hour = Number(m[5])
        min = Number(m[6])
      } else {
        const h = cnNumber(m[2] ?? '')
        if (h === null) return null
        hour = h
        min = m[3] ? 30 : m[4] ? (cnNumber(m[4]) ?? 0) : 0
      }
      if (hour > 24 || min > 59) return null
      const h24 = applyPeriod(hour === 24 ? 0 : hour, period)
      return { minutes: h24 * 60 + min, ...(period ? { period } : {}) }
    },
  },
  {
    name: 'cn.period-bare',
    re: new RegExp(`(${CN_PERIOD_RE})`),
    note: '只说到时段没说到点：上午/下午/晚上/中午/凌晨，落一个约定整点',
    time: (m) => {
      const period = CN_PERIODS[m[1]!]!
      return { minutes: DEFAULT_MINUTES[period], period }
    },
  },
  {
    name: 'en.ampm',
    re: /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/,
    note: '3pm / 3:30 pm / 11 a.m. / at 7pm',
    time: (m) => {
      let hour = Number(m[1])
      const min = m[2] ? Number(m[2]) : 0
      const pm = m[3]!.startsWith('p')
      if (hour > 12 || min > 59) return null
      if (pm && hour < 12) hour += 12
      if (!pm && hour === 12) hour = 0
      return { minutes: hour * 60 + min }
    },
  },
  {
    name: 'en.hhmm',
    re: /\b(?:at\s+)?(\d{1,2}):(\d{2})\b/,
    note: '15:30 / at 9:05（24 小时制）',
    time: (m) => {
      const hour = Number(m[1])
      const min = Number(m[2])
      if (hour > 23 || min > 59) return null
      return { minutes: hour * 60 + min }
    },
  },
  {
    name: 'en.at-hour',
    re: /\bat\s+(\d{1,2})\b/,
    note: 'at 3（光一个整点，按字面读成 3:00）',
    time: (m) => {
      const hour = Number(m[1])
      if (hour > 23) return null
      return { minutes: hour * 60 }
    },
  },
  {
    name: 'en.oclock',
    re: /\b(\d{1,2})\s*o'?clock\b/,
    note: "3 o'clock",
    time: (m) => {
      const hour = Number(m[1])
      if (hour > 23) return null
      return { minutes: hour * 60 }
    },
  },
  {
    name: 'en.n-in-the-period',
    re: /\b(\d{1,2})\s+in\s+the\s+(morning|afternoon|evening|night)\b/,
    note: '3 in the afternoon → 15:00',
    time: (m) => {
      const hour = Number(m[1])
      const period = EN_PERIODS[m[2]!]!
      if (hour > 12) return null
      return { minutes: applyPeriod(hour, period) * 60, period }
    },
  },
  {
    name: 'en.period-bare',
    re: /\b(morning|noon|afternoon|evening|night|midnight)\b/,
    note: 'morning / afternoon / evening / night / noon / midnight，落一个约定整点',
    time: (m) => {
      const period = EN_PERIODS[m[1]!]!
      return { minutes: DEFAULT_MINUTES[period], period }
    },
  },
]

const ALL_MATCHERS: Matcher[] = [...DATE_MATCHERS, ...TIME_MATCHERS]

/** 具名正则清单：给人和测试看的"收集"。真正干活的 matcher 与它共用同一份 re */
export const WHEN_PATTERNS: WhenPattern[] = ALL_MATCHERS.map(({ name, re, note }) => ({ name, re, note }))

/* ── 扫描 ───────────────────────────────────────────────────────────────── */

type Found = { start: number; end: number; run: DateRun | TimeRun; matcher: Matcher }

/** 跑一条 matcher，返回它在这段文本里**第一个**命中（非 global 正则，无 lastIndex 状态） */
function firstHit(text: string, matcher: Matcher, now: number): Found | null {
  const m = matcher.re.exec(text)
  if (!m) return null
  const run = matcher.date ? matcher.date(m, now) : matcher.time ? matcher.time(m, now) : null
  if (!run) return null
  return { start: m.index, end: m.index + m[0].length, run, matcher }
}

/**
 * 同一个位置能匹配上多条时，取更长的。
 * "下周三" 会被 cn.weekday 整条吃掉，而不是被"周三"从中间截走。
 */
function earlier(a: Found | null, b: Found | null): Found | null {
  if (!a) return b
  if (!b) return a
  if (a.start !== b.start) return a.start < b.start ? a : b
  return a.end - a.start >= b.end - b.start ? a : b
}

/**
 * 从一段自由文本里认日期和时间。
 *
 * 规则：
 * - 日期取**最先出现**的那一条；时间也取最先出现的（同一位置取更长的）。
 * - 日期和时间分开找，找到就合并：「明天下午3点」= 明天 + 15:00。
 * - 时间只认到时段没认到点（「明天下午」）时，落一个约定整点（下午 → 15:00）。
 *   这个整点是**给界面预填用的**，用户看得见、改得动。
 * - 认不出来返回 null。标题原文不动，是否采用由调用方决定。
 */
export function parseWhenIn(text: string, now: number = Date.now()): WhenHit | null {
  const src = normalize(text)
  if (!src.trim()) return null

  let dateHit: Found | null = null
  let clockHit: Found | null = null
  let periodHit: Found | null = null

  for (const matcher of ALL_MATCHERS) {
    const hit = firstHit(src, matcher, now)
    if (!hit) continue
    if (matcher.date) {
      dateHit = earlier(dateHit, hit)
    } else if (matcher.time) {
      const run = hit.run as TimeRun
      // cn.period-bare / en.period-bare 是"没说到点"的那两条，单独放
      const bare = matcher.name.endsWith('period-bare')
      if (bare) periodHit = earlier(periodHit, hit)
      else clockHit = earlier(clockHit, hit)
    }
  }

  let day: number | undefined
  let minutes: number | undefined
  /** 日子自带的时段：「今晚」的晚上、「明早」的早上。钟点没写时段时拿它掰小时 */
  let datePeriod: PeriodKind | undefined
  let dateMinutes: number | undefined
  if (dateHit) {
    const run = dateHit.run as DateRun
    day = run.day
    datePeriod = run.period
    dateMinutes = run.minutes      // ISO 里带的时刻，比如 2026-08-28T19:30
  }

  if (dateMinutes !== undefined) {
    // 日期串里已经写了时刻，不用再看别的钟点，否则"…T19:30"会被后面的规则二次加工
    minutes = dateMinutes
  } else if (clockHit) {
    const run = clockHit.run as TimeRun
    // 钟点自己带时段（"下午3点"/"3pm"）优先；否则看别处的时段（"3:30 in the afternoon"），
    // 再退到日子自带的时段（"今晚8点"）
    const p = run.period ?? (periodHit ? (periodHit.run as TimeRun).period : undefined) ?? datePeriod
    if (p) minutes = applyPeriod(Math.floor(run.minutes / 60), p) * 60 + (run.minutes % 60)
    else minutes = run.minutes
  } else if (periodHit) {
    minutes = (periodHit.run as TimeRun).minutes
  } else if (datePeriod) {
    minutes = DEFAULT_MINUTES[datePeriod]
  }

  if (day === undefined && minutes === undefined) return null

  const raw: Array<{ start: number; end: number }> = []
  if (dateHit) raw.push({ start: dateHit.start, end: dateHit.end })
  if (clockHit) raw.push({ start: clockHit.start, end: clockHit.end })
  if (periodHit) raw.push({ start: periodHit.start, end: periodHit.end })
  // 被别的片段包住的（"下午3点"里的"下午"）丢掉，只留下最长的那条，
  // 免得 text 里把同一段原文数两遍
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const spans: Array<{ start: number; end: number }> = []
  for (const s of raw) {
    if (spans.some(o => s.start >= o.start && s.end <= o.end)) continue
    spans.push(s)
  }
  spans.sort((a, b) => a.start - b.start)

  const hit: WhenHit = {
    allDay: minutes === undefined,
    // 从**原文**切，不是从归一化过的串切 —— 归一化只是一对一替换，
    // 位置对得上，但用户看到的原样（全角数字、大写）要还回去。
    // 取首尾之间整段，中间那点连接词（"6月30日 19:30"里那个空格）也跟着留下来
    text: text.slice(spans[0]!.start, spans[spans.length - 1]!.end),
    spans,
  }
  if (day !== undefined) hit.day = day
  if (minutes !== undefined) hit.minutes = minutes
  return hit
}

/**
 * 把命中结果落成任务的时间戳。没有日期就按"今天"算（添加栏的既有规矩：
 * 不选日期 = 今天）。没有时刻 → 当天 00:00 + isAllDay。
 */
export function whenToStart(hit: WhenHit, now: number = Date.now()): { startAt: number; isAllDay: boolean } | null {
  if (hit.day === undefined && hit.minutes === undefined) return null
  const day = hit.day ?? startOfDay(now)
  if (hit.minutes === undefined) return { startAt: day, isAllDay: true }
  return { startAt: atMinutes(day, hit.minutes), isAllDay: false }
}
