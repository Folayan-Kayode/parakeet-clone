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
  dialog,
  type Display,
  type NativeImage
} from 'electron'
import { join, basename } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  promises as fsPromises
} from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { autoUpdater } from 'electron-updater'
import { buildSessionMarkdown } from '../shared/session-export'
import type {
  AppConfig,
  CaptureTestCheck,
  CaptureTestReport,
  ChatRequest
} from '../shared/types'
import {
  activeProfile,
  buildChatMessages,
  chatBody,
  computeResponseDeadlineMs,
  coerceWindowBounds,
  decomposeMessages,
  normalizeAnswer,
  normalizeLlm
} from './llm-body'
import { isAlwaysOnApp, isAlwaysOnTitle, meetingTitleHit } from './meeting-detect'
import { assertPublicHost, normalizeHost, stripHtml } from './ssrf'
import { clampInteractionValue } from '../shared/clamps'

const execFileAsync = promisify(execFile)

// Interview content must stay out of stdout unless explicitly opted in.
const PC_VERBOSE = process.env['PC_VERBOSE'] === '1'
const CONTENT_LOG_RE = /^\[(segment|partial|answer-anchor|llm-answer|early-answer)/
function verboseLog(...args: unknown[]): void {
  if (PC_VERBOSE) console.log(...args)
}

// Overlay painting fix: Chromium otherwise skips painting occluded windows.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const DEFAULT_CONFIG: AppConfig = {
  privateMode: true,
  clickThrough: false,
  panelOpacity: 0.94,
  llm: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    // vision-capable: reads screenshots (pull: ollama pull qwen2.5vl:7b)
    model: 'qwen2.5vl:7b',
    temperature: 0.2,
    // thinking tokens count against max_tokens on Gemini; 1024 truncates at high effort
    maxTokens: 4096,
    // low keeps time-to-first-token fast for live interviews; high for hard algorithmic questions
    reasoningEffort: 'low',
    autoEscalate: false,
    vision: false,
    // Filled from the legacy fields by loadConfig when empty (migration).
    profiles: [],
    activeProfileId: ''
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
    mergeFollowUpsMs: 2000,
    silenceSplitMs: 900,
    transcribeMic: false,
    streamingPartials: true,
    earlyAnswer: true,
    autoScroll: true
  },
  answer: {
    length: 'balanced',
    format: 'balanced',
    tone: 'formal',
    star: false,
    fillerWords: false,
    codeLanguage: 'python',
    questionType: 'auto'
  },
  profile: {
    resume: '',
    background: '',
    vocabulary: ''
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
    y: null,
    width: null,
    height: null
  },
  updates: {
    enabled: false,
    feedUrl: ''
  },
  meetings: {
    detect: false,
    autoStart: false,
    balloon: false
  },
  capture: {
    region: null
  },
  audio: {
    // Audio-thread sample framing; false = legacy ScriptProcessorNode.
    useWorklet: true
  }
}

let win: BrowserWindow | null = null
let config: AppConfig = DEFAULT_CONFIG
const aborters = new Map<string, AbortController>()
let tray: Tray | null = null
let meetingTimer: ReturnType<typeof setInterval> | null = null
// Sorted label signature of the current non-always-on hits ('' when none).
let meetingSig = ''
// Reentrancy guard: a 15s tick must not overlap a still-running tasklist probe.
let polling = false
// One-shot balloon guard for always-on-only states (Slack/Discord running).
let alwaysOnNotified = false
// Renderer-reported capture state; balloons are suppressed while listening.
let rendererListening = false
let updateTimer: ReturnType<typeof setInterval> | null = null
// Set when an enabled feed is not https; surfaced by updates:check.
let updateFeedError: string | null = null
// Set when config.json failed to parse and was renamed aside (surfaced once).
let corruptConfigBackupPath: string | null = null

// --- Save-before-quit state machine --------------------------------------
// Alt+F4 / OS close must not discard a live transcript. One request is made
// per quit attempt; the renderer acks on receipt and saves, then asks main to
// quit. A 2s no-ack fallback (and a hard cap after ack) prevents trapping.
let quitReady = false
let saveBeforeQuitStarted = false
let quitWaitTimer: ReturnType<typeof setTimeout> | null = null

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Keep error text out of check details/logs: execFile failures can include the
// (large, base64) command line.
function errorText(err: unknown, max = 160): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > max ? text.slice(-max) : text
}

// 0 disables the coalescing grace window (legacy immediate auto-answer).
// Bounds live in shared/clamps so SettingsView's inputs cannot drift from main.
function normalizeInteraction(
  interaction: AppConfig['interaction']
): AppConfig['interaction'] {
  if (!isPlainObject(interaction)) return { ...DEFAULT_CONFIG.interaction }
  return {
    ...interaction,
    answerCooldownMs: clampInteractionValue('answerCooldownMs', interaction.answerCooldownMs),
    mergeFollowUpsMs: clampInteractionValue('mergeFollowUpsMs', interaction.mergeFollowUpsMs),
    silenceSplitMs: clampInteractionValue('silenceSplitMs', interaction.silenceSplitMs)
  }
}

// Deliberately narrow: false negatives are fine, false positives cost latency.
const CODE_RE =
  /\b(algorithm|complexity|time complexity|optimi[sz]e|dynamic programming|data structure|binary search|recursion|two pointers|sliding window)\b/i

// Prevents a stalled stream from latching streaming.current until app restart.
const STREAM_IDLE_TIMEOUT_MS = 20_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// Interview constraint: never retry mid-stream — a silent second generation
// would duplicate or contradict tokens the user already saw. Retries are only
// for 429/5xx before the first token (1s, then 3s), and abort cancels them.
async function fetchChatWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const retryDelays = [1000, 3000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    if (res.ok && res.body) return res
    const detail = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < retryDelays.length) {
      console.warn(`[llm] ${res.status} before first token — retrying in ${retryDelays[attempt]}ms`)
      await sleep(retryDelays[attempt], signal)
      continue
    }
    throw new Error(`LLM error ${res.status}: ${detail.slice(0, 400)}`)
  }
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = (base as Record<string, unknown>)[k]
    // Arrays (e.g. llm.profiles) are plain values: a patch replaces them wholesale
    // instead of merging element-by-element, so deleted profiles stay deleted.
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v
  }
  return out as T
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

