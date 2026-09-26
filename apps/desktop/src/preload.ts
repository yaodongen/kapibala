import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, platformOf, PLATFORM_ARG, type Theme } from '@kapibala/ipc'
import type { Task } from '@kapibala/core'

/** 渲染进程能碰到的全部东西就这些 */
const api: Record<string, unknown> = Object.fromEntries(
  CHANNELS.map(ch => [ch, (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)]),
)

/**
 * 运行平台。由主进程判定后从启动参数递过来（见 main.ts 的 createWindow），
 * 这里只做映射 —— 渲染进程不自己读 process.platform，否则开发期在 Mac 上跑
 * Windows 分支时会出现"界面按 mac 留白、主进程按 Windows 建托盘"这种精神分裂。
 * 走启动参数而不是 IPC：界面第一帧就要用它，等一次往返会先画错一帧。
 */
const fromArg = process.argv.find(a => a.startsWith(PLATFORM_ARG))
api['platform'] = platformOf(process.platform, fromArg?.slice(PLATFORM_ARG.length))

api['onTasksChanged'] = ((cb: (t: Task[]) => void) => {
  ipcRenderer.on('tasks:changed', (_e, tasks: Task[]) => cb(tasks))
}) as never

api['onSyncBusy'] = ((cb: (busy: boolean) => void) => {
  ipcRenderer.on('sync:busy', (_e, busy: boolean) => cb(busy))
}) as never

api['onThemeChanged'] = ((cb: (theme: Theme) => void) => {
  ipcRenderer.on('theme:changed', (_e, theme: Theme) => cb(theme))
}) as never

contextBridge.exposeInMainWorld('kapi', api)
