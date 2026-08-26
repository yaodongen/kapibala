import { describe, expect, it } from 'vitest'
import { notePreview, renderMarkdown } from '../src/markdown.ts'

describe('备注的 Markdown 渲染', () => {
  it('粗体、斜体、删除线、行内代码', () => {
    expect(renderMarkdown('**粗** *斜* ~~删~~ `代码`')).toBe(
      '<p><strong>粗</strong> <em>斜</em> <del>删</del> <code>代码</code></p>')
  })

  it('行内代码里的星号不当语法处理', () => {
    expect(renderMarkdown('`a * b * c`')).toBe('<p><code>a * b * c</code></p>')
  })

  it('标题从 h3 起，备注里不该有 h1 那么大', () => {
    expect(renderMarkdown('# 一级')).toBe('<h3>一级</h3>')
    expect(renderMarkdown('#### 四级')).toBe('<h6>四级</h6>')
  })

  it('无序和有序列表', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>')
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>')
  })

  it('引用、分隔线、代码块', () => {
    expect(renderMarkdown('> 引用')).toBe('<blockquote>引用</blockquote>')
    expect(renderMarkdown('---')).toBe('<hr>')
    expect(renderMarkdown('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>')
  })

  it('段落内换行变 br，空行分段', () => {
    expect(renderMarkdown('一\n二\n\n三')).toBe('<p>一<br>二</p>\n<p>三</p>')
  })

  it('链接与裸链接', () => {
    expect(renderMarkdown('[文档](https://example.com/a)')).toContain('<a href="https://example.com/a">文档</a>')
    expect(renderMarkdown('见 https://example.com')).toContain('<a href="https://example.com">https://example.com</a>')
  })
})

describe('渲染器的安全性', () => {
  it('原始 HTML 一律转义', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('img onerror 这类注入不会变成标签', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  it('javascript: 和 data: 链接只留文字，不生成 href', () => {
    for (const bad of ['[点我](javascript:alert(1))', '[点我](data:text/html;base64,AAA)']) {
      const html = renderMarkdown(bad)
      expect(html).not.toContain('href')
      expect(html).toContain('点我')
    }
  })

  it('链接文字里的引号不会撑破属性', () => {
    expect(renderMarkdown('[a"onmouseover="x](https://e.com)')).not.toContain('onmouseover="x"')
  })
})

describe('摘要', () => {
  it('去掉标记压成一行', () => {
    expect(notePreview('# 标题\n\n- **要点**\n- 另一条')).toBe('标题 要点 另一条')
  })
  it('超长截断', () => {
    expect(notePreview('a'.repeat(100), 10)).toBe('aaaaaaaaaa…')
  })
})