// Corrupt configs are preserved instead of silently overwritten by the first
// persistConfig(): the user may have hand-edited one and wants it back.
function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '')
    const merged = deepMerge(DEFAULT_CONFIG, JSON.parse(raw))
    return {
      ...merged,
      llm: normalizeLlm(merged.llm, DEFAULT_CONFIG.llm),
      answer: normalizeAnswer(merged.answer, DEFAULT_CONFIG.answer),
      interaction: normalizeInteraction(merged.interaction),
      window: coerceWindowBounds(merged.window, DEFAULT_CONFIG.window)
    }
  } catch {
    if (existsSync(configPath())) {
      try {
        const backup = `${configPath()}.corrupt-${Date.now()}`
        renameSync(configPath(), backup)
        corruptConfigBackupPath = backup
        console.error('[config] config.json was corrupt; backup at', backup)
      } catch (err) {
        console.error('[config] could not back up corrupt config', err)
      }
    }
    return {
      ...DEFAULT_CONFIG,
      llm: normalizeLlm(DEFAULT_CONFIG.llm, DEFAULT_CONFIG.llm),
      answer: normalizeAnswer(DEFAULT_CONFIG.answer, DEFAULT_CONFIG.answer),
      interaction: normalizeInteraction(DEFAULT_CONFIG.interaction),
      window: coerceWindowBounds(DEFAULT_CONFIG.window, DEFAULT_CONFIG.window)
    }
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

// --- Save-before-quit helpers --------------------------------------------

function canReachRenderer(): boolean {
  return Boolean(
    win &&
      !win.isDestroyed() &&
      !win.webContents.isDestroyed() &&
      !win.webContents.isCrashed()
  )
}

function clearQuitWaitTimer(): void {
  if (quitWaitTimer) {
    clearTimeout(quitWaitTimer)
    quitWaitTimer = null
  }
}

// True when this close/quit may proceed. Otherwise asks the renderer once to
// save (endSession → app:quit-after-save) and blocks the current attempt.
function guardQuit(): boolean {
  if (quitReady) return true
  if (!canReachRenderer()) {
    // Nothing can be saved; never trap the user behind a dead renderer.
    quitReady = true
    clearQuitWaitTimer()
    return true
  }
  if (saveBeforeQuitStarted) return false
  saveBeforeQuitStarted = true
  sendHotkey('end-session')
  quitWaitTimer = setTimeout(() => {
    quitWaitTimer = null
    quitReady = true
    app.quit()
  }, 2000)
  return false
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

// Shared by the screenshot button/hotkey and the region picker so the preview
// and the cropped pixels come from the same capped frame.
async function captureDisplayFrame(): Promise<{
  image: NativeImage
  display: Display
  matched: boolean
}> {
  const display = displayForWindow()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    // 1600x900 caps capture latency and the vision context-token budget.
    thumbnailSize: {
      width: Math.min(display.size.width, 1600),
      height: Math.min(display.size.height, 900)
    }
  })
  const matched = sources.find((s) => s.display_id === String(display.id))
  const source = matched ?? sources[0] ?? null
  if (!source) throw new Error('No screen source available')
  if (source.thumbnail.isEmpty()) {
    throw new Error('Screenshot is empty (screen may be locked or DRM protected)')
  }
  return { image: source.thumbnail, display, matched: Boolean(matched) }
}

function jpegDataUrl(image: NativeImage): string {
  return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
}

// Surfaced when desktopCapturer had no source for the overlay's display and
// we fell back to sources[0] (capture would show the wrong monitor).
const DISPLAY_MATCH_FAILED_HINT = 'captured a different display — display match failed'

