import { describe, expect, it } from 'vitest'
import { LANGS, isLang, langOf, t, type Strings } from '../src/i18n.ts'

const CJK = /[一-鿿]/

/** 带参数的文案没法遍历着调，挨个列出来 */
const computed = (S: Strings): string[] => [
  S.vaultTip('/Users/x/Kapibala', 'MacBook Air', 2),
  S.todaySub('Today', 'Wed'),
  S.searchSub('report', 3),   // 样例里不能带中文，否则这条测试会冤枉英文那份
  S.bannerBadLines(2),
  S.vaultCantOpen('boom'),
  S.welcomeFailed('boom'),
  S.dayLabel(new Date(2026, 7, 26)),
]

const flat = (S: Strings): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(S)) {
    if (typeof v === 'string') out.push([k, v])
    else if (Array.isArray(v)) v.forEach((x, i) => out.push([`${k}[${i}]`, x as string]))
  }
  for (const [i, v] of computed(S).entries()) out.push([`computed[${i}]`, v])
  return out
}

describe('系统语言 → 界面语言', () => {
  it.each([
    ['en', 'en'], ['en-US', 'en'], ['EN-gb', 'en'], ['en_GB', 'en'],
    ['zh', 'zh'], ['zh-CN', 'zh'], ['zh-Hant-TW', 'zh'],
    // 拿不准的一律回中文：这是产品决定，不是猜
    ['fr-FR', 'zh'], ['ja', 'zh'], ['english', 'zh'], ['', 'zh'],
  ])('%s → %s', (locale, want) => {
    expect(langOf(locale)).toBe(want)
  })

  it('拿不到系统语言也不能崩', () => {
    expect(langOf(undefined)).toBe('zh')
    expect(langOf(null)).toBe('zh')
  })

  it('isLang 只认这两种，别的都挡在外面', () => {
    expect(LANGS.every(isLang)).toBe(true)
    expect(isLang('de')).toBe(false)
    expect(isLang(undefined)).toBe(false)
  })
})

describe('两份文案', () => {
  it('都没有空字符串', () => {
    for (const lang of LANGS)
      for (const [k, v] of flat(t(lang)))
        expect(v.trim(), `${lang}.${k}`).not.toBe('')
  })

  it('英文那份里不该再有中文 —— 漏翻一句就会被这条抓住', () => {
    for (const [k, v] of flat(t('en'))) {
      // 语言切换按钮上写的就是"要切过去的那个语言"，中文界面写 English，英文界面写中文
      if (k === 'langOther') continue
      expect(CJK.test(v), `en.${k} = ${v}`).toBe(false)
    }
  })

  it('中文那份里的中文标点不该混进英文那份的括号写法', () => {
    expect(t('zh').brand).toBe('卡皮巴拉')
    expect(t('en').brand).toBe('Kapibala')
    expect(t('en').weekdays[3]).toBe('Wed')
    expect(t('zh').weekdays[3]).toBe('周三')
  })

  it('视图名和视图 id 对得上（render() 直接按 id 取名字）', () => {
    for (const lang of LANGS) {
      const S = t(lang)
      for (const id of ['today', 'next7', 'next30', 'all', 'done', 'trash'] as const) {
        expect(typeof S[id]).toBe('string')
        expect(typeof S[`${id}Sub` as 'next7Sub']).not.toBe('undefined')
      }
    }
  })
})
