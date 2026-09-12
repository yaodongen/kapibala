#!/usr/bin/env node
/**
 * 在本地模拟 GitHub 的渲染效果，push 之前先看一眼。
 *
 *   make preview                       渲染 README + docs/*.md，并用浏览器打开
 *   node scripts/preview.mjs README.zh.md
 *   node scripts/preview.mjs README.zh.md --shot /tmp/a.png    不开浏览器，直接出图
 *
 * 管线是照着 GitHub 抄的：
 *   - marked 把 GFM 转成 HTML（表格、任务列表、删除线都对）
 *   - github-markdown-css 当正文样式，浅色 / 深色 / 跟随系统三种都有
 *   - mermaid 负责 ```mermaid 代码块 —— GitHub 也是浏览器端渲染，
 *     所以这里语法错了，GitHub 上同样是那句 "Unable to render rich display"
 *   - highlight.js 负责代码块高亮
 *
 * 这些依赖缓存在 node_modules/.cache/kapibala-preview/ 里（跟着 node_modules 一起被
 * gitignore），第一次跑要联网下载，之后离线可用。加 --refresh 强制重新下载。
 *
 * 产物是一堆静态 HTML，不起服务器：图片在生成时就改成了绝对 file:// 路径，
 * 文档之间指向别的 md 的链接改指到那篇的预览页，所以双击也能用。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(REPO, 'node_modules/.cache/kapibala-preview')
const ELECTRON = path.join(REPO, 'apps/desktop/node_modules/.bin/electron')
const CSS = 'https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1'
const HLJS = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1'

/** 版本都钉死：预览效果哪天变了，是这次改动带来的，不是 CDN 偷偷升级 */
const ASSETS = [
  ['github-markdown.css', `${CSS}/github-markdown.css`],
  ['github-markdown-light.css', `${CSS}/github-markdown-light.css`],
  ['github-markdown-dark.css', `${CSS}/github-markdown-dark.css`],
  ['hljs.min.js', `${HLJS}/highlight.min.js`],
  ['hljs-github.min.css', `${HLJS}/styles/github.min.css`],
  ['hljs-github-dark.min.css', `${HLJS}/styles/github-dark.min.css`],
  ['mermaid.min.js', 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js'],
  ['marked.esm.mjs', 'https://cdn.jsdelivr.net/npm/marked@15.0.7/lib/marked.esm.js'],
]

// ─────────────────────────────────────────────────────────────
//  参数
// ─────────────────────────────────────────────────────────────

const USAGE = `
用法：node scripts/preview.mjs [文件…] [选项]

不给文件时渲染 README.md、README.zh.md 和 docs/*.md。

  --shot <png>        不开浏览器，用桌面版自带的 Electron 渲染成一张图
  --out <dir>         产物目录（默认 node_modules/.cache/kapibala-preview）
  --width <px>        截图宽度，默认 1200（只对 --shot 有意义）
  --theme <t>         auto | light | dark，默认 auto（跟随系统）
  --no-open           只生成，不打开浏览器
  --refresh           重新下载 marked / mermaid / GitHub 的 CSS
  -h, --help          看这段
`.trim()

const opts = { files: [], open: true, shot: null, out: DEFAULT_OUT, width: 1200, theme: 'auto', refresh: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    const v = argv[++i]
    if (v === undefined || v.startsWith('--')) fail(`${a} 后面要跟一个值`)
    return v
  }
  if (a === '--shot') { opts.shot = path.resolve(val()); opts.open = false }
  else if (a === '--out') opts.out = path.resolve(val())
  else if (a === '--width') opts.width = Number(val())
  else if (a === '--theme') opts.theme = val()
  else if (a === '--no-open') opts.open = false
  else if (a === '--refresh') opts.refresh = true
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0) }
  else if (a.startsWith('-')) fail(`不认识的参数：${a}\n\n${USAGE}`)
  else opts.files.push(a)
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!['auto', 'light', 'dark'].includes(opts.theme)) fail(`--theme 只认 auto / light / dark，收到 ${opts.theme}`)
if (!Number.isFinite(opts.width) || opts.width < 320) fail(`--width 得是一个不小于 320 的数字`)

