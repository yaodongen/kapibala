import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell, Tray } from 'electron'
import { existsSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, isNotDownloaded, readRegistry, writeRegistry, type Task } from '@kapibala/core'
import { nodeEnv, placeholderOf, setNoteLogger, withLock } from '@kapibala/adapters-node'
import { DEFAULT_DETAIL_WIDTH, isRestorableView, isViewId, isWinSlot, platformOf, viewSlot, PLATFORM_ARG,
         type FieldOpIpc, type TaskDraftIpc, type Theme, type VaultState, type ViewId, type WinSlot } from '@kapibala/ipc'
import { isLang, langOf, t, type Lang } from './i18n.ts'
import { log, logPath, readLog } from './log.ts'

process.on('uncaughtException', e => log('error', '未捕获异常', e))
process.on('unhandledRejection', e => log('error', '未处理的 Promise 拒绝', e))

setNoteLogger((m, x) => log('info', m, x))
const env = nodeEnv()
/**
 * 运行平台。整个应用只在这里判定一次，渲染进程那份也是从这里递过去的
 * （见 createWindow 的 additionalArguments）—— 新功能要分平台，用这个 `isMac`，
 * 别再去读 process.platform，两边各判一次迟早会对不上。
 *
 * KAPIBALA_OS 只在未打包时认，作用是在 Mac 上把 Windows 那条分支整条跑一遍
 * （托盘、标题栏、单实例锁、关窗口收进托盘，连 CSS 一起）—— 不然那半边只能靠读。
 * 和 KAPIBALA_USER_DATA / KAPIBALA_LANG 是一路货，打包后一律忽略：
 * 成品不该被一个环境变量骗到别的平台上去。
 */
const PLATFORM = platformOf(process.platform, app.isPackaged ? undefined : process.env['KAPIBALA_OS'])
const isMac = PLATFORM === 'darwin'
let store: Store | null = null
let win: BrowserWindow | null = null
let watcher: FSWatcher | null = null
/** macOS 之外的平台用托盘兜底，见 refreshAppMenus() */
let tray: Tray | null = null
/** 托盘提示只弹一次，别每次收窗口都烦用户 */
let trayHinted = false
/** 关窗口只是收起来，真退出得走 Dock 图标右键的"退出"或 ⌘Q。这个标记区分两者 */
let quitting = false

/**
 * 界面状态（比如上次选中哪条任务）单独存一份，不塞进 vaults.json ——
 * 那个文件是和 CLI 共享的库注册表，别混进界面的东西。
 */
const uiFile = () => `${env.userDataDir}/ui.json`
type UiState = {
  lastTask?: Record<string, string>
  lang?: Lang
  theme?: Theme
  detailWidth?: number
  /** 日历视图是否显示"当天已完成"的任务。没存过 = 关 */
  showDone?: boolean
  /** 左右两侧栏收起没有。没存过 = 都不收（完整三栏） */
  sidebarCollapsed?: boolean
  detailCollapsed?: boolean
  /** 上次停在哪个列表，打开就回到那一屏。已完成 / 垃圾桶不记（见 ipc 的 RESTORABLE_VIEWS） */
  view?: ViewId
  /** 每个视图分组各记一套窗口大小（宽、高）。见 ipc 里的 WinSlot */
  winSize?: Partial<Record<WinSlot, [number, number]>>
}
function readUi(): UiState {
  try { return JSON.parse(readFileSync(uiFile(), 'utf8')) as UiState } catch { return {} }
}
function writeUi(ui: UiState) {
  try { writeFileSync(uiFile(), JSON.stringify(ui, null, 2) + '\n') } catch (e) { log('error', '写界面状态失败', e) }
}

/* ── 窗口大小：按视图分组记 ──
 * 日历铺的是格子，要的地方和列表不一样，所以 7d / 14d 各记一套，其余视图共用一份。
 * 切视图时主进程负责"先存旧的、再套新的"，用户手动拖的窗口大小按当前那一屏落盘。
 */
