import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '@kapibala/ipc'
import type { Task } from '@kapibala/core'

/** 渲染进程能碰到的全部东西就这些 */
const api = Object.fromEntries(
  CHANNELS.map(ch => [ch, (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)]),
) as Record<string, (...a: unknown[]) => Promise<unknown>>

api['onTasksChanged'] = ((cb: (t: Task[]) => void) => {
  ipcRenderer.on('tasks:changed', (_e, tasks: Task[]) => cb(tasks))
}) as never

api['onShowTask'] = ((cb: (id: string) => void) => {
  ipcRenderer.on('task:show', (_e, id: string) => cb(id))
}) as never

api['onSyncBusy'] = ((cb: (busy: boolean) => void) => {
  ipcRenderer.on('sync:busy', (_e, busy: boolean) => cb(busy))
}) as never

contextBridge.exposeInMainWorld('kapi', api)
