import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, CaptureTestReport, ChatRequest, HotkeyInfo } from '../shared/types'

/** Push from main for the whole update lifecycle (banner + Settings). */
export interface UpdateState {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0–100 while downloading. */
  percent?: number
  version?: string
  errorMessage?: string
}

const api = {
  getConfig: (): Promise<{ config: AppConfig; corruptBackupPath: string | null }> =>
    ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:set', patch),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('win:hide'),
  quit: (): Promise<void> => ipcRenderer.invoke('win:quit'),
  // Save-before-quit handshake: ack on end-session receipt, then quit once saved.
  ackEndSession: (): Promise<void> => ipcRenderer.invoke('app:end-session-ack'),
  quitAfterSave: (): Promise<void> => ipcRenderer.invoke('app:quit-after-save'),
  setCaptureListening: (value: boolean): Promise<void> =>
    ipcRenderer.invoke('capture:set-listening', value),
  getHotkeys: (): Promise<HotkeyInfo[]> => ipcRenderer.invoke('hotkeys:list'),
  saveSession: (payload: unknown, opts?: { autosave?: boolean }): Promise<string | null> =>
    ipcRenderer.invoke('session:save', payload, opts),
  extractPdf: (): Promise<{
    text: string
    pagesProcessed: number
    truncated: boolean
  } | null> => ipcRenderer.invoke('docs:extract-pdf'),
  fetchJob: (url: string): Promise<{ title: string; text: string }> =>
    ipcRenderer.invoke('jobs:fetch', url),
  captureScreen: (): Promise<{ dataUrl: string; hint?: string }> =>
    ipcRenderer.invoke('shot:capture'),
  captureRegionSource: (): Promise<{ dataUrl: string; displayId: number }> =>
    ipcRenderer.invoke('shot:capture-source'),
  transcribe: (wav: ArrayBuffer, prompt?: string): Promise<{ text: string }> =>
    ipcRenderer.invoke('asr:transcribe', { wav, prompt }),
  testAsr: (): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('test:asr'),
  testLlm: (): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('test:llm'),
  testCapture: (): Promise<CaptureTestReport> => ipcRenderer.invoke('test:capture'),
  moveToCursorDisplay: (): Promise<boolean> => ipcRenderer.invoke('displays:move-to-cursor'),
  listSessions: (): Promise<
    Array<{
      name: string
      title: string
      company: string
      endedAt: string | null
      segments: number
      answers: number
    }>
  > => ipcRenderer.invoke('sessions:list'),
  getSession: (name: string): Promise<unknown> => ipcRenderer.invoke('sessions:get', name),
  deleteSession: (name: string): Promise<boolean> => ipcRenderer.invoke('sessions:delete', name),
  deleteAllSessions: (): Promise<number> => ipcRenderer.invoke('sessions:delete-all'),
  exportSession: (name: string): Promise<string> => ipcRenderer.invoke('sessions:export', name),
  checkForUpdates: (): Promise<{ ok: boolean; version?: string | null; error?: string }> =>
    ipcRenderer.invoke('updates:check'),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('updates:install'),
  onUpdateReady: (cb: (payload: { version: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { version: string }): void => cb(payload)
    ipcRenderer.on('update:ready', handler as never)
    return () => ipcRenderer.removeListener('update:ready', handler as never)
  },
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const handler = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on('update-state-changed', handler as never)
    return () => ipcRenderer.removeListener('update-state-changed', handler as never)
  },
  chat: (req: ChatRequest): Promise<{ ok: boolean; text: string }> =>
    ipcRenderer.invoke('llm:chat', req),
  abortChat: (id: string): Promise<void> => ipcRenderer.invoke('llm:abort', id),
  onHotkey: (cb: (name: string) => void): (() => void) => {
    const handler = (_e: unknown, name: string): void => cb(name)
    ipcRenderer.on('hotkey', handler as never)
    return () => ipcRenderer.removeListener('hotkey', handler as never)
  },
  onCapturedImage: (
    cb: (payload: { dataUrl?: string; hint?: string; error?: string }) => void
  ): (() => void) => {
    const handler = (
      _e: unknown,
      payload: { dataUrl?: string; hint?: string; error?: string }
    ): void => cb(payload)
    ipcRenderer.on('shot:image', handler as never)
    return () => ipcRenderer.removeListener('shot:image', handler as never)
  },
  onConfigChanged: (cb: (config: AppConfig) => void): (() => void) => {
    const handler = (_e: unknown, config: AppConfig): void => cb(config)
    ipcRenderer.on('config:changed', handler as never)
    return () => ipcRenderer.removeListener('config:changed', handler as never)
  },
  onLlmDelta: (cb: (payload: { id: string; text: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; text: string }): void => cb(payload)
    ipcRenderer.on('llm:delta', handler as never)
    return () => ipcRenderer.removeListener('llm:delta', handler as never)
  },
  onLlmDone: (cb: (payload: { id: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string }): void => cb(payload)
    ipcRenderer.on('llm:done', handler as never)
    return () => ipcRenderer.removeListener('llm:done', handler as never)
  },
  onLlmError: (cb: (payload: { id: string; message: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; message: string }): void => cb(payload)
    ipcRenderer.on('llm:error', handler as never)
    return () => ipcRenderer.removeListener('llm:error', handler as never)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
