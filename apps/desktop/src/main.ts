import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, readRegistry, type Task } from '@kapibala/core'
import { nodeEnv, withLock } from '@kapibala/adapters-node'
import type { TaskDraftIpc, VaultState } from '@kapibala/ipc'

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
  if (r.canceled || !dir) return null
  try { return await openVault(dir, true) } catch { return await openVault(dir, false) }
}

async function boot(): Promise<Store | null> {
  const reg = await readRegistry(env)
  const entry = reg.vaults.find(v => v.id === reg.lastVaultId) ?? reg.vaults[0]
  if (!entry) return null
  try { return await openVault(entry.path) } catch { return null }
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

ipcMain.handle('vault:state', () => (store ? stateOf(store) : null))
ipcMain.handle('vault:pick', async () => { const s = await pickVault(); return s ? stateOf(s) : null })
ipcMain.handle('task:list', (): Task[] => store?.tasks() ?? [])
ipcMain.handle('task:create', (_e, d: TaskDraftIpc) => write(s => s.add(d)))
ipcMain.handle('task:setField', (_e, id: string, f: string, v: unknown) => write(s => s.setField(id, f, v)))
ipcMain.handle('task:complete', (_e, id: string) => write(s => s.complete(id).then(() => undefined)))
ipcMain.handle('task:uncomplete', (_e, id: string) => write(s => s.uncomplete(id)))
ipcMain.handle('task:trash', (_e, id: string) => write(s => s.trash(id)))
ipcMain.handle('task:restore', (_e, id: string) => write(s => s.restore(id)))

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
    if (!store) await pickVault()
    push()
    // 开发期自检钩子。打包后一律失效，不留在成品里
    if (!app.isPackaged) await selfTest(w)
  })
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})

app.on('window-all-closed', () => { watcher?.close(); app.quit() })
