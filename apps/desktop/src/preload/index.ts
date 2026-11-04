import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Msg = { slug: string; event: string; payload: any }

contextBridge.exposeInMainWorld('holon', {
  home: process.env.HOME ?? '/',
  open: (kind: string, value: string) => ipcRenderer.invoke('holon:open', kind, value),
  projects: () => ipcRenderer.invoke('holon:projects'),
  pickFolder: () => ipcRenderer.invoke('holon:pickFolder'),
  clis: () => ipcRenderer.invoke('holon:clis'),
  plans: () => ipcRenderer.invoke('holon:plans'),
  usage: () => ipcRenderer.invoke('holon:usage'),
  advice: () => ipcRenderer.invoke('holon:advice'),
  addProject: (name: string, workspace?: string) => ipcRenderer.invoke('holon:addProject', name, workspace),
  call: (slug: string, method: string, params: Record<string, unknown> = {}) => ipcRenderer.invoke('holon:call', slug, method, params),
  onOpenProject: (fn: (slug: string) => void) => {
    const listener = (_e: IpcRendererEvent, slug: string) => fn(slug)
    ipcRenderer.on('holon:open-project', listener)
    return () => { ipcRenderer.off('holon:open-project', listener) }
  },
  onEvent: (fn: (msg: Msg) => void) => {
    const listener = (_e: IpcRendererEvent, msg: Msg) => fn(msg)
    ipcRenderer.on('holon:event', listener)
    return () => { ipcRenderer.off('holon:event', listener) }
  },
})
