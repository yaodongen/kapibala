/**
 * 备注的富文本 = Markdown 纯文本。
 *
 * 存的是 Markdown 源码，不是 HTML —— 这样 grep 得到、以后换编辑器也不被绑死，
 * 符合"存储是纯文本，不是二进制黑盒"这条承诺。渲染只在界面上做。
 *
 * 自己写而不是引依赖：运行时依赖目前为零，而备注用得到的语法就这么几条。
 * 安全上只有一条铁律：先转义所有 HTML，再套语法；链接只放行 http/https/mailto。
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SAFE_URL = /^(https?:\/\/|mailto:)/i
/** 抠出行内代码时的占位符。用 NUL，用户输入里不可能有 */
const TOK = '\u0000'

function inline(src: string): string {
  const code: string[] = []
  // 行内代码先抠出来占位，否则里面的 * 和 _ 会被当成语法
  let s = esc(src).replace(/`([^`]+)`/g, (_m, c: string) => `${TOK}${code.push(c) - 1}${TOK}`)

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) =>
    SAFE_URL.test(href) ? `<a href="${href}">${text}</a>` : text)      // 不安全的协议只留文字
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) =>
    `${pre}<a href="${url}">${url}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')

  return s.replace(new RegExp(`${TOK}(\\d+)${TOK}`, 'g'),
                   (_m, i: string) => `<code>${code[Number(i)]}</code>`)
}

/** Markdown -> 安全的 HTML 片段 */
export function renderMarkdown(src: string): string {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  let fence: string[] | null = null

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`); para = [] }
  }
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const openList = (kind: 'ul' | 'ol') => {
    if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind }
  }

  for (const line of lines) {
    if (fence !== null) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null }
      else fence.push(line)
      continue
    }
    if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue }

    if (!line.trim()) { flushPara(); flushList(); continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); flushList(); out.push('<hr>'); continue }

    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushPara(); flushList()
      const n = Math.min(h[1]!.length + 2, 6)      // 备注里不该出现 h1 那么大的标题
      out.push(`<h${n}>${inline(h[2]!)}</h${n}>`)
      continue
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (li) { flushPara(); openList('ul'); out.push(`<li>${inline(li[1]!)}</li>`); continue }
    const oli = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (oli) { flushPara(); openList('ol'); out.push(`<li>${inline(oli[1]!)}</li>`); continue }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`); continue }

    para.push(line)
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`)
  flushPara(); flushList()
  return out.join('\n')
}

/** 任务行下面显示的一行摘要：去掉标记、压成一行 */
export function notePreview(src: string, max = 60): string {
  const t = (src ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`]+/g, ' ')
    .replace(/^\s*[-+]\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}
