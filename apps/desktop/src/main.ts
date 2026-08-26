import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, isNotDownloaded, readRegistry, type Task } from '@kapibala/core'
import { nodeEnv, placeholderOf, setNoteLogger, withLock } from '@kapibala/adapters-node'
import type { TaskDraftIpc, VaultState } from '@kapibala/ipc'
import { log, logPath, readLog } from './log.ts'

process.on('uncaughtException', e => log('error', '未捕获异常', e))
process.on('unhandledRejection', e => log('error', '未处理的 Promise 拒绝', e))

setNoteLogger((m, x) => log('info', m, x))
const env = nodeEnv()
let store: Store | null = null
let win: BrowserWindow | null = null
let watcher: FSWatcher | null = null

const stateOf = (s: Store): VaultState => ({
  name: s.vault.entry.name,
  path: s.vault.entry.path,
  deviceLabel: s.vault.device.label,
  readOnly: s.vault.readOnly,
  forked: s.vault.forked,
  health: s.health,
})

function push() {
  if (store && win && !win.isDestroyed()) win.webContents.send('tasks:changed', store.tasks())
}

/**
 * 同步目录里的文件可能处于中间状态，所以 300ms 防抖 + 忽略自己的目录
 * （自己的状态本来就在内存里）。见 storage.zh.md §6.4
 */
function watchVault(s: Store) {
  watcher?.close()
  const dir = join(s.vault.entry.path, 'devices')
  const mine = s.vault.device.deviceId
  let timer: NodeJS.Timeout | null = null
  try {
    watcher = watch(dir, { recursive: true }, (_e, name) => {
      if (name && name.includes(mine)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        try { await s.refresh(); push() } catch { /* 同步中的中间状态，下一次事件再试 */ }
      }, 300)
    })
  } catch { /* 目录还不存在，等第一次写入后再说 */ }
}

async function openVault(path: string, create = false): Promise<Store> {
  const s = await Store.open(env, path, create)
  store = s
  watchVault(s)
  return s
}

/** 首次启动：没有库就让用户选一个目录。空目录 = 新建，已有库 = 打开 */
async function pickVault(): Promise<Store | null> {
  const r = await dialog.showOpenDialog({
    title: '选择一个文件夹作为 Kapibala 库',
    message: '想在多台 Mac 之间同步，就选 iCloud Drive 里的目录',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用这个文件夹',
  })
  const dir = r.filePaths[0]
  log('info', '目录选择结果', { canceled: r.canceled, dir })
  if (r.canceled || !dir) return null
  // 先看有没有 meta.json 再决定"打开"还是"新建"，不要靠 try/catch 猜 ——
  // 猜错时两条路都会抛，用户只看到界面毫无反应
  // 第二台 Mac 上 meta.json 可能还是 iCloud 占位符，只看真实文件会误判成"新文件夹"，
  // 于是去建库、又因为目录里已有 devices/ 而失败
  const metaPath = join(dir, '.kapibala', 'meta.json')
  const isVault = existsSync(metaPath) || existsSync(placeholderOf(metaPath)) ||
                  existsSync(join(dir, '.kapibala'))
  log('info', isVault ? '打开已有库' : '在空目录里新建库', { dir })
  try {
    // 从 iCloud 同步过来的库，文件可能还没落地。自己重试，别让用户反复点
    let lastErr: unknown
    for (let i = 0; i < 8; i++) {
      try {
        const s = await openVault(dir, !isVault)
        log('info', '库已就绪', { path: s.vault.entry.path, device: s.vault.device.deviceId,
                                  readOnly: s.vault.readOnly, forked: s.vault.forked })
        return s
      } catch (err) {
        lastErr = err
        if (!isNotDownloaded(err)) throw err
        log('info', '库文件还没落地，等 2 秒重试', { attempt: i + 1 })
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    throw lastErr
  } catch (e) {
    // 把目录里到底有什么也记下来 —— 建库被拒时，答案通常就是一个 .DS_Store
    let entries: string[] = []
    try { entries = readdirSync(dir).slice(0, 12) } catch { /* 连列目录都不行 */ }
    log('error', '打开库失败', { dir, isVault, entries, error: String(e) })
    await dialog.showMessageBox({
      type: 'warning',
      message: '这个文件夹不能用作库',
      detail: (e as Error).message,
      buttons: ['好'],
    })
    return null
  }
}

async function boot(): Promise<Store | null> {
  log('info', '启动', { version: app.getVersion(), packaged: app.isPackaged, arch: process.arch })
  const reg = await readRegistry(env)
  const entry = reg.vaults.find(v => v.id === reg.lastVaultId) ?? reg.vaults[0]
  if (!entry) { log('info', '还没有库，显示引导页'); return null }
  try { return await openVault(entry.path) }
  catch (e) { log('error', '打开上次的库失败', { path: entry.path, e: String(e) }); return null }
}

function need(): Store {
  if (!store) throw new Error('还没有打开任何库')
  if (store.vault.readOnly) throw new Error('这个库的格式比当前版本新，已按只读打开')
  return store
}
const write = <T,>(fn: (s: Store) => Promise<T>) => {
  const s = need()
  return withLock(s.vault.entry.id, () => fn(s)).then(r => { push(); return r })
}

/** 包一层：任何 IPC 失败都落盘，否则用户只会说"点了没反应" */
const handle = (ch: string, fn: (...a: never[]) => unknown) =>
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return await (fn as (...a: unknown[]) => unknown)(...args) }
    catch (e) { log('error', `IPC ${ch} 失败`, e); throw e }
  })