/** 窗口的最小尺寸，和建窗口时的 minWidth/minHeight 是一个数 */
const MIN_W = 820, MIN_H = 420
/** 默认大小。216 侧栏 + 554 列表 + 340 备注 */
const DEFAULT_W = 1110, DEFAULT_H = 640
/** 当前窗口大小算哪一屏的。切视图时更新，窗口被拖动时按它落盘 */
let winSlot: WinSlot = 'other'
let winSaveTimer: NodeJS.Timeout | null = null

/** 把尺寸夹进"最小尺寸 ~ 当前屏幕可用区域"：记下来的值可能来自更大的屏幕 */
function fitToScreen(w: number, h: number, bounds?: Electron.Rectangle): [number, number] {
  const area = (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workAreaSize
  return [Math.max(MIN_W, Math.min(Math.round(w), area.width)),
          Math.max(MIN_H, Math.min(Math.round(h), area.height))]
}

/** 把当前窗口大小记到 winSlot 那一屏。最大化/全屏时取的是"正常状态"的尺寸 */
function rememberWinSize() {
  if (!win || win.isDestroyed()) return
  const { width, height } = win.getNormalBounds()
  const ui = readUi()
  writeUi({ ...ui, winSize: { ...ui.winSize, [winSlot]: [width, height] } })
}

/**
 * 切到 to 那一屏：先把当前大小记到离开的那一屏，再套上 to 记过的大小。
 * 位置尽量不动，但放大后不能顶出屏幕 —— 贴边时往回挪一点，别让标题栏跑到屏幕外。
 */
function switchWinSlot(to: WinSlot): [number, number] | null {
  if (winSaveTimer) { clearTimeout(winSaveTimer); winSaveTimer = null }
  rememberWinSize()
  winSlot = to
  const saved = readUi().winSize?.[to]
  if (!saved || !win || win.isDestroyed()) return null
  const b = win.getBounds()
  const area = screen.getDisplayMatching(b).workArea
  const [w, h] = fitToScreen(saved[0], saved[1], b)
  win.setBounds({
    x: Math.max(area.x, Math.min(b.x, area.x + area.width - w)),
    y: Math.max(area.y, Math.min(b.y, area.y + area.height - h)),
    width: w, height: h,
  })
  return [w, h]
}

/**
 * 系统语言。用 getPreferredSystemLanguages() / getSystemLocale()，不用 getLocale()：
 * 后者是 Chromium 的界面语言，缺少对应语言包时会谎报成 en-US
 * （实测 --lang=fr-FR 就返回 en-US），法语系统会因此拿到英文界面。
 */
function systemLang(): Lang {
  const preferred = app.getPreferredSystemLanguages()
  return langOf(preferred[0] ?? app.getSystemLocale())
}

/**
 * 界面语言：改过就听改过的，没改过就跟系统走。
 * 存在 ui.json 里 —— 这是本机的偏好，不该跟着 iCloud 同步到别人的 Mac 上。
 * KAPIBALA_LANG 只为测试和截图而存在，和 KAPIBALA_USER_DATA 是一路货。
 */
function lang(): Lang {
  const forced = process.env['KAPIBALA_LANG']
  if (isLang(forced)) return forced
  const saved = readUi().lang
  return isLang(saved) ? saved : systemLang()
}
const S = () => t(lang())

/**
 * 界面主题。
 *
 * 偏好存在 ui.json 里（和语言一样，是本机状态，不进库目录、不跟着 iCloud 走）。
 * 没存过 = 跟系统：把 nativeTheme.themeSource 设成 'system'，渲染进程那边的
 * `prefers-color-scheme` 媒体查询自己会跟着变，不用给 HTML 塞 data-theme。
 * 手动切过就以存下来的为准 —— 开关只有亮/暗两档，"跟系统"是没碰过开关时的默认。
 */
const isTheme = (x: unknown): x is Theme => x === 'light' || x === 'dark'
function themePref(): Theme | 'system' {
  const saved = readUi().theme
  return isTheme(saved) ? saved : 'system'
}
/** 当前**生效**的亮/暗。跟系统时由 nativeTheme 解析 */
const effectiveTheme = (): Theme => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
/** 窗口还没画出页面时的底色，跟 index.html 里的 --bg 对上，免得启动闪一下 */
const windowBg = () => effectiveTheme() === 'dark' ? '#1e1e20' : '#f7eee0'

/**
 * Windows 右上角那三个窗口按钮（最小化/最大化/关闭）是系统画的 Window Controls Overlay，
 * 它连**整条 34px 的标题带**一起上色，所以颜色要取主区底色 —— 三栏里它占的面积最大，
 * 侧边栏那 216px 差一档（#f5f5f7 vs #fff）几乎看不出来。高度和 index.html 里那条
 * 可拖动区对齐，页面正是按 34px 留的白。
 */
const overlayOpts = (): Electron.TitleBarOverlay => ({
  color: windowBg(),
  symbolColor: effectiveTheme() === 'dark' ? '#f2f2f4' : '#1d1d1f',
  height: 34,
})

function applyTheme() {
  nativeTheme.themeSource = themePref()
}

const stateOf = (s: Store): VaultState => ({
  id: s.vault.entry.id,
  lastTask: readUi().lastTask?.[s.vault.entry.id],
  name: s.vault.entry.name,
  path: s.vault.entry.path,
  deviceLabel: s.vault.device.label,
  readOnly: s.vault.readOnly,
  forked: s.vault.forked,
  health: s.health,
})

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('tasks:changed', store?.tasks() ?? [])
}

