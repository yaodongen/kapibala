// preview.mjs 的截图后端：用桌面版自带的 Electron 把预览页渲染成一张 png。
//
//   electron scripts/preview-shot.cjs <预览页.html> <出图.png> [宽度] [主题]
//
// 走的是真的 Chromium，所以 mermaid 是不是真能画出来，这里说了算 ——
// 页面自己渲染完会打上 body[data-preview-ready]，等这个标记比 sleep 靠谱。

const { app, BrowserWindow, nativeTheme } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const [htmlPath, pngPath, widthArg, theme] = process.argv.slice(2)
const width = Number(widthArg) || 1200
const MAX_HEIGHT = 12000 // 再高就超过 GPU 能截的上限了，长文档会被截断

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor(win, expr, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await win.webContents.executeJavaScript(`!!(${expr})`)) return true
    await sleep(100)
  }
  return false
}

app.whenReady().then(async () => {
  if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme

  const win = new BrowserWindow({ width, height: 1000, show: false, backgroundColor: theme === 'dark' ? '#0d1117' : '#ffffff' })

  // 页面里的 console.log 转出来（mermaid 的报错也在里面），但 [preview] 那行自己会打
  win.webContents.on('console-message', (...args) => {
    const msg = typeof args[1] === 'string' ? args[1] : args[0] && args[0].message
    if (msg && !msg.startsWith('[preview]')) console.log(msg)
  })

  await win.loadFile(htmlPath)

  const ready = await waitFor(win, 'document.body.dataset.previewReady === "1"', 30000)
  if (!ready) {
    const status = await win.webContents.executeJavaScript('JSON.stringify(window.__previewStatus || null)')
    console.error(`✗ 页面 30 秒还没渲染完，状态：${status}`)
    app.exit(1)
    return
  }

  // 整页截图：把窗口撑到文档高度再拍
  const height = Math.min(Math.ceil(await win.webContents.executeJavaScript('document.documentElement.scrollHeight')), MAX_HEIGHT)
  win.setContentSize(width, height)
  await sleep(400) // 等重排和图片落地

  mkdirSync(path.dirname(pngPath), { recursive: true })
  writeFileSync(pngPath, (await win.webContents.capturePage()).toPNG())

  // 页面自检的结果由这里拍板：mermaid 画不出来 = GitHub 上一样看不到
  const status = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__previewStatus)'))
  console.log(`  渲染结果：mermaid ${status.mermaid.ok} 张 · 代码块 ${status.code} 个 · 图片 ${status.images.ok} 张`)
  for (const [i, msg] of status.mermaid.failed.entries()) {
    console.error(`✗ 第 ${i + 1} 张 mermaid 画不出来（GitHub 上同样会显示不出来）：`)
    console.error(msg.split('\n').map(l => `    ${l}`).join('\n'))
  }
  if (status.images.broken.length) {
    console.error('✗ 这些图片没加载出来：')
    for (const src of status.images.broken) console.error(`    ${src}`)
  }
  app.exit(status.mermaid.failed.length || status.images.broken.length ? 1 : 0)
})