handle('task:menu', (id: string) => {
  const t = store?.task(id)
  if (!t || !win) return
  const items: Electron.MenuItemConstructorOptions[] = t.deleted
    ? [
        { label: '恢复', click: () => void write(s => s.restore(id)) },
        { type: 'separator' },
        { label: '彻底删除', click: () => void write(s => s.purge(id)) },
      ]
    : [
        { label: t.completedAt ? '标记为未完成' : '完成',
          click: () => void write(s => (t.completedAt ? s.uncomplete(id) : s.complete(id).then(() => undefined))) },
        { type: 'separator' },
        { label: '删除', click: () => void write(s => s.trash(id)) },
      ]
  log('info', '打开任务右键菜单', { id, deleted: t.deleted })
  Menu.buildFromTemplate(items).popup({ window: win })
})

handle('vault:list', async () => {
  const reg = await readRegistry(env)
  return reg.vaults
    .map(v => ({ id: v.id, name: v.name, path: v.path,
                 current: v.id === store?.vault.entry.id,
                 available: existsSync(v.path) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
})

handle('vault:open', async (id: string) => {
  const reg = await readRegistry(env)
  const entry = reg.vaults.find(v => v.id === id)
  if (!entry) throw new Error('这个库已经不在列表里了')
  log('info', '切换库', { from: store?.vault.entry.path, to: entry.path })
  const s = await openVault(entry.path)   // openVault 内部会把它记为 lastVaultId
  push()
  return stateOf(s)
})

handle('log:read', () => ({ text: readLog(), path: logPath() }))
handle('log:copy', () => { clipboard.writeText(readLog()) })
handle('log:reveal', () => { shell.showItemInFolder(logPath()) })
handle('log:renderer', (msg: string) => { log('error', `渲染进程：${msg}`) })

ipcMain.handle('vault:state', () => (store ? stateOf(store) : null))
handle('vault:pick', async () => { const s = await pickVault(); return s ? stateOf(s) : null })
handle('task:list', (): Task[] => store?.tasks() ?? [])
handle('task:create', (d: TaskDraftIpc) => write(s => s.add(d)))
handle('task:setField', (id: string, f: string, v: unknown) => write(s => s.setField(id, f, v)))
handle('task:complete', (id: string) => write(s => s.complete(id).then(() => undefined)))
handle('task:uncomplete', (id: string) => write(s => s.uncomplete(id)))
handle('task:trash', (id: string) => write(s => s.trash(id)))
handle('task:restore', (id: string) => write(s => s.restore(id)))

/**
 * 开发期自检：
 *   KAPI_EVAL="await window.kapi['task:create']({title:'x'})"  在渲染进程里跑一段
 *   KAPI_SCREENSHOT=out.png                                     截图后退出
 * 两个都只在未打包时生效。
 */
async function selfTest(w: BrowserWindow) {
  const evalCode = process.env['KAPI_EVAL']
  if (evalCode) {
    try { console.log('KAPI_EVAL →', await w.webContents.executeJavaScript(`(async()=>{${evalCode}})()`, true)) }
    catch (e) { console.error('KAPI_EVAL 失败：', e) }
  }
  const shot = process.env['KAPI_SCREENSHOT']
  if (shot) {
    await new Promise(r => setTimeout(r, 700))
    await writeFile(shot, (await w.webContents.capturePage()).toPNG())
  }
  if (evalCode || shot) app.quit()
}

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 640, minWidth: 640, minHeight: 420,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7eee0',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,      // 渲染进程零 fs 权限，见 architecture.zh.md §5
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.loadFile(join(__dirname, 'renderer/index.html'))
  return win
}

app.whenReady().then(async () => {
  await boot()
  const w = createWindow()
  w.webContents.once('did-finish-load', async () => {
    // 没有库时不要直接弹系统对话框 —— 用户还不知道这个文件夹是干什么的。
    // 渲染进程会显示引导页，由用户点按钮再触发 vault:pick
    push()
    // 开发期自检钩子。打包后一律失效，不留在成品里
    if (!app.isPackaged) await selfTest(w)
  })
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})

app.on('window-all-closed', () => { watcher?.close(); app.quit() })