/** 正在读别的设备的改动。界面收到 true 就挡住编辑，收到 false 放开 */
function syncBusy(busy: boolean) {
  if (win && !win.isDestroyed()) win.webContents.send('sync:busy', busy)
}

/**
 * 系统外观变了，或者我们自己刚改过 themeSource。渲染进程那边 CSS 靠
 * `prefers-color-scheme` 自己就刷了，这里推的是**开关的状态**，外加窗口底色
 * （页面还没画出来的那一帧才看得见）。
 */
nativeTheme.on('updated', () => {
  win?.setBackgroundColor(windowBg())
  // Windows 的标题带是系统画的，颜色得我们自己跟着主题改一次
  if (!isMac && win && !win.isDestroyed()) win.setTitleBarOverlay(overlayOpts())
  if (win && !win.isDestroyed()) win.webContents.send('theme:changed', effectiveTheme())
})

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
        // 读盘期间挡住编辑：这一刻界面上的任务是旧的，改了会白改（字段级 LWW 下
        // 甚至可能被对面更晚的写覆盖）。读完立刻放开
        syncBusy(true)
        const t0 = Date.now()
        try { await s.refresh(); push() }
        catch { /* 同步中的中间状态，下一次事件再试 */ }
        finally {
          syncBusy(false)
          log('info', '读取了别的设备的改动', { ms: Date.now() - t0, tasks: store?.tasks().length })
        }
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
  const s = S()
  const r = await dialog.showOpenDialog({
    title: s.pickTitle,
    message: s.pickMessage,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: s.pickButton,
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
        const opened = await openVault(dir, !isVault)
        log('info', '库已就绪', { path: opened.vault.entry.path, device: opened.vault.device.deviceId,
                                  readOnly: opened.vault.readOnly, forked: opened.vault.forked })
        return opened
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
      message: s.pickFailed,
      detail: (e as Error).message,
      buttons: [s.ok],
    })
    return null
  }
}

