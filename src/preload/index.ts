import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, CaptureTestReport, ChatRequest, HotkeyInfo } from '../shared/types'

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:set', patch),
  setIgnoreMouse: (value: boolean): Promise<AppConfig> =>
    ipcRenderer.invoke('win:set-ignore-mouse', value),
  setPrivateMode: (value: boolean): Promise<AppConfig> =>
    ipcRenderer.invoke('win:set-private-mode', value),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('win:hide'),
  quit: (): Promise<void> => ipcRenderer.invoke('win:quit'),
  appInfo: (): Promise<{ version: string; platform: string; configPath: string }> =>
    ipcRenderer.invoke('app:info'),
  getHotkeys: (): Promise<HotkeyInfo[]> => ipcRenderer.invoke('hotkeys:list'),
  saveSession: (payload: unknown): Promise<string | null> =>
    ipcRenderer.invoke('session:save', payload),
  captureScreen: (): Promise<string> => ipcRenderer.invoke('shot:capture'),
  captureRegionSource: (): Promise<{ dataUrl: string; displayId: number }> =>
    ipcRenderer.invoke('shot:capture-source'),
  transcribe: (wav: ArrayBuffer, prompt?: string): Promise<{ text: string }> =>
    ipcRenderer.invoke('asr:transcribe', { wav, prompt }),
  testAsr: (): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('test:asr'),
  testLlm: (): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('test:llm'),
  testCapture: (): Promise<CaptureTestReport> => ipcRenderer.invoke('test:capture'),
  listDisplays: (): Promise<
    Array<{ id: number; label: string; primary: boolean; bounds: { x: number; y: number; width: number; height: number } }>
  > => ipcRenderer.invoke('displays:list'),
  moveToCursorDisplay: (): Promise<boolean> => ipcRenderer.invoke('displays:move-to-cursor'),
  moveToDisplay: (index: number): Promise<boolean> => ipcRenderer.invoke('displays:move-to-index', index),
  listSessions: (): Promise<
    Array<{ name: string; title: string; endedAt: string | null; segments: number; answers: number }>
  > => ipcRenderer.invoke('sessions:list'),
  getSession: (name: string): Promise<unknown> => ipcRenderer.invoke('sessions:get', name),
  deleteSession: (name: string): Promise<boolean> => ipcRenderer.invoke('sessions:delete', name),
  deleteAllSessions: (): Promise<number> => ipcRenderer.invoke('sessions:delete-all'),
  exportSession: (name: string): Promise<string> => ipcRenderer.invoke('sessions:export', name),
  checkForUpdates: (): Promise<{ ok: boolean; version?: string | null; error?: string }> =>
    ipcRenderer.invoke('updates:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  onUpdateReady: (cb: (payload: { version: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { version: string }): void => cb(payload)
    ipcRenderer.on('update:ready', handler as never)
    return () => ipcRenderer.removeListener('update:ready', handler as never)
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
