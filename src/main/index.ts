import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  session,
  desktopCapturer,
  screen,
  Tray,
  Menu,
  nativeImage,
  type Display
} from 'electron'
import { join, basename } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { autoUpdater } from 'electron-updater'
import type { AppConfig, ChatRequest } from '../shared/types'

const execFileAsync = promisify(execFile)

// Overlay painting fix: Chromium otherwise skips painting occluded windows.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const DEFAULT_CONFIG: AppConfig = {
  privateMode: true,
  clickThrough: false,
  panelOpacity: 0.94,
  llm: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: 'qwen2.5:7b-instruct',
    temperature: 0.4,
    maxTokens: 400,
    vision: false
  },
  asr: {
    mode: 'whispercpp',
    url: 'http://127.0.0.1:8080/inference',
    apiKey: '',
    model: 'whisper-1'
  },
  interaction: {
    autoAnswer: false,
    answerCooldownMs: 5000,
    transcribeMic: false,
    streamingPartials: true,
    earlyAnswer: true
  },
  answer: {
    length: 'balanced',
    format: 'balanced',
    tone: 'formal',
    star: false,
    fillerWords: false
  },
  profile: {
    resume: '',
    background: ''
  },
  session: {
    title: 'Interview session',
    company: '',
    jobDescription: '',
    extraContext: ''
  },
  window: {
    screenMode: 'primary',
    x: null,
    y: null
  },
  updates: {
    enabled: false,
    feedUrl: ''
  },
  meetings: {
    detect: false,
    autoStart: false
  }
}

let win: BrowserWindow | null = null
let config: AppConfig = DEFAULT_CONFIG
const aborters = new Map<string, AbortController>()
let tray: Tray | null = null
let meetingTimer: ReturnType<typeof setInterval> | null = null
let meetingActive = false
let updateTimer: ReturnType<typeof setInterval> | null = null

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = (base as Record<string, unknown>)[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v
  }
  return out as T
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '')
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function persistConfig(): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to persist config', err)
  }
}

function sendHotkey(name: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('hotkey', name)
}

function applyStealth(): void {
  if (!win || win.isDestroyed()) return
  win.setContentProtection(config.privateMode)
  if (config.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
  win.setAlwaysOnTop(true, 'screen-saver')
}

function displayForWindow(): Display {
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    return screen.getDisplayNearestPoint({
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2)
    })
  }
  return screen.getPrimaryDisplay()
}

function topCenterOn(display: Display): void {
  if (!win || win.isDestroyed()) return
  const { x, y, width } = display.workArea
  const [w] = win.getSize()
  win.setPosition(Math.round(x + (width - w) / 2), y + 24)
}

function moveToCursorDisplay(): void {
  if (!win || win.isDestroyed()) return
  topCenterOn(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
  saveWindowPosition()
}

function intersectsAnyDisplay(x: number, y: number, w: number, h: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height
  })
}

function restoreWindowPosition(): void {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getSize()
  if (
    config.window.x !== null &&
    config.window.y !== null &&
    intersectsAnyDisplay(config.window.x, config.window.y, w, h)
  ) {
    win.setBounds({ x: config.window.x, y: config.window.y, width: w, height: h })
    return
  }
  if (config.window.screenMode === 'cursor') {
    topCenterOn(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
  } else {
    topCenterOn(screen.getPrimaryDisplay())
  }
}

function saveWindowPosition(): void {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
  const b = win.getBounds()
  config = { ...config, window: { ...config.window, x: b.x, y: b.y } }
  persistConfig()
}

function ensureWindowVisible(): void {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  if (!intersectsAnyDisplay(b.x, b.y, b.width, b.height)) topCenterOn(screen.getPrimaryDisplay())
}

function toggleClickThrough(): void {
  config = { ...config, clickThrough: !config.clickThrough }
  persistConfig()
  applyStealth()
  if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520,
    height: 640,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  applyStealth()
  restoreWindowPosition()

  let moveTimer: ReturnType<typeof setTimeout> | null = null
  win.on('moved', () => {
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => saveWindowPosition(), 400)
  })

  win.once('ready-to-show', () => {
    win?.showInactive()
  })

  win.webContents.on('console-message', (event) => {
    const details = event as unknown as { message?: string; level?: string | number }
    console.log('[renderer]', details.message ?? '')
  })

  win.on('closed', () => {
    win = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  if (process.env['PC_AUTOSTART'] === '1') {
    win.webContents.on('did-finish-load', async () => {
      if (!win || win.isDestroyed()) return
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const ready = await win.webContents.executeJavaScript(
            'typeof window.__pcAutostart === "function"',
            true
          )
          if (ready) {
            await win.webContents.executeJavaScript('window.__pcAutostart()', true)
            return
          }
        } catch {
          /* retry */
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      console.log('[autostart] renderer hook never appeared')
    })
  }

  // Re-assert topmost every second (screen-saver level).
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(timer)
    win.setAlwaysOnTop(true, 'screen-saver')
  }, 1000)
}