async function boot(): Promise<Store | null> {
  // 语言相关的三个值都记下来：用户说"界面语言不对"时，这一行就是答案
  log('info', '启动', { version: app.getVersion(), packaged: app.isPackaged, arch: process.arch,
                        lang: lang(), systemLocale: app.getSystemLocale(),
                        preferred: app.getPreferredSystemLanguages() })
  const reg = await readRegistry(env)
  const entry = reg.vaults.find(v => v.id === reg.lastVaultId) ?? reg.vaults[0]
  if (!entry) { log('info', '还没有库，显示引导页'); return null }
  try { return await openVault(entry.path) }
  catch (e) { log('error', '打开上次的库失败', { path: entry.path, e: String(e) }); return null }
}

function need(): Store {
  if (!store) throw new Error(S().errNoVault)
  if (store.vault.readOnly) throw new Error(S().bannerReadOnly)
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

handle('vault:forget', async (id: string) => {
  const reg = await readRegistry(env)
  const gone = reg.vaults.find(v => v.id === id)
  if (!gone) throw new Error(S().errVaultGone)
  reg.vaults = reg.vaults.filter(v => v.id !== id)
  const wasCurrent = store?.vault.entry.id === id
  reg.lastVaultId = wasCurrent ? reg.vaults[0]?.id : reg.lastVaultId
  await writeRegistry(env, reg)
  // 只动注册表。目录和里面的任务一个字节都不碰
  log('info', '从列表移出库（不删目录）', { path: gone.path, wasCurrent })

  if (!wasCurrent) return store ? stateOf(store) : null
  watcher?.close(); watcher = null
  store = null
  const next = reg.vaults[0]
  if (next) {
    try { const s = await openVault(next.path); push(); return stateOf(s) }
    catch (e) { log('error', '移出后打开下一个库失败', e) }
  }
  push()                                  // 没有库了，让界面回到引导页
  return null
})

handle('task:menu', (id: string) => {
  const t = store?.task(id)
  if (!t || !win) return
  const L = S()
  const items: Electron.MenuItemConstructorOptions[] = t.deleted
    ? [
        { label: L.menuRestore, click: () => void write(s => s.restore(id)) },
        { type: 'separator' },
        { label: L.menuPurge, click: () => void write(s => s.purge(id)) },
      ]
    : [
        // 非删除那一支只有这几项：备注在详情栏写、完成在列表的圆圈上点，
        // 同一个动作不留第二个入口 —— 右键菜单只放任务自己的属性和删除
        // 「重要」是任务自己的属性（周期任务派生下一个实例时继承它），和"进行中"那种
        // 临时状态不是一回事，所以放在最前面
        { label: t.important ? L.menuUnimportant : L.menuImportant,
          click: () => void write(s => s.setField(id, 'important', !t.important)) },
        { label: t.inProgress ? L.unmarkInProgress : L.menuInProgress,
          click: () => void write(s => s.setField(id, 'inProgress', !t.inProgress)) },
        { type: 'separator' },
        { label: L.menuDelete, click: () => void write(s => s.trash(id)) },
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
  if (!entry) throw new Error(S().errVaultGone)
  log('info', '切换库', { from: store?.vault.entry.path, to: entry.path })
  const s = await openVault(entry.path)   // openVault 内部会把它记为 lastVaultId
  push()
  return stateOf(s)
})

handle('ui:lastTask', (taskId: string) => {
  if (!store) return
  const ui = readUi()
  writeUi({ ...ui, lastTask: { ...ui.lastTask, [store.vault.entry.id]: taskId } })
})

handle('ui:lang', () => lang())
handle('ui:setLang', (next: Lang) => {
  if (!isLang(next)) throw new Error(`不认识的语言：${String(next)}`)
  writeUi({ ...readUi(), lang: next })
  refreshAppMenus()                       // Dock 菜单 / 托盘菜单是启动时建好的，语言变了要重建
  log('info', '切换界面语言', { lang: next })
  return next
})

handle('ui:theme', () => effectiveTheme())
handle('ui:setTheme', (next: Theme) => {
  if (!isTheme(next)) throw new Error(`不认识的主题：${String(next)}`)
  writeUi({ ...readUi(), theme: next })
  applyTheme()                            // 生效后的 'updated' 事件会推给界面、顺便改窗口底色
  log('info', '切换界面主题', { theme: next })
  return next                             // 刚强制过，别去赌 shouldUseDarkColors 刷没刷新
})

handle('ui:detailWidth', () => readUi().detailWidth ?? DEFAULT_DETAIL_WIDTH)
handle('ui:setDetailWidth', (w: number) => {
  const n = Math.round(Number(w))
  if (!Number.isFinite(n)) throw new Error(`不认识的详情栏宽度：${String(w)}`)
  // 渲染进程拖的时候已经夹过一次（最小 260、最大不超过窗口的 60%）。这里只兜个底：
  // 脏值一旦写进 ui.json，下次启动就会拿它当初始宽度，那比这一次拖歪更难受
  const width = Math.min(2000, Math.max(200, n))
  writeUi({ ...readUi(), detailWidth: width })
  return width
})

handle('ui:showDone', () => readUi().showDone === true)
handle('ui:setShowDone', (on: boolean) => {
  if (typeof on !== 'boolean') throw new Error(`不认识的开关值：${String(on)}`)
  writeUi({ ...readUi(), showDone: on })
  return on
})

// 两侧栏收起没有。和上面的 showDone 一样是布尔本机偏好，形状照抄，只是键不同。
// 收起状态不影响库里的任何东西，纯界面：下次打开还是这个样子
handle('ui:sidebarCollapsed', () => readUi().sidebarCollapsed === true)
handle('ui:setSidebarCollapsed', (on: boolean) => {
  if (typeof on !== 'boolean') throw new Error(`不认识的开关值：${String(on)}`)
  writeUi({ ...readUi(), sidebarCollapsed: on })
  return on
})
handle('ui:detailCollapsed', () => readUi().detailCollapsed === true)
handle('ui:setDetailCollapsed', (on: boolean) => {
  if (typeof on !== 'boolean') throw new Error(`不认识的开关值：${String(on)}`)
  writeUi({ ...readUi(), detailCollapsed: on })
  return on
})

/**
 * 上次停在哪个列表。存下来的值可能来自旧版本、也可能被手改过，所以只认
 * RESTORABLE_VIEWS 里那几个 —— 读不出来就返回 null，渲染进程退回自己的默认视图。
 */
handle('ui:view', () => {
  const saved = readUi().view
  return isRestorableView(saved) ? saved : null
})
/** 切列表就记一笔。已完成 / 垃圾桶不记：那是顺路看一眼的地方，不该变成下次的落脚点 */
handle('ui:setView', (next: ViewId) => {
  if (!isViewId(next)) throw new Error(`不认识的列表：${String(next)}`)
  if (!isRestorableView(next)) return
  writeUi({ ...readUi(), view: next })
})

handle('window:switch', (to: WinSlot) => {
  if (!isWinSlot(to)) throw new Error(`不认识的窗口分组：${String(to)}`)
  return switchWinSlot(to)
})
handle('app:version', () => app.getVersion())

handle('log:read', () => ({ text: readLog(), path: logPath() }))
handle('log:copy', () => { clipboard.writeText(readLog()) })
handle('log:reveal', () => { shell.showItemInFolder(logPath()) })
handle('log:renderer', (msg: string) => { log('error', `渲染进程：${msg}`) })

ipcMain.handle('vault:state', () => (store ? stateOf(store) : null))
handle('vault:pick', async () => { const s = await pickVault(); return s ? stateOf(s) : null })
handle('task:list', (): Task[] => store?.tasks() ?? [])
handle('task:create', (d: TaskDraftIpc) => write(s => s.add(d)))
handle('task:setField', (id: string, f: string, v: unknown) => write(s => s.setField(id, f, v)))
handle('task:setMany', (rows: FieldOpIpc[]) => write(s => s.setMany(rows)))
handle('task:complete', (id: string) => write(s => s.complete(id).then(next => next?.id ?? null)))
handle('task:uncomplete', (id: string) => write(s => s.uncomplete(id)))
handle('task:trash', (id: string) => write(s => s.trash(id)))
handle('task:restore', (id: string) => write(s => s.restore(id)))

/** 清空垃圾桶。不可撤销，所以先弹一次原生确认；默认按钮是"取消" */
handle('task:purgeAll', async () => {
  const n = need().tasks().filter(t => t.deleted).length
  if (!n) return 0
  const L = S()
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    message: L.purgeAllAsk(n),
    detail: L.purgeAllDetail,
    buttons: [L.purgeAllOk, L.cancel],
    defaultId: 1, cancelId: 1,
  }
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (response !== 0) { log('info', '清空垃圾桶：用户取消了', { count: n }); return 0 }
  const done = await write(s => s.purgeAll())
  log('info', '清空垃圾桶', { count: done })
  return done
})

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

/** 只放行这三种协议：别把任意 scheme 交给系统去执行 */
function openExternal(url: string) {
  if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
  else log('info', '挡下了不认识的链接', { url })
}

function createWindow() {
  // 打开就回到上次那一屏列表（渲染进程 boot() 会跟着落到同一个视图），所以第一屏的尺寸
  // 也用那一屏记下的 —— 否则窗口先按列表大小画出来，等渲染进程报上来再跳一下。
  // 没记过或者记的是已完成 / 垃圾桶，就还是"其余视图"那套尺寸
  const start = readUi().view
  winSlot = isRestorableView(start) ? viewSlot(start) : 'other'
  const saved = readUi().winSize?.[winSlot]
  const [w, h] = saved ? fitToScreen(saved[0], saved[1]) : [DEFAULT_W, DEFAULT_H]
  const opts: Electron.BrowserWindowConstructorOptions = {
    width: w, height: h, minWidth: MIN_W, minHeight: MIN_H,
    // 跟着主题走：页面还没画出来时露的就是它，深色下不能是奶油色
    backgroundColor: windowBg(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // 平台由主进程判定，这里把结果递给 preload（渲染进程不自己读 process.platform）
      additionalArguments: [`${PLATFORM_ARG}${PLATFORM}`],
      contextIsolation: true,      // 渲染进程零 fs 权限，见 architecture.zh.md §5
      nodeIntegration: false,
      sandbox: true,
    },
  }
  if (isMac) {
    // 藏掉系统标题栏，红绿灯浮在页面左上角。页面自己留出左边和顶上那 34px
    opts.titleBarStyle = 'hiddenInset'
  } else {
    // Windows 同样藏掉标题栏，但三个窗口按钮交给系统的 Window Controls Overlay 画在右上角。
    // 自己画一套要处理最大化/还原状态、双击标题栏、贴边吸附、系统菜单，不值当。
    // 页面那边只要在详情栏收起时给右边让出按钮的宽度（见 index.html 的 html[data-os=win]）
    opts.titleBarStyle = 'hidden'
    opts.titleBarOverlay = overlayOpts()
  }
  win = new BrowserWindow(opts)
  // 用户手动拖出来的大小，记在当前这一屏名下。防抖：拖的过程中一直在变，
  // ui.json 是整份重写，没必要每一帧都落盘
  win.on('resize', () => {
    if (winSaveTimer) clearTimeout(winSaveTimer)
    winSaveTimer = setTimeout(() => { winSaveTimer = null; rememberWinSize() }, 400)
  })
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  // 备注里的链接是普通的 <a>，点一下会把整个窗口导航走 —— 应用当场变成一个网页，
  // 而且没有后退的路。一律拦下，交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url) })
  win.loadFile(join(__dirname, 'renderer/index.html'))
  // 点关闭只是把窗口收起来，进程继续跑 —— 下次点 Dock / 托盘图标立刻回来，不用重新读库。
  // 真退出的路（macOS：Dock 右键"退出"或 ⌘Q；Windows：托盘的"退出"）都会先发
  // before-quit，把 quitting 立起来
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
    log('info', '主窗口收起，应用继续在后台运行')
    // Windows 上任务栏图标跟着窗口一起消失，用户可能以为应用关了。
    // 第一次收起时提示一下托盘在哪 —— 只提示一次，之后就别烦人了
    if (!isMac && !trayHinted) {
      trayHinted = true
      try { tray?.displayBalloon({ title: S().brand, content: S().trayHint }) } catch { /* 系统不让弹就算了 */ }
    }
  })
  return win
}