// Region screenshots are bound to the display they were selected on; moving the
// overlay to another monitor (or clearing the region) falls back to full screen.
async function captureRegionShot(): Promise<void> {
  if (!win || win.isDestroyed()) return
  try {
    const { image, display, matched } = await captureDisplayFrame()
    const region = config.capture.region
    let cropped = image
    let hint: string | undefined
    if (!region) {
      hint = 'no region set — using full screen'
    } else if (region.displayId !== display.id) {
      hint = 'saved region is on another display — using full screen'
    } else {
      const bounds = image.getSize()
      // DPI/resolution changes make the saved rect meaningless; fail safe.
      if (
        !Number.isFinite(region.frameW) ||
        !Number.isFinite(region.frameH) ||
        Math.abs(region.frameW - bounds.width) > 2 ||
        Math.abs(region.frameH - bounds.height) > 2
      ) {
        hint = 'display changed — re-set the region'
      } else {
        const x = Math.max(0, Math.min(region.x, bounds.width - 1))
        const y = Math.max(0, Math.min(region.y, bounds.height - 1))
        const w = Math.max(1, Math.min(region.w, bounds.width - x))
        const h = Math.max(1, Math.min(region.h, bounds.height - y))
        cropped = image.crop({ x, y, width: w, height: h })
      }
    }
    if (!matched) hint = hint ? `${hint} (${DISPLAY_MATCH_FAILED_HINT})` : DISPLAY_MATCH_FAILED_HINT
    if (!win || win.isDestroyed()) return
    win.webContents.send('shot:image', { dataUrl: jpegDataUrl(cropped), hint })
  } catch (err) {
    console.error('Region capture failed', err)
    if (win && !win.isDestroyed()) {
      win.webContents.send('shot:image', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
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
  const [currentW, currentH] = win.getSize()
  const w = Math.max(360, config.window.width ?? currentW)
  const h = Math.max(280, config.window.height ?? currentH)
  if (
    config.window.x !== null &&
    config.window.y !== null &&
    intersectsAnyDisplay(config.window.x, config.window.y, w, h)
  ) {
    win.setBounds({ x: config.window.x, y: config.window.y, width: w, height: h })
    return
  }
  if (config.window.width !== null || config.window.height !== null) win.setSize(w, h)
  if (config.window.screenMode === 'cursor') {
    topCenterOn(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
  } else {
    topCenterOn(screen.getPrimaryDisplay())
  }
}

function saveWindowPosition(): void {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
  const b = win.getBounds()
  config = {
    ...config,
    window: { ...config.window, x: b.x, y: b.y, width: b.width, height: b.height }
  }
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

// Marker written after a successful one-shot verification, so later launches
// skip the PowerShell spawn entirely.
const TOOLWINDOW_MARKER = 'toolwindow-verified'

function toolWindowMarkerPath(): string {
  return join(app.getPath('userData'), TOOLWINDOW_MARKER)
}

// `type: 'toolbar'` is expected to map to WS_EX_TOOLWINDOW on Windows, which
// hides the overlay from Alt-Tab and window enumeration. The mapping is not
// visible in the shipped Electron typings, so verify it once and enforce it if
// missing. Deliberately no WS_EX_NOACTIVATE: it would break clicking and typing
// into the overlay.
async function ensureToolWindowStyle(): Promise<void> {
  if (!win || win.isDestroyed()) return
  if (existsSync(toolWindowMarkerPath())) {
    console.log('[window] tool window style: previously verified')
    return
  }
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
  // The C# source is base64-encoded so the script contains no embedded quotes.
  const csharp =
    'using System;using System.Runtime.InteropServices;' +
    'public static class WinToolStyle{' +
    '[DllImport("user32.dll")]' +
    'public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd,int nIndex);' +
    '[DllImport("user32.dll")]' +
    'public static extern IntPtr SetWindowLongPtrW(IntPtr hWnd,int nIndex,IntPtr dwNewLong);' +
    '[DllImport("user32.dll")]' +
    'public static extern bool SetWindowPos(IntPtr hWnd,IntPtr hWndInsertAfter,int X,int Y,int cx,int cy,uint uFlags);}'
  const encoded = Buffer.from(csharp, 'utf8').toString('base64')
  const script = [
    `$code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`,
    'Add-Type -TypeDefinition $code;',
    `$h=[IntPtr][Int64]${hwnd};`,
    '$GWL_EXSTYLE=-20;',
    '$WS_EX_TOOLWINDOW=0x80;',
    '$style=([WinToolStyle]::GetWindowLongPtrW($h,$GWL_EXSTYLE)).ToInt64();',
    "if(($style -band $WS_EX_TOOLWINDOW) -ne 0){Write-Output 'already set'}",
    "else{[void][WinToolStyle]::SetWindowLongPtrW($h,$GWL_EXSTYLE,[IntPtr]($style -bor $WS_EX_TOOLWINDOW));" +
      "[void][WinToolStyle]::SetWindowPos($h,[IntPtr]::Zero,0,0,0,0,0x37);Write-Output 'applied'}"
  ].join(' ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }
  )
  const text = String(stdout).trim()
  console.log(`[window] tool window style: ${text || '(no output)'}`)
  if (text === 'already set' || text === 'applied') {
    await fsPromises
      .writeFile(toolWindowMarkerPath(), '', 'utf8')
      .catch((err) => console.error('[window] could not write tool window marker', err))
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 360,
    minHeight: 280,
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
    // Tool window style: hidden from Alt-Tab and window pickers (see helper).
    type: 'toolbar',
    title: '',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // One-shot verification/enforcement (never blocks startup, log-only failures).
  ensureToolWindowStyle().catch((err) =>
    console.error('[window] tool window style check failed', errorText(err))
  )

  applyStealth()
  restoreWindowPosition()

  let moveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = (): void => {
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => saveWindowPosition(), 400)
  }
  win.on('moved', scheduleSave)
  win.on('resized', scheduleSave)

  // Keep the OS window title blank even if the renderer ever sets document.title.
  win.on('page-title-updated', (e) => e.preventDefault())

  // Alt+F4 / taskbar close: save the live transcript first (once per attempt).
  win.on('close', (e) => {
    if (guardQuit()) return
    e.preventDefault()
  })

  // A reload/teardown ends capture; stale "listening" would mute balloons.
  win.webContents.on('did-finish-load', () => {
    rendererListening = false
  })

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return
    if (win.getTitle() !== '') win.setTitle('')
    win.showInactive()
  })

  win.webContents.on('console-message', (event) => {
    const details = event as unknown as { message?: string; level?: string | number }
    const message = details.message ?? ''
    // Transcript/question/answer content is gated; status logs still flow.
    if (!PC_VERBOSE && CONTENT_LOG_RE.test(message)) return
    console.log('[renderer]', message)
  })

  win.on('closed', () => {
    win = null
    rendererListening = false
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

// Global shortcuts are defined once, used for registration and surfaced to
// Settings/README. Registration success is tracked at runtime (a combo may be
// owned by another app); handlers are bound in registerHotkeys().
interface HotkeySpec {
  id: string
  accelerator: string
  description: string
}

const HOTKEYS: HotkeySpec[] = [
  { id: 'move-up', accelerator: 'CommandOrControl+Shift+Up', description: 'Move overlay up' },
  { id: 'move-down', accelerator: 'CommandOrControl+Shift+Down', description: 'Move overlay down' },
  { id: 'move-left', accelerator: 'CommandOrControl+Shift+Left', description: 'Move overlay left' },
  {
    id: 'move-right',
    accelerator: 'CommandOrControl+Shift+Right',
    description: 'Move overlay right'
  },
  { id: 'answer', accelerator: 'CommandOrControl+Shift+Enter', description: 'Answer' },
  { id: 'screenshot', accelerator: 'CommandOrControl+Alt+Enter', description: 'Screenshot' },
  {
    id: 'screenshot-region',
    accelerator: 'CommandOrControl+Alt+R',
    description: 'Region screenshot'
  },
  { id: 'chat', accelerator: 'CommandOrControl+Shift+Space', description: 'Focus chat' },
  // Shift added so the overlay's Hide does not shadow the near-universal
  // Ctrl+H (backspace/replace in editors and terminals).
  { id: 'hide', accelerator: 'CommandOrControl+Shift+H', description: 'Hide' },
  {
    id: 'toggle-click-through',
    accelerator: 'CommandOrControl+Shift+F9',
    description: 'Toggle click-through'
  },
  {
    id: 'move-to-cursor',
    accelerator: 'CommandOrControl+Shift+M',
    description: "Move overlay to the cursor's monitor"
  }
]

const hotkeyStatus = new Map<string, boolean>()

function registerHotkeys(): void {
  const nudge = (dx: number, dy: number): void => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    win.setPosition(b.x + dx, b.y + dy)
  }

  const actions: Record<string, () => void> = {
    'move-up': () => nudge(0, -40),
    'move-down': () => nudge(0, 40),
    'move-left': () => nudge(-40, 0),
    'move-right': () => nudge(40, 0),
    answer: () => sendHotkey('answer'),
    screenshot: () => sendHotkey('screenshot'),
    'screenshot-region': () => void captureRegionShot(),
    chat: () => {
      if (win && !win.isDestroyed()) {
        win.showInactive()
        win.focus()
      }
      sendHotkey('chat')
    },
    hide: () => {
      if (win && !win.isDestroyed()) win.hide()
    },
    'toggle-click-through': () => toggleClickThrough(),
    'move-to-cursor': () => moveToCursorDisplay()
  }

  for (const hotkey of HOTKEYS) {
    const registered = globalShortcut.register(
      hotkey.accelerator,
      actions[hotkey.id] ?? (() => undefined)
    )
    hotkeyStatus.set(hotkey.id, registered)
    if (!registered) {
      console.warn(
        `[hotkeys] ${hotkey.accelerator} not registered — likely owned by another app`
      )
    }
  }
}

async function checkCaptureExclusion(): Promise<CaptureTestCheck> {
  const label = 'OS capture exclusion'
  if (!win || win.isDestroyed()) {
    return {
      id: 'os-capture-exclusion',
      label,
      pass: null,
      detail: 'overlay window is not available'
    }
  }
  try {
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
    // The C# source is base64-encoded so the -Command string contains no double quotes.
    const csharp =
      'using System;using System.Runtime.InteropServices;' +
      'public static class WinAffinity{' +
      '[DllImport("user32.dll")]' +
      'public static extern bool GetWindowDisplayAffinity(IntPtr hWnd,out uint pdwAffinity);}'
    const encoded = Buffer.from(csharp, 'utf8').toString('base64')
    const command = [
      `$code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`,
      'Add-Type -TypeDefinition $code;',
      '$flags=0;',
      `if(-not [WinAffinity]::GetWindowDisplayAffinity([IntPtr][Int64]${hwnd},[ref]$flags)){throw 'GetWindowDisplayAffinity failed'};`,
      'Write-Output $flags'
    ].join(' ')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')
      ],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }
    )
    const text = String(stdout).trim()
    const match = /(\d+)\s*$/.exec(text)
    if (!match) {
      return {
        id: 'os-capture-exclusion',
        label,
        pass: null,
        detail: `could not parse PowerShell output: ${text.slice(0, 200) || '(empty)'}`
      }
    }
    const flags = Number(match[1])
    if (flags === 0x11) {
      return {
        id: 'os-capture-exclusion',
        label,
        pass: true,
        detail:
          'WDA_EXCLUDEFROMCAPTURE set — overlay invisible to screen sharing, recording and screenshots'
      }
    }
    if (flags === 0) {
      return {
        id: 'os-capture-exclusion',
        label,
        pass: false,
        detail: 'overlay is capturable — enable Private mode (screen-capture protection) in Settings'
      }
    }
    return {
      id: 'os-capture-exclusion',
      label,
      pass: null,
      detail: `unexpected display affinity flags 0x${flags.toString(16)}`
    }
  } catch (err) {
    return {
      id: 'os-capture-exclusion',
      label,
      pass: null,
      detail: `check skipped: ${errorText(err)}`
    }
  }
}

// --- PDF and job-page imports --------------------------------------------

interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

interface PdfPageProxy {
  getTextContent(): Promise<{ items: PdfTextItem[] }>
  cleanup?(): void
}

interface PdfDocumentProxy {
  numPages: number
  getPage(page: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

interface PdfModule {
  getDocument(params: { data: Uint8Array; isEvalSupported?: boolean }): {
    promise: Promise<PdfDocumentProxy>
  }
}

const PDF_LEGACY_MODULE: string = 'pdfjs-dist/legacy/build/pdf.mjs'
const MAX_PDF_CHARS = 30_000
const MAX_JOB_CHARS = 10_000
const MAX_JOB_HTML = 500_000

async function extractPdfText(
  filePath: string
): Promise<{ text: string; pagesProcessed: number; truncated: boolean }> {
  const buffer = readFileSync(filePath)
  // A non-literal specifier keeps TypeScript out of pdfjs-dist's subpath typings;
  // Node resolves the legacy ESM build (fake worker) at runtime.
  const pdfjs = (await import(/* @vite-ignore */ PDF_LEGACY_MODULE)) as unknown as PdfModule
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false
  }).promise
  const pages = doc.numPages
  const parts: string[] = []
  let length = 0
  let pagesProcessed = 0
  let truncated = false
  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        pageText += item.hasEOL ? `${item.str}\n` : `${item.str} `
      }
      const trimmed = pageText.trim()
      if (trimmed) parts.push(trimmed)
      length += trimmed.length + 2
      pagesProcessed += 1
      page.cleanup?.()
      if (length >= MAX_PDF_CHARS) {
        truncated = true
        break
      }
    }
    const joined = parts.join('\n\n')
    return {
      text: joined.slice(0, MAX_PDF_CHARS),
      pagesProcessed,
      truncated: truncated || joined.length > MAX_PDF_CHARS
    }
  } finally {
    await doc.destroy()
  }
}