function registerHotkeys(): void {
  const nudge = (dx: number, dy: number): void => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    win.setPosition(b.x + dx, b.y + dy)
  }

  globalShortcut.register('CommandOrControl+Shift+Up', () => nudge(0, -40))
  globalShortcut.register('CommandOrControl+Shift+Down', () => nudge(0, 40))
  globalShortcut.register('CommandOrControl+Shift+Left', () => nudge(-40, 0))
  globalShortcut.register('CommandOrControl+Shift+Right', () => nudge(40, 0))

  globalShortcut.register('CommandOrControl+Shift+Enter', () => sendHotkey('answer'))
  globalShortcut.register('CommandOrControl+Alt+Enter', () => sendHotkey('screenshot'))
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (win && !win.isDestroyed()) {
      win.showInactive()
      win.focus()
    }
    sendHotkey('chat')
  })
  globalShortcut.register('CommandOrControl+H', () => {
    if (win && !win.isDestroyed()) win.hide()
  })
  globalShortcut.register('CommandOrControl+Shift+F9', () => toggleClickThrough())
  globalShortcut.register('CommandOrControl+Shift+M', () => moveToCursorDisplay())
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => config)

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    config = deepMerge(config, patch)
    persistConfig()
    applyStealth()
    applyMeetingConfig()
    setupUpdates()
    if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
    return config
  })

  ipcMain.handle('win:set-ignore-mouse', (_e, value: boolean) => {
    config = { ...config, clickThrough: value }
    persistConfig()
    applyStealth()
    return config
  })

  ipcMain.handle('win:set-private-mode', (_e, value: boolean) => {
    config = { ...config, privateMode: value }
    persistConfig()
    applyStealth()
    return config
  })

  ipcMain.handle('win:hide', () => {
    if (win && !win.isDestroyed()) win.hide()
  })

  ipcMain.handle('win:quit', () => app.quit())

  ipcMain.handle('displays:list', () =>
    screen.getAllDisplays().map((d, index) => ({
      id: d.id,
      label: `Display ${index + 1}`,
      primary: d.id === screen.getPrimaryDisplay().id,
      bounds: d.bounds
    }))
  )

  ipcMain.handle('displays:move-to-cursor', () => {
    moveToCursorDisplay()
    return true
  })

  ipcMain.handle('displays:move-to-index', (_e, index: number) => {
    const display = screen.getAllDisplays()[index]
    if (!display) return false
    topCenterOn(display)
    saveWindowPosition()
    return true
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    configPath: configPath()
  }))

  ipcMain.handle('session:save', (_e, payload: unknown) => {
    try {
      const dir = join(app.getPath('userData'), 'sessions')
      mkdirSync(dir, { recursive: true })
      const name = `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      writeFileSync(join(dir, name), JSON.stringify(payload, null, 2), 'utf8')
      return name
    } catch (err) {
      console.error('Session save failed', err)
      return null
    }
  })

  ipcMain.handle('shot:capture', async () => {
    const display = displayForWindow()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.min(display.size.width, 3840),
        height: Math.min(display.size.height, 2160)
      }
    })
    const source =
      sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null
    if (!source) throw new Error('No screen source available')
    if (source.thumbnail.isEmpty()) throw new Error('Screenshot is empty (screen may be locked or DRM protected)')
    return `data:image/jpeg;base64,${source.thumbnail.toJPEG(85).toString('base64')}`
  })

  ipcMain.handle('asr:transcribe', async (_e, req: { wav: ArrayBuffer; prompt?: string }) => {
    const text = await transcribeWav(new Uint8Array(req.wav), req.prompt)
    return { text }
  })

  ipcMain.handle('test:asr', async () => {
    try {
      const text = await transcribeWav(makeSilenceWav(0.5))
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('test:llm', async () => {
    try {
      const endpoint = config.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.llm.apiKey) headers['Authorization'] = `Bearer ${config.llm.apiKey}`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.llm.model,
          stream: false,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }]
        })
      })
      const raw = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`)
      const json = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return { ok: true, text: String(json.choices?.[0]?.message?.content ?? '').trim() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('sessions:list', () => {
    try {
      const dir = join(app.getPath('userData'), 'sessions')
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((f) => /^[\w.-]+\.json$/.test(f))
        .map((name) => {
          try {
            const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
              string,
              unknown
            >
            return {
              name,
              title: typeof data.title === 'string' ? data.title : 'Untitled',
              endedAt: typeof data.endedAt === 'string' ? data.endedAt : null,
              segments: Array.isArray(data.segments) ? data.segments.length : 0,
              answers: Array.isArray(data.answers) ? data.answers.length : 0
            }
          } catch {
            return null
          }
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')))
    } catch {
      return []
    }
  })

  ipcMain.handle('sessions:get', (_e, name: string) => {
    if (!/^[\w.-]+\.json$/.test(name) || basename(name) !== name) {
      throw new Error('Invalid session name')
    }
    const full = join(app.getPath('userData'), 'sessions', name)
    return JSON.parse(readFileSync(full, 'utf8'))
  })

  ipcMain.handle('sessions:delete', (_e, name: string) => {
    if (!/^[\w.-]+\.json$/.test(name) || basename(name) !== name) {
      throw new Error('Invalid session name')
    }
    unlinkSync(join(app.getPath('userData'), 'sessions', name))
    return true
  })

  ipcMain.handle('sessions:delete-all', () => {
    const dir = join(app.getPath('userData'), 'sessions')
    if (!existsSync(dir)) return 0
    let count = 0
    for (const file of readdirSync(dir)) {
      if (!/^[\w.-]+\.json$/.test(file)) continue
      try {
        unlinkSync(join(dir, file))
        count += 1
      } catch {
        /* skip locked files */
      }
    }
    return count
  })

  ipcMain.handle('updates:check', async () => {
    if (!config.updates.enabled || !config.updates.feedUrl) {
      return { ok: false, error: 'Updates not configured' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, version: result?.updateInfo?.version ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updates:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('llm:chat', async (event, req: ChatRequest) => {
    const ctrl = new AbortController()
    aborters.set(req.id, ctrl)

    const endpoint = config.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.llm.apiKey) headers['Authorization'] = `Bearer ${config.llm.apiKey}`

    const last = req.messages[req.messages.length - 1]
    const messages = [...req.messages]
    if (req.vision && req.images.length > 0 && last) {
      // Multimodal form: latest user turn carries image parts.
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: last.content },
          ...req.images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ] as unknown as string
      }
    }

    const body = {
      model: config.llm.model,
      stream: true,
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
      messages
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
      if (!res.ok || !res.body) {
        const detail = await res.text()
        throw new Error(`LLM error ${res.status}: ${detail.slice(0, 400)}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''

      const emit = (text: string): void => {
        full += text
        event.sender.send('llm:delta', { id: req.id, text })
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const delta = json.choices?.[0]?.delta?.content ?? ''
            if (delta) emit(delta)
          } catch {
            /* ignore malformed keep-alive lines */
          }
        }
      }
      event.sender.send('llm:done', { id: req.id })
      console.log(`[llm-answer] ${full}`)
      return { ok: true, text: full }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      event.sender.send('llm:error', { id: req.id, message })
      throw new Error(message)
    } finally {
      aborters.delete(req.id)
    }
  })

  ipcMain.handle('llm:abort', (_e, id: string) => {
    aborters.get(id)?.abort()
    aborters.delete(id)
  })
}

async function transcribeWav(bytes: Uint8Array, prompt?: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(bytes)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (prompt && prompt.trim()) {
    form.append('prompt', prompt.trim())
    console.log('[asr] carry prompt chars', prompt.trim().length)
  }

  const headers: Record<string, string> = {}
  if (config.asr.mode !== 'whispercpp') {
    form.append('model', config.asr.model || 'whisper-1')
    if (config.asr.apiKey) headers['Authorization'] = `Bearer ${config.asr.apiKey}`
  }

  const res = await fetch(config.asr.url, { method: 'POST', body: form, headers })
  const raw = await res.text()
  if (!res.ok) throw new Error(`ASR error ${res.status}: ${raw.slice(0, 300)}`)

  let text = raw
  try {
    const json = JSON.parse(raw) as Record<string, unknown>
    text = String(json.text ?? json.result ?? '')
  } catch {
    /* plain-text response */
  }
  return text.trim()
}

function makeSilenceWav(seconds: number): Uint8Array {
  const sampleRate = 16000
  const samples = Math.round(seconds * sampleRate)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples * 2, true)
  return new Uint8Array(buffer)
}

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR42mNgGJTA617Df2yYbI1EG0SRAcRqxmnIqAFUMGDg0wFVkvKAAADNh0j0ecynRAAAAABJRU5ErkJggg=='

function createTray(): void {
  if (tray) return
  try {
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
    tray = new Tray(icon)
    tray.setToolTip('Parakeet Clone')
    const menu = Menu.buildFromTemplate([
      {
        label: 'Show / Hide',
        click: () => {
          if (!win) return
          if (win.isVisible()) win.hide()
          else {
            win.show()
            win.focus()
          }
        }
      },
      { type: 'separator' },
      { label: 'Answer (Ctrl+Shift+Enter)', click: () => sendHotkey('answer') },
      { label: 'Screenshot (Ctrl+Alt+Enter)', click: () => sendHotkey('screenshot') },
      {
        label: 'Settings',
        click: () => {
          if (win && !win.isDestroyed()) {
            win.show()
            win.focus()
          }
          sendHotkey('settings')
        }
      },
      { label: 'Move to cursor screen', click: () => moveToCursorDisplay() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
    tray.setContextMenu(menu)
    tray.on('click', () => {
      if (!win) return
      if (win.isVisible()) win.hide()
      else {
        win.show()
        win.focus()
      }
    })
  } catch (err) {
    console.error('Tray creation failed', err)
  }
}

const MEETING_APPS = [
  'zoom.exe',
  'ms-teams.exe',
  'teams.exe',
  'webex.exe',
  'webexmta.exe',
  'discord.exe',
  'slack.exe',
  'chime.exe',
  'lark.exe',
  'whatsapp.exe'
]

// Apps that are commonly always running: notify, but never auto-start capture.
const ALWAYS_ON_APPS = ['discord.exe', 'slack.exe', 'whatsapp.exe']

async function listProcessNames(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return stdout
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^"([^"]+)"/)
        return match ? match[1].toLowerCase() : ''
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

async function pollMeeting(): Promise<void> {
  const names = await listProcessNames()
  const hit = names.find((name) => MEETING_APPS.includes(name))
  if (hit && !meetingActive) {
    meetingActive = true
    console.log('[meeting] detected', hit)
    try {
      tray?.displayBalloon({
        title: 'Meeting detected',
        content: `${hit} started — Parakeet Clone is ready`,
        iconType: 'info'
      })
    } catch {
      /* balloons unsupported */
    }
    if (config.meetings.autoStart && !ALWAYS_ON_APPS.includes(hit)) sendHotkey('autostart')
  } else if (!hit && meetingActive) {
    meetingActive = false
    console.log('[meeting] ended')
  }
}

function startMeetingDetector(): void {
  if (!config.meetings.detect || meetingTimer) return
  meetingActive = false
  meetingTimer = setInterval(() => void pollMeeting(), 5000)
  void pollMeeting()
}

function stopMeetingDetector(): void {
  if (meetingTimer) clearInterval(meetingTimer)
  meetingTimer = null
  meetingActive = false
}

function applyMeetingConfig(): void {
  if (config.meetings.detect) startMeetingDetector()
  else stopMeetingDetector()
}

function setupUpdates(): void {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
  if (!config.updates.enabled || !config.updates.feedUrl) return
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: config.updates.feedUrl })
  } catch (err) {
    console.error('Invalid update feed', err)
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.removeAllListeners('update-downloaded')
  autoUpdater.on('update-downloaded', (info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:ready', { version: info.version })
    }
  })
  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => console.error('Update check failed', err))
  }
  setTimeout(check, 15000)
  updateTimer = setInterval(check, 6 * 60 * 60 * 1000)
  void check()
}

function registerDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const display: Display = screen.getPrimaryDisplay()
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        const source =
          sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
        if (!source) {
          callback({})
          return
        }
        callback({ video: source, audio: 'loopback' } as never)
      } catch (err) {
        console.error('Display media request failed', err)
        callback({})
      }
    },
    { useSystemPicker: false }
  )

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.showInactive()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    config = loadConfig()
    const redacted = {
      ...config,
      llm: { ...config.llm, apiKey: config.llm.apiKey ? '***' : '' },
      asr: { ...config.asr, apiKey: config.asr.apiKey ? '***' : '' }
    }
    console.log('[config]', JSON.stringify(redacted))
    registerDisplayMedia()
    console.log('[boot] display media ready')
    registerIpc()
    console.log('[boot] ipc ready')
    createWindow()
    console.log('[boot] window created')
    createTray()
    applyMeetingConfig()
    setupUpdates()
    screen.on('display-metrics-changed', () => ensureWindowVisible())
    screen.on('display-removed', () => ensureWindowVisible())
    registerHotkeys()
    console.log('[boot] hotkeys ready')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