const say = (msg) => console.log(`→ ${msg}`)

// ─────────────────────────────────────────────────────────────
//  依赖：下载一次，之后离线可用
// ─────────────────────────────────────────────────────────────

async function ensureAssets() {
  const dir = path.join(opts.out, 'assets')
  await mkdir(dir, { recursive: true })
  for (const [file, url] of ASSETS) {
    const dest = path.join(dir, file)
    if (!opts.refresh && existsSync(dest) && (await stat(dest)).size > 0) continue
    say(`下载 ${file}`)
    let res
    try {
      res = await fetch(url)
    } catch (e) {
      fail(`${file} 下载失败（${e.message}）。第一次跑要联网；离线时留着 node_modules/.cache 就行`)
    }
    if (!res.ok) fail(`${file} 下载失败：HTTP ${res.status} ${url}`)
    await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  }
  return dir
}

// ─────────────────────────────────────────────────────────────
//  markdown → HTML
// ─────────────────────────────────────────────────────────────

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function loadMarked(assetDir) {
  const mod = await import(pathToFileURL(path.join(assetDir, 'marked.esm.mjs')).href)
  const marked = mod.marked ?? mod.default
  marked.use({
    gfm: true,
    // ```mermaid 不能当代码块渲染，要交给 mermaid 自己画
    renderer: {
      code(token) {
        const lang = String(token.lang || '').trim().split(/\s+/)[0].toLowerCase()
        if (lang !== 'mermaid') return false // 交回默认渲染
        return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`
      },
    },
  })
  return marked
}

/**
 * 相对路径改绝对 file://：产物在 node_modules/.cache 下面，仓库里的图片得指回去。
 * 指向别的 md 的链接，改成那篇文档的预览页（目录结构是照仓库镜像的，只换后缀）。
 * 带 scheme 的（http/https/mailto/data）和页内锚点原样不动。
 */
function rewriteUrls(html, fromFile, previews) {
  const fromDir = path.dirname(fromFile)
  return html.replace(/(\s(?:src|href)=")([^"]*)(")/g, (whole, head, url, tail) => {
    if (url === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return whole
    const hash = url.match(/#.*$/)?.[0] ?? ''
    const bare = url.slice(0, url.length - hash.length)
    let abs
    try {
      abs = path.resolve(fromDir, decodeURIComponent(bare))
    } catch {
      return whole // % 后面不是合法转义，原样留着
    }
    if (!abs.startsWith(REPO + path.sep)) return whole
    if (bare.toLowerCase().endsWith('.md')) {
      const rel = path.relative(REPO, abs)
      if (previews.has(rel)) return head + bare + '.html' + hash + tail
    }
    return head + pathToFileURL(abs).href + hash + tail
  })
}

/** 页面里的自检：mermaid 能不能画、图片加载没有、代码块高亮了几块 */
const PAGE_SCRIPT = `
(async () => {
  const status = (window.__previewStatus = { mermaid: { ok: 0, failed: [] }, code: 0, images: { ok: 0, broken: [] } })
  const verdict = document.getElementById('preview-verdict')

  document.querySelectorAll('pre code[class*="language-"]').forEach(el => {
    try { hljs.highlightElement(el); status.code++ } catch (e) {}
  })

  // mermaid：GitHub 也是浏览器端渲染，所以语法错误在这里就能提前看到
  const blocks = [...document.querySelectorAll('pre.mermaid')]
  if (blocks.length) {
    const forced = document.documentElement.dataset.theme
    const dark = forced === 'dark' || (forced !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' })
    for (const node of blocks) {
      const src = node.textContent
      try {
        await mermaid.parse(src)
        await mermaid.run({ nodes: [node] })
        status.mermaid.ok++
      } catch (e) {
        const msg = (e && (e.str || e.message)) || String(e)
        status.mermaid.failed.push(msg)
        const box = document.createElement('pre')
        box.className = 'mermaid-error'
        box.textContent = 'mermaid 渲染失败：\\n' + msg + '\\n\\n' + src
        node.replaceWith(box)
      }
    }
  }

  const imgs = [...document.images]
  await Promise.all(imgs.map(im => im.complete ? null : new Promise(r => { im.onload = im.onerror = r })))
  imgs.forEach(im => im.naturalWidth ? status.images.ok++ : status.images.broken.push(im.getAttribute('src')))

  const bad = status.mermaid.failed.length + status.images.broken.length
  verdict.className = 'verdict ' + (bad ? 'bad' : 'good')
  verdict.textContent = bad
    ? '✗ mermaid 失败 ' + status.mermaid.failed.length + ' · 图片没加载 ' + status.images.broken.length
    : '✓ mermaid ' + status.mermaid.ok + ' · 代码块 ' + status.code + ' · 图片 ' + status.images.ok

  document.body.dataset.previewReady = '1'
  console.log('[preview] ' + JSON.stringify(status))
})()
`

/** 强制浅色 / 深色时用对应的那套 CSS；auto 用带 media query 的合并版 */
function themeCss(theme) {
  const md = theme === 'auto' ? 'github-markdown' : `github-markdown-${theme}`
  const hljs = theme === 'auto'
    ? `<link rel="stylesheet" href="{{A}}/hljs-github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="{{A}}/hljs-github-dark.min.css" media="(prefers-color-scheme: dark)">`
    : `<link rel="stylesheet" href="{{A}}/hljs-github${theme === 'dark' ? '-dark' : ''}.min.css">`
  return { md, hljs }
}

function shell(title, relAsset, body, theme) {
  const { md, hljs } = themeCss(theme)
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 本地预览</title>
<link rel="stylesheet" href="${relAsset}/${md}.css">
${hljs.replaceAll('{{A}}', relAsset)}
<style>
  :root { --page-bg:#ffffff; --bar-bg:#f6f8fa; --bar-fg:#59636e; --bar-border:#d1d9e0; color-scheme: light dark }
  @media (prefers-color-scheme: dark) { :root { --page-bg:#0d1117; --bar-bg:#151b23; --bar-fg:#9198a1; --bar-border:#3d444d } }
  html[data-theme="light"] { --page-bg:#ffffff; --bar-bg:#f6f8fa; --bar-fg:#59636e; --bar-border:#d1d9e0; color-scheme: light }
  html[data-theme="dark"] { --page-bg:#0d1117; --bar-bg:#151b23; --bar-fg:#9198a1; --bar-border:#3d444d; color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; background:var(--page-bg) }
  .preview-bar { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:10px;
    padding:8px 24px; background:var(--bar-bg); border-bottom:1px solid var(--bar-border); color:var(--bar-fg);
    font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
  .preview-bar b { font-weight:600 }
  .preview-bar .spacer { flex:1 }
  .verdict { font-variant-numeric:tabular-nums }
  .verdict.good { color:#1a7f37 } .verdict.bad { color:#d1242f; font-weight:600 }
  .markdown-body { max-width:1012px; margin:0 auto; padding:32px 40px 96px }
  pre.mermaid { text-align:center }
  .mermaid-error { color:#d1242f; background:#fff5f5; border:1px solid #ffc9c9; border-radius:6px;
    padding:12px 16px; overflow:auto; white-space:pre-wrap;
    font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
  @media (prefers-color-scheme: dark) {
    .verdict.good { color:#3fb950 } .verdict.bad { color:#f85149 }
    .mermaid-error { color:#f85149; background:#2d1214; border-color:#6e2b2f }
  }
  html[data-theme="dark"] .verdict.good { color:#3fb950 } html[data-theme="dark"] .verdict.bad { color:#f85149 }
  html[data-theme="dark"] .mermaid-error { color:#f85149; background:#2d1214; border-color:#6e2b2f }
  html[data-theme="light"] .verdict.good { color:#1a7f37 } html[data-theme="light"] .verdict.bad { color:#d1242f }
  html[data-theme="light"] .mermaid-error { color:#d1242f; background:#fff5f5; border-color:#ffc9c9 }
</style>
</head>
<body>
<header class="preview-bar">
  <b>Kapibala</b>
  <span>本地预览 · 模拟 GitHub 渲染</span>
  <span>|</span>
  <span>${escapeHtml(title)}</span>
  <span class="spacer"></span>
  <span id="preview-verdict" class="verdict">渲染中…</span>
</header>
<article class="markdown-body">
${body}</article>
<script src="${relAsset}/mermaid.min.js"></script>
<script src="${relAsset}/hljs.min.js"></script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`
}

// ─────────────────────────────────────────────────────────────
//  主流程
// ─────────────────────────────────────────────────────────────

async function defaultFiles() {
  const docs = await readdir(path.join(REPO, 'docs'), { withFileTypes: true })
  return [
    'README.md',
    'README.zh.md',
    ...docs.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => `docs/${e.name}`).sort(),
  ]
}

/** 要渲染哪些文件（仓库相对路径，排序稳定） */
async function pickFiles() {
  const list = opts.files.length ? opts.files : await defaultFiles()
  return list.map(f => {
    const abs = path.resolve(REPO, f)
    if (!abs.startsWith(REPO + path.sep)) fail(`${f} 不在仓库里`)
    if (!existsSync(abs)) fail(`找不到 ${f}`)
    if (!abs.endsWith('.md')) fail(`${f} 不是 markdown 文件`)
    return path.relative(REPO, abs)
  }).sort()
}

async function main() {
  const files = await pickFiles()
  if (opts.shot && files.length !== 1) {
    fail(`--shot 一次只能出一张图（现在给了 ${files.length} 个文件）。指定一个文件，例如：\n` +
         `    node scripts/preview.mjs README.zh.md --shot /tmp/a.png`)
  }

  const assetDir = await ensureAssets()
  const marked = await loadMarked(assetDir)
  const previews = new Set(files)
  const written = []

  for (const rel of files) {
    const abs = path.join(REPO, rel)
    const htmlPath = path.join(opts.out, rel + '.html')
    await mkdir(path.dirname(htmlPath), { recursive: true })
    const md = await readFile(abs, 'utf8')
    const body = rewriteUrls(await marked.parse(md), abs, previews)
    // 产物是照仓库镜像的，截图 / CSS 在上一层的 assets 里
    const relAsset = path.relative(path.dirname(htmlPath), assetDir).split(path.sep).join('/')
    await writeFile(htmlPath, shell(rel, relAsset, body, opts.theme))
    say(`渲染 ${rel}`)
    written.push(htmlPath)
  }

  console.log('')
  say(`产物目录 ${opts.out}（主题 ${opts.theme}）`)

  if (opts.shot) {
    if (!existsSync(ELECTRON)) fail(`没有 Electron（${ELECTRON}）。先跑 make install`)
    say(`截图中（${opts.width}px 宽，用桌面版自带的 Electron）`)
    const code = await run(ELECTRON, [
      path.join(REPO, 'scripts/preview-shot.cjs'), written[0], opts.shot, String(opts.width), opts.theme,
    ])
    if (!existsSync(opts.shot)) fail(`截图失败（退出码 ${code}）`)
    say(`${opts.shot}（${((await stat(opts.shot)).size / 1024).toFixed(0)} KB）`)
    if (code !== 0) process.exitCode = 1 // 图出来了，但页面里有渲染失败的东西，上面已经报过
    return
  }

  if (opts.open) {
    say('打开浏览器')
    spawn('open', [written[0]], { stdio: 'ignore', detached: true }).unref()
    console.log('')
    console.log('  改完 markdown 重新跑一次这条命令就行（页面要自己刷新一下）')
    console.log('  mermaid 画不出来会在页面上标红，右上角那行汇总写了图 / 代码块 / 图片的数量')
  }
}

function run(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('exit', c => resolve(c ?? 1))
    child.on('error', e => { console.error(`✗ 起不来：${e.message}`); resolve(1) })
  })
}

main().catch(e => fail(e?.stack ?? String(e)))