// Automation hook, sibling of PC_AUTOSTART; ships inert without the env var.
// Fire-and-forget so startup is never blocked; logs one JSON line for the verifier.
function runPdfTestHook(): void {
  const file = process.env['PC_PDF_TEST']
  if (!file) return
  if (!existsSync(file)) {
    console.log(`[pdf-test] ${JSON.stringify({ ok: false, error: 'file not found' })}`)
    return
  }
  void extractPdfText(file)
    .then((result) => {
      try {
        writeFileSync(`${file}.extract.txt`, result.text, 'utf8')
      } catch (err) {
        console.warn('[pdf-test] dump failed', err)
      }
      console.log(
        `[pdf-test] ${JSON.stringify({
          ok: true,
          pagesProcessed: result.pagesProcessed,
          truncated: result.truncated,
          textLength: result.text.length
        })}`
      )
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`[pdf-test] ${JSON.stringify({ ok: false, error: message.slice(0, 120) })}`)
    })
}

async function readBodyBounded(
  res: Response,
  controller: AbortController
): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > MAX_JOB_HTML) {
        controller.abort()
        throw new Error('response too large')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

async function fetchJobPage(url: string): Promise<{ title: string; text: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  const checkedHosts = new Set<string>()
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Electron/${process.versions.electron} Safari/537.36`,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }

  try {
    let current = parsed
    let res: Response | null = null
    // Manual redirects so every hop is DNS-checked before we fetch it.
    for (let hop = 0; hop <= 5; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('Only http(s) links are supported')
      }
      const host = normalizeHost(current.hostname)
      if (!checkedHosts.has(host)) {
        await assertPublicHost(host)
        checkedHosts.add(host)
      }
      res = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) break
        current = new URL(location, current)
        continue
      }
      break
    }
    if (!res) throw new Error('Fetch failed')
    if (res.status >= 300 && res.status < 400) throw new Error('Too many redirects')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const html = await readBodyBounded(res, controller)
    const { title, text } = stripHtml(html)
    return { title, text: text.slice(0, MAX_JOB_CHARS) }
  } finally {
    clearTimeout(timer)
  }
}

// One fixed autosave slot, overwritten while listening (see the renderer's
// 120s timer). A successful real save removes it so Home stops offering it.
const AUTOSAVE_FILE = 'autosave.json'

function clearAutosave(dir: string): void {
  for (const file of [AUTOSAVE_FILE, 'autosave.meta.json']) {
    const target = join(dir, file)
    if (!existsSync(target)) continue
    try {
      unlinkSync(target)
    } catch (err) {
      console.error('Could not remove autosave', err)
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => ({ config, corruptBackupPath: corruptConfigBackupPath }))

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    const merged = deepMerge(config, patch)
    config = {
      ...merged,
      llm: normalizeLlm(merged.llm, DEFAULT_CONFIG.llm),
      answer: normalizeAnswer(merged.answer, DEFAULT_CONFIG.answer),
      interaction: normalizeInteraction(merged.interaction)
    }
    persistConfig()
    applyStealth()
    applyMeetingConfig()
    setupUpdates()
    if (win && !win.isDestroyed()) win.webContents.send('config:changed', config)
    return config
  })

  ipcMain.handle('win:hide', () => {
    if (win && !win.isDestroyed()) win.hide()
  })

  ipcMain.handle('win:quit', () => app.quit())

  // Renderer received end-session (and is saving); a hung renderer still quits.
  ipcMain.handle('app:end-session-ack', () => {
    if (!saveBeforeQuitStarted || quitReady) return
    clearQuitWaitTimer()
    quitWaitTimer = setTimeout(() => {
      quitWaitTimer = null
      quitReady = true
      app.quit()
    }, 20_000)
  })

  ipcMain.handle('app:quit-after-save', () => {
    saveBeforeQuitStarted = true
    quitReady = true
    clearQuitWaitTimer()
    app.quit()
  })

  // Balloons are muted while capture runs (they render on the shared screen).
  ipcMain.handle('capture:set-listening', (_e, value: boolean) => {
    rendererListening = value === true
  })

  ipcMain.handle('displays:move-to-cursor', () => {
    moveToCursorDisplay()
    return true
  })

  ipcMain.handle('docs:extract-pdf', async () => {
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
          })
        : await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
          })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      return await extractPdfText(result.filePaths[0])
    } catch (err) {
      throw new Error(`PDF import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  ipcMain.handle('jobs:fetch', async (_e, url: string) => {
    if (typeof url !== 'string' || !url.trim()) throw new Error('Invalid URL')
    return fetchJobPage(url.trim())
  })

  ipcMain.handle('hotkeys:list', () =>
    HOTKEYS.map((hotkey) => ({
      accelerator: hotkey.accelerator,
      description: hotkey.description,
      registered: hotkeyStatus.get(hotkey.id) ?? false
    }))
  )

  ipcMain.handle('session:save', (_e, payload: unknown, opts?: { autosave?: boolean }) => {
    const autosave = opts?.autosave === true
    try {
      const dir = join(app.getPath('userData'), 'sessions')
      mkdirSync(dir, { recursive: true })
      const name = autosave
        ? AUTOSAVE_FILE
        : `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const target = join(dir, name)
      const temp = `${target}.tmp`
      writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temp, target)
      // Summary sidecar keeps sessions:list from parsing image-heavy JSON.
      try {
        const data = (payload && typeof payload === 'object' ? payload : {}) as Record<
          string,
          unknown
        >
        const summary = {
          company: typeof data.company === 'string' ? data.company : '',
          ts: Date.now(),
          title: typeof data.title === 'string' ? data.title : 'Untitled',
          endedAt: typeof data.endedAt === 'string' ? data.endedAt : null,
          segments: Array.isArray(data.segments) ? data.segments.length : 0,
          answers: Array.isArray(data.answers) ? data.answers.length : 0
        }
        const metaTarget = join(dir, `${name.replace(/\.json$/i, '')}.meta.json`)
        const metaTemp = `${metaTarget}.tmp`
        writeFileSync(metaTemp, JSON.stringify(summary, null, 2), 'utf8')
        renameSync(metaTemp, metaTarget)
      } catch (err) {
        console.error('Session summary save failed', err)
      }
      // The live transcript is now a real session; drop the recovery slot.
      if (!autosave) clearAutosave(dir)
      return name
    } catch (err) {
      console.error('Session save failed', err)
      // Reject instead of returning null: the renderer treats a falsy result as
      // "nothing to save", so a failed transcript write would look like success.
      throw new Error(
        `Session save failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  ipcMain.handle('shot:capture', async () => {
    const { image, matched } = await captureDisplayFrame()
    return {
      dataUrl: jpegDataUrl(image),
      hint: matched ? undefined : DISPLAY_MATCH_FAILED_HINT
    }
  })

  // Source frame + display id for the in-overlay region picker (not attached).
  ipcMain.handle('shot:capture-source', async () => {
    const { image, display } = await captureDisplayFrame()
    return { dataUrl: jpegDataUrl(image), displayId: display.id }
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
      const profile = activeProfile(config.llm)
      const endpoint = profile.baseUrl.replace(/\/+$/, '') + '/chat/completions'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (profile.apiKey) headers['Authorization'] = `Bearer ${profile.apiKey}`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chatBody(profile, [{ role: 'user', content: 'Reply with exactly: OK' }], {
            stream: false,
            escalate: false
          })
        )
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

  ipcMain.handle('test:capture', async (): Promise<CaptureTestReport> => {
    const checks: CaptureTestCheck[] = []

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 }
      })
      const source = sources.find((s) => !s.thumbnail.isEmpty())
      if (source) {
        checks.push({
          id: 'screen-capture',
          label: 'Screen capture',
          pass: true,
          detail: `${sources.length} screen source(s); thumbnail ${source.thumbnail.toJPEG(85).length} bytes JPEG`
        })
      } else {
        checks.push({
          id: 'screen-capture',
          label: 'Screen capture',
          pass: false,
          detail:
            sources.length === 0
              ? 'no screen sources were returned'
              : 'screen sources returned but every thumbnail was empty'
        })
      }
    } catch (err) {
      checks.push({
        id: 'screen-capture',
        label: 'Screen capture',
        pass: false,
        detail: err instanceof Error ? err.message : String(err)
      })
    }

    checks.push(await checkCaptureExclusion())

    try {
      if (!win || win.isDestroyed()) {
        checks.push({
          id: 'window-picker-hidden',
          label: 'Hidden from window pickers',
          pass: null,
          detail: 'overlay window is not available'
        })
      } else {
        const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 }
        })
        // Source ids are `window:<HWND>:<other>` (or bare numbers on some
        // platforms); only pure-digit handles are recognized. Unrecognized
        // formats are rejected, making the check fail-closed (skipped).
        const handleOf = (id: string): string | null => {
          const [kind, handle] = id.split(':')
          if (kind === 'window') return handle && /^\d+$/.test(handle) ? handle : null
          return /^\d+$/.test(id) ? id : null
        }
        const recognized = sources
          .map((source) => ({ source, handle: handleOf(source.id) }))
          .filter((entry): entry is { source: (typeof sources)[number]; handle: string } =>
            entry.handle !== null
          )
        if (recognized.length === 0) {
          checks.push({
            id: 'window-picker-hidden',
            label: 'Hidden from window pickers',
            pass: null,
            detail: 'unrecognized source id format — check skipped'
          })
        } else {
          const overlay = recognized.find((entry) => BigInt(entry.handle) === hwnd)?.source
          checks.push({
            id: 'window-picker-hidden',
            label: 'Hidden from window pickers',
            pass: !overlay,
            detail: overlay
              ? `overlay window (HWND ${hwnd.toString()}) is offered as "${overlay.name}"`
              : `overlay HWND not among ${sources.length} enumerated windows`
          })
        }
      }
    } catch (err) {
      checks.push({
        id: 'window-picker-hidden',
        label: 'Hidden from window pickers',
        pass: null,
        detail: `check skipped: ${err instanceof Error ? err.message : String(err)}`
      })
    }

    return { checks, ranAt: Date.now() }
  })

  ipcMain.handle('sessions:list', () => {
    try {
      const dir = join(app.getPath('userData'), 'sessions')
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((f) => /^[\w.-]+\.json$/.test(f) && !f.endsWith('.meta.json'))
        .map((name) => {
          try {
            const metaPath = join(dir, `${name.replace(/\.json$/i, '')}.meta.json`)
            if (existsSync(metaPath)) {
              try {
                const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
                return {
                  name,
                  title: typeof meta.title === 'string' ? meta.title : 'Untitled',
                  company: typeof meta.company === 'string' ? meta.company : '',
                  endedAt:
                    typeof meta.endedAt === 'string'
                      ? meta.endedAt
                      : typeof meta.ts === 'number'
                        ? new Date(meta.ts).toISOString()
                        : null,
                  segments: typeof meta.segments === 'number' ? meta.segments : 0,
                  answers: typeof meta.answers === 'number' ? meta.answers : 0
                }
              } catch {
                /* corrupt sidecar: fall back to the full session */
              }
            }
            const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
              string,
              unknown
            >
            return {
              name,
              title: typeof data.title === 'string' ? data.title : 'Untitled',
              company: typeof data.company === 'string' ? data.company : '',
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

  ipcMain.handle('sessions:export', (_e, name: string) => {
    if (!/^[\w.-]+\.json$/.test(name) || basename(name) !== name) {
      throw new Error('Invalid session name')
    }
    const dir = join(app.getPath('userData'), 'sessions')
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      title?: string
      endedAt?: string
      segments?: Array<{ id?: string; speaker?: string; text?: string }>
      answers?: Array<{ text?: string; error?: string; question?: string; anchorId?: string }>
    }
    const outPath = join(dir, `${name.replace(/\.json$/i, '')}.md`)
    writeFileSync(outPath, buildSessionMarkdown(data), 'utf8')
    return outPath
  })

  ipcMain.handle('sessions:delete', (_e, name: string) => {
    if (!/^[\w.-]+\.json$/.test(name) || basename(name) !== name) {
      throw new Error('Invalid session name')
    }
    const dir = join(app.getPath('userData'), 'sessions')
    unlinkSync(join(dir, name))
    // Drop the summary sidecar and the sibling Markdown export too.
    const stem = name.replace(/\.json$/i, '')
    const metaPath = join(dir, `${stem}.meta.json`)
    if (existsSync(metaPath)) {
      try {
        unlinkSync(metaPath)
      } catch (err) {
        console.error('Could not delete session summary', err)
      }
    }
    const exportPath = join(dir, `${stem}.md`)
    if (existsSync(exportPath)) {
      try {
        unlinkSync(exportPath)
      } catch (err) {
        console.error('Could not delete session export', err)
      }
    }
    return true
  })

  ipcMain.handle('sessions:delete-all', () => {
    const dir = join(app.getPath('userData'), 'sessions')
    if (!existsSync(dir)) return 0
    let count = 0
    for (const file of readdirSync(dir)) {
      const isMeta = file.endsWith('.meta.json')
      const isSession = /^[\w.-]+\.json$/.test(file) && !isMeta
      const isExport = /^[\w.-]+\.md$/.test(file)
      if (!isSession && !isExport && !isMeta) continue
      try {
        unlinkSync(join(dir, file))
        if (isSession) count += 1
      } catch {
        /* skip locked files */
      }
    }
    return count
  })

  ipcMain.handle('updates:check', async () => {
    if (updateFeedError) {
      return { ok: false, error: updateFeedError }
    }
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
    // Update restart must not wait on a transcript save prompt.
    quitReady = true
    clearQuitWaitTimer()
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('llm:chat', async (event, req: ChatRequest) => {
    const ctrl = new AbortController()
    aborters.set(req.id, ctrl)

    // Resolved per request from the live config, so switching profiles changes
    // the next ask without a restart or touching an in-flight stream.
    const profile = activeProfile(config.llm)
    const endpoint = profile.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (profile.apiKey) headers['Authorization'] = `Bearer ${profile.apiKey}`

    // The renderer always sends [system, ...assistant turns, user]. `last` is
    // captured before assembly because the multimodal form replaces that turn.
    const last = req.messages[req.messages.length - 1]
    const { systemPrompt, priorTurns, question } = decomposeMessages(req.messages)
    const messages = buildChatMessages({
      systemPrompt,
      priorTurns,
      // An empty request has no user turn; the blank question is only the
      // decomposition's placeholder.
      question: req.messages.length > 0 ? question.content : undefined,
      images: req.images,
      vision: req.vision
    })

    // Auto-escalate only from 'low'; the regex is intentionally narrow.
    // An explicit coding question type acts as escalateOnCode for this ask.
    const codingAsk = req.questionType === 'coding'
    const escalate =
      (codingAsk || profile.escalateOnCode) &&
      (codingAsk || req.images.length > 0 || CODE_RE.test(last?.content ?? ''))

    const body = chatBody(profile, messages, { stream: true, escalate })

    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    let streamTimedOut = false
    // Anti-deadlock backstop for a hung endpoint (accepts the connection but
    // never responds) — not a latency budget. Multi-image + deep-thinking asks
    // legitimately take 20–60s+ to first byte, so the deadline scales with the
    // payload: 60s base + 5s per image, capped at 120s. The timer is cleared
    // once headers arrive: a live fetch's signal also governs body streaming,
    // so a remaining deadline timer would cut long answers.
    const responseDeadlineMs = computeResponseDeadlineMs(req.images.length)
    const deadlineCtrl = new AbortController()
    let deadlineMessage = ''
    const deadlineTimer = setTimeout(() => {
      const seconds = Math.round(responseDeadlineMs / 1000)
      deadlineMessage =
        req.images.length > 0
          ? `Model didn't respond within ${seconds}s (${req.images.length} images attached — try fewer or cropped screenshots, or a faster model profile)`
          : `Model didn't respond within ${seconds}s — check your endpoint`
      deadlineCtrl.abort(new DOMException('Response deadline exceeded', 'TimeoutError'))
    }, responseDeadlineMs)
    const deadlineSignal = AbortSignal.any([ctrl.signal, deadlineCtrl.signal])
    const clearStreamIdleTimer = (): void => {
      if (streamIdleTimer) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }

    try {
      // 429/5xx retries (1s, 3s) happen only before the stream starts; once
      // tokens flow there is no retry, so the user never sees a silent restart.
      const res = await fetchChatWithRetry(
        endpoint,
        { method: 'POST', headers, body: JSON.stringify(body), signal: deadlineSignal },
        deadlineSignal
      )
      clearTimeout(deadlineTimer)

      const stream = res.body
      if (!stream) throw new Error('LLM error: response has no body')
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''

      const resetStreamIdleTimer = (): void => {
        clearStreamIdleTimer()
        streamIdleTimer = setTimeout(() => {
          streamTimedOut = true
          ctrl.abort()
        }, STREAM_IDLE_TIMEOUT_MS)
      }
      resetStreamIdleTimer()

      const emit = (text: string): void => {
        resetStreamIdleTimer()
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
      clearStreamIdleTimer()
      event.sender.send('llm:done', { id: req.id })
      verboseLog(`[llm-answer] ${full}`)
      return { ok: true, text: full }
    } catch (err) {
      const deadlineExceeded = deadlineCtrl.signal.aborted && !ctrl.signal.aborted
      const message = streamTimedOut
        ? 'no response from the model for 20s — check your endpoint'
        : deadlineExceeded && deadlineMessage
          ? deadlineMessage
          : err instanceof Error
            ? err.message
            : String(err)
      event.sender.send('llm:error', { id: req.id, message })
      throw new Error(message)
    } finally {
      clearTimeout(deadlineTimer)
      clearStreamIdleTimer()
      aborters.delete(req.id)
    }
  })

  ipcMain.handle('llm:abort', (_e, id: string) => {
    aborters.get(id)?.abort()
    aborters.delete(id)
  })
}

// A stalled whisper-server must fail visibly instead of hanging the ASR chain.
const ASR_TIMEOUT_MS = 30_000

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

  const send = (): Promise<Response> =>
    fetch(config.asr.url, {
      method: 'POST',
      body: form,
      headers,
      // Fresh 30s budget per attempt, so a retry cannot inherit a spent timeout.
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS)
    })
  let res: Response
  try {
    res = await send()
  } catch (err) {
    // One retry only for a transport-level failure (connection reset, DNS
    // flap) — never for an HTTP error status or our own timeout/abort. Covers
    // the transient network blips that otherwise drop a whole transcript chunk.
    if (
      err instanceof DOMException &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      throw err
    }
    console.warn('[asr] network error — retrying once', errorText(err))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    res = await send()
  }
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

async function listMeetingTitles(): Promise<string[]> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    return sources.map((source) => source.name.trim()).filter(Boolean)
  } catch {
    return []
  }
}

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
  if (polling) return
  polling = true
  try {
    const [names, titles] = await Promise.all([listProcessNames(), listMeetingTitles()])
    const processHits = names.filter((name) => MEETING_APPS.includes(name))
    const titleHit = meetingTitleHit(titles)
    const titleAlwaysOn = titleHit ? isAlwaysOnTitle(titleHit.title) : false
    const hits = [
      ...processHits.map((name) => ({ label: name, alwaysOn: isAlwaysOnApp(name) })),
      ...(titleHit ? [{ label: titleHit.label, alwaysOn: titleAlwaysOn }] : [])
    ]
    const nonAlwaysOn = hits.filter((hit) => !hit.alwaysOn)
    // Auto-start needs a confirmed meeting app process or a meeting-specific
    // browser/Teams/Zoom title; generic "Meet - X" / "FaceTime" titles only
    // notify, since they can be an idle tab or app.
    const autoStartEligible =
      processHits.some((name) => !isAlwaysOnApp(name)) || titleHit?.strong === true
    // Slack all day + a meeting starting at 2pm must still auto-start: the latch
    // tracks the non-always-on signature, not just "something is active".
    const sig = nonAlwaysOn
      .map((hit) => hit.label)
      .sort()
      .join('|')
    const active = hits.length > 0

    // Balloons paint on the shared screen, so they are opt-in and never include
    // the matched app name/window title (which can leak the meeting subject).
    const notify = (kind: 'meeting' | 'background'): void => {
      if (!config.meetings.balloon || rendererListening) return
      try {
        tray?.displayBalloon({
          title: 'Parakeet Clone',
          content: kind === 'meeting' ? 'Meeting detected' : 'Background app detected',
          iconType: 'info'
        })
      } catch {
        /* balloons unsupported */
      }
    }

    if (sig && sig !== meetingSig) {
      alwaysOnNotified = false
      const signals: string[] = []
      if (processHits.length > 0) signals.push(`process ${processHits.join(', ')}`)
      if (titleHit) signals.push(`window ${titleHit.label}`)
      console.log('[meeting] detected via', signals.join(' + '))
      notify('meeting')
      if (config.meetings.autoStart && autoStartEligible) sendHotkey('autostart')
      else if (config.meetings.autoStart)
        console.log('[meeting] title match only — not auto-starting')
      meetingSig = sig
    } else if (!sig && meetingSig) {
      meetingSig = ''
      console.log('[meeting] ended')
      // Returning to an always-on-only state should not re-notify on the next poll.
      alwaysOnNotified = active
    } else if (active && !sig && !alwaysOnNotified) {
      alwaysOnNotified = true
      console.log(
        '[meeting] always-on app detected (no auto-start):',
        hits.map((hit) => hit.label).join(', ')
      )
      notify('background')
    } else if (!active && alwaysOnNotified) {
      alwaysOnNotified = false
    }
  } finally {
    polling = false
  }
}

function startMeetingDetector(): void {
  if (!config.meetings.detect || meetingTimer) return
  meetingSig = ''
  alwaysOnNotified = false
  // Meeting starts are not sub-15s-critical; 15s keeps tasklist/source polling
  // cheap. pollMeeting() ignores a tick that arrives while the previous is live.
  meetingTimer = setInterval(() => void pollMeeting(), 15_000)
  void pollMeeting()
}

function stopMeetingDetector(): void {
  if (meetingTimer) clearInterval(meetingTimer)
  meetingTimer = null
  meetingSig = ''
  alwaysOnNotified = false
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
  if (!config.updates.enabled || !config.updates.feedUrl) {
    updateFeedError = null
    return
  }
  // Unsigned updates over plain http are the last unguarded link in the update
  // chain; refuse to configure the updater for anything but https.
  let feed: URL
  try {
    feed = new URL(config.updates.feedUrl)
  } catch {
    updateFeedError = 'Feed URL must be https://...'
    console.warn('[updates] refusing to configure updater:', updateFeedError)
    return
  }
  if (feed.protocol !== 'https:') {
    updateFeedError = 'Feed URL must be https://...'
    console.warn('[updates] refusing to configure updater:', updateFeedError)
    return
  }
  updateFeedError = null
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: config.updates.feedUrl })
  } catch (err) {
    console.error('Invalid update feed', err)
    updateFeedError = 'Invalid update feed URL'
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

  // Only these permissions are needed: 'media' covers getUserMedia for the
  // optional "You" channel, 'display-capture' covers getDisplayMedia/loopback
  // capture (a distinct Chromium permission type in Electron), and
  // 'clipboard-sanitized-write' covers the Copy buttons without granting
  // clipboard reads. Deny everything else rather than blanket-granting every
  // Electron permission.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(
      permission === 'media' ||
        permission === 'display-capture' ||
        permission === 'clipboard-sanitized-write'
    )
  )
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
      // Content gating: interview material never goes to stdout. Lengths (and
      // the title/company fields) still prove the config loaded and is shaped
      // correctly without printing résumé, background, JD or extra context.
      profile: {
        resume: `<${config.profile.resume.length} chars>`,
        background: `<${config.profile.background.length} chars>`,
        vocabulary: `<${config.profile.vocabulary.length} chars>`
      },
      session: {
        ...config.session,
        jobDescription: `<${config.session.jobDescription.length} chars>`,
        extraContext: `<${config.session.extraContext.length} chars>`
      },
      llm: {
        ...config.llm,
        apiKey: config.llm.apiKey ? '***' : '',
        profiles: config.llm.profiles.map((profile) => ({
          ...profile,
          apiKey: profile.apiKey ? '***' : ''
        }))
      },
      asr: { ...config.asr, apiKey: config.asr.apiKey ? '***' : '' }
    }
    console.log('[config]', JSON.stringify(redacted))
    registerDisplayMedia()
    console.log('[boot] display media ready')
    registerIpc()
    console.log('[boot] ipc ready')
    createWindow()
    console.log('[boot] window created')
    runPdfTestHook()
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

app.on('before-quit', (e) => {
  if (guardQuit()) return
  e.preventDefault()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