/** 图标被点或菜单选了"打开主界面"：窗口还在就直接显示，别重新建一个 */
function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus() }
  else createWindow()
}

/**
 * macOS：Dock 图标右键的菜单。系统会在我们这几项下面自动接上"选项 / 显示全部窗口 / 退出"，
 * 所以这里不重复放"退出" —— 系统那一项走的是标准退出流程。
 *
 * Windows 没有 Dock，用托盘顶上：窗口收起来之后，这里是唯一的入口和唯一的退出口
 * （任务栏图标跟着窗口一起没了，没有托盘就等于既回不来也退不掉）。
 */
function refreshAppMenus() {
  if (isMac) {
    app.dock?.setMenu(Menu.buildFromTemplate([
      { label: S().dockOpen, click: () => showWindow() },
    ]))
    return
  }
  const s = S()
  if (!tray) {
    tray = new Tray(join(__dirname, 'assets/tray.png'))
    // 左键点一下就把窗口叫回来；右键弹的是下面这份菜单
    tray.on('click', () => showWindow())
  }
  tray.setToolTip(s.brand)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: s.dockOpen, click: () => showWindow() },
    { type: 'separator' },
    { label: s.trayQuit, click: () => app.quit() },
  ]))
}

/**
 * 单实例锁。Windows 上双击两次图标会真的起两个进程：两只托盘、两份窗口，
 * 还要抢同一个锁文件。macOS 由 Finder 自己挡住，不用管。
 * 没抢到锁的进程立刻退出，剩下的活儿交给已经在跑的那个。
 */
const primary = isMac || app.requestSingleInstanceLock()

if (!primary) app.quit()
else app.on('second-instance', () => showWindow())

app.whenReady().then(async () => {
  if (!primary) return
  applyTheme()          // 必须早于建窗口：晚了第一帧会先按系统默认色画一遍，再闪一下
  // Windows 上不留菜单条：Electron 默认那份 File/Edit/View/Window/Help 会压在页面顶上，
  // 而顶上 34px 是我们自己的标题区。开发时不删，留着"Toggle DevTools"那几个好用
  if (!isMac && app.isPackaged) Menu.setApplicationMenu(null)
  await boot()
  const w = createWindow()
  w.webContents.once('did-finish-load', async () => {
    // 没有库时不要直接弹系统对话框 —— 用户还不知道这个文件夹是干什么的。
    // 渲染进程会显示引导页，由用户点按钮再触发 vault:pick
    push()
    // 开发期自检钩子。打包后一律失效，不留在成品里
    if (!app.isPackaged) await selfTest(w)
  })
  refreshAppMenus()
  // 点 Dock 图标：收起来的窗口要能回来，不是只在"一个窗口都没有"时才建
  app.on('activate', () => showWindow())
})

// 订阅了这个事件就等于告诉 Electron"窗口关完别自动退" —— 空函数是故意的。
// 窗口其实也不会真的关（上面 preventDefault 了），这里只是把默认行为挡住
app.on('window-all-closed', () => { /* 后台继续跑，见 createWindow 里的 close */ })

app.on('before-quit', () => {
  quitting = true
  // 刚拖完窗口就退出的话，防抖那 400ms 还没到 —— 这里补一次，别把最后那次改动丢了
  if (winSaveTimer) { clearTimeout(winSaveTimer); winSaveTimer = null }
  rememberWinSize()
  watcher?.close()
  log('info', '退出')
})
