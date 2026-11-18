import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import type {
  AppConfig,
  CaptureTestCheck,
  ChatMessage,
  QuestionType,
  ResolvedQuestionType,
  SpeedBadge
} from '../../shared/types'
import {
  parseStructuredAnswerText as parseStructuredAnswer,
  sanitizeFenceLanguage,
  type StructuredAnswer
} from '../../shared/structuredAnswer'
import { buildWhisperPrompt } from '../../shared/whisper-prompt'
import { buildSystemPrompt } from '../../shared/prompt'
import {
  isQuestion,
  looksCompleteQuestion,
  resolveQuestionType,
  similarity
} from '../../shared/question-heuristics'
import HistoryView, { type SessionData, type SessionSummary } from './HistoryView'
import SettingsView from './SettingsView'
import type { UpdateState } from '../../preload/index'
import {
  AudioEngine,
  startMicStream,
  startSystemStream,
  type Speaker
} from './lib/audio'
import { CoalesceController } from './lib/coalesce'

interface Segment {
  id: string
  speaker: Speaker
  text: string
  ts: number
  partial?: boolean
}

interface ThemPcmChunk {
  uid: number
  pcm: Uint8Array
  at: number
}

interface Answer {
  id: string
  text: string
  streaming: boolean
  error?: string
  question?: string
  transcript?: string
  /** id of the transcript segment this answer responds to ("final-Them-<uid>") */
  anchorId?: string
  /** Parsed card; absent when the model ignored the contract (raw fallback). */
  card?: StructuredAnswer
  /** Screenshot data URLs sent with this ask (capped when saved). */
  images?: string[]
}

// Wrap concatenated 16 kHz mono 16-bit PCM blocks in a fresh WAV header.
// Header math: RIFF size = 36 + data, byte rate = 16000 * 1 * 2, block align = 2.
function encodePcmWav(blocks: Uint8Array[]): ArrayBuffer {
  let dataLength = 0
  for (const block of blocks) dataLength += block.length
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const writeStr = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLength, true)
  const bytes = new Uint8Array(buffer)
  let offset = 44
  for (const block of blocks) {
    bytes.set(block, offset)
    offset += block.length
  }
  return buffer
}

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  auto: 'Auto',
  behavioral: 'Behavioral',
  coding: 'Coding',
  'system-design': 'System design',
  experience: 'Experience check',
  technical: 'Technical knowledge',
  other: 'Other'
}

const QUESTION_TYPE_OPTIONS: ResolvedQuestionType[] = [
  'behavioral',
  'coding',
  'system-design',
  'experience',
  'technical',
  'other'
]

const QUESTION_TYPE_MENU: QuestionType[] = ['auto', ...QUESTION_TYPE_OPTIONS]

function structuredAnswerText(card: StructuredAnswer): string {
  const parts: string[] = []
  if (card.approach) parts.push(card.approach)
  if (card.keySteps.length > 0) {
    parts.push(card.keySteps.map((step, index) => `${index + 1}. ${step}`).join('\n'))
  }
  if (card.code.source) {
    parts.push(`\`\`\`${sanitizeFenceLanguage(card.code.language)}\n${card.code.source}\n\`\`\``)
  }
  const complexity = [
    card.complexity.time && `time ${card.complexity.time}`,
    card.complexity.space && `space ${card.complexity.space}`
  ].filter(Boolean)
  if (complexity.length > 0) parts.push(`Complexity: ${complexity.join('; ')}`)
  return parts.join('\n\n')
}

function StructuredAnswerCard({ card }: { card: StructuredAnswer }) {
  return (
    <div className="answer-card">
      {card.approach && <div className="answer-approach">{card.approach}</div>}
      {card.keySteps.length > 0 && (
        <ol className="answer-steps">
          {card.keySteps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      {card.code.source && (
        <div className="answer-code">
          <div className="answer-code-head">
            <span className="mono">{card.code.language || 'code'}</span>
            <button
              className="copy"
              title="Copy code"
              onClick={() => void navigator.clipboard.writeText(card.code.source)}
            >
              Copy
            </button>
          </div>
          <pre className="answer-code-body">{card.code.source}</pre>
        </div>
      )}
      {(card.complexity.time || card.complexity.space) && (
        <div className="answer-complexity">
          {card.complexity.time && (
            <span className="complexity-chip">Time {card.complexity.time}</span>
          )}
          {card.complexity.space && (
            <span className="complexity-chip">Space {card.complexity.space}</span>
          )}
        </div>
      )}
    </div>
  )
}

// Thread rows are memoized on the immutable per-entry objects. A streaming
// answer replaces only its own object, so every other row skips re-rendering.
const SegmentRow = memo(function SegmentRow({ segment }: { segment: Segment }) {
  return (
    <div className={`seg${segment.partial ? ' partial' : ''}`}>
      <span className={`speaker ${segment.speaker === 'You' ? 'you' : 'them'}`}>
        {segment.speaker}
      </span>
      <span className="seg-text">
        {segment.text}
        {segment.partial ? ' …' : ''}
      </span>
    </div>
  )
})

interface AnswerRowProps {
  answer: Answer
  onRegenerate: (answer: Answer) => void
  onStop: (id: string) => void
}

const AnswerRow = memo(function AnswerRow({ answer, onRegenerate, onStop }: AnswerRowProps) {
  return (
    <div className="answer">
      <div className="answer-head">
        <span className="speaker answer-tag">Answer</span>
        {answer.streaming && <span className="streaming">…</span>}
        {answer.card && <span className="answer-kind">coded</span>}
        <div className="answer-actions">
          {answer.streaming && (
            <button
              className="copy"
              title="Stop generating"
              onClick={() => onStop(answer.id)}
            >
              ✕
            </button>
          )}
          {!answer.streaming && !answer.error && (
            <button className="copy" onClick={() => onRegenerate(answer)}>
              Regenerate
            </button>
          )}
          <button
            className="copy"
            title="Copy"
            onClick={() =>
              void navigator.clipboard.writeText(
                answer.card ? structuredAnswerText(answer.card) : answer.text
              )
            }
          >
            Copy
          </button>
        </div>
      </div>
      {answer.error ? (
        <div className="answer-error">{answer.error}</div>
      ) : answer.card ? (
        <StructuredAnswerCard card={answer.card} />
      ) : (
        <div className="answer-text">{answer.text || (answer.streaming ? '' : '—')}</div>
      )}
    </div>
  )
})

// In-memory render cap; sessions keep everything retained. Raised for long interviews.
const MAX_SEGMENTS = 2000
// Answers can exceed the old 10-row window in long sessions; memoized rows keep
// rendering cheap and buildSavePayload persists every retained answer.
const MAX_ANSWERS = 2000

// Session JSON keeps only the most recent screenshots to bound file size.
const MAX_SESSION_IMAGES = 10

// Queued follow-ups older than this are stale for a live interview and dropped.
const QUEUE_TTL_MS = 60_000

// While listening, snapshot the live session so a crash/quit loses at most this.
const AUTOSAVE_INTERVAL_MS = 120_000
const AUTOSAVE_FILE_NAME = 'autosave.json'

// Overall cap for letting in-flight finals land before End/quit saves.
const CHAIN_DRAIN_TIMEOUT_MS = 4000

const BADGE_LABELS: Record<SpeedBadge, string> = {
  recommended: 'Recommended',
  fast: 'Fast',
  slow: 'Slow',
  'very-slow': 'Very slow'
}

function badgeLabel(badge: SpeedBadge): string {
  return BADGE_LABELS[badge]
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const text = String(err)
  try {
    const parsed = JSON.parse(text) as { message?: string }
    if (parsed?.message) return parsed.message
  } catch {
    /* ignore */
  }
  return text
}

async function runRendererCaptureChecks(): Promise<CaptureTestCheck[]> {
  const checks: CaptureTestCheck[] = []

  let loopback: MediaStream | null = null
  try {
    loopback = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    const ok = loopback.getAudioTracks().length > 0
    checks.push({
      id: 'silent-loopback',
      label: 'Loopback audio (no picker)',
      pass: ok,
      detail: ok
        ? 'loopback audio captured with no picker/prompt'
        : 'getDisplayMedia resolved but provided no audio track'
    })
  } catch (err) {
    checks.push({
      id: 'silent-loopback',
      label: 'Loopback audio (no picker)',
      pass: false,
      detail: errorMessage(err)
    })
  } finally {
    loopback?.getTracks().forEach((track) => track.stop())
  }

  let mic: MediaStream | null = null
  const micLabel = "Mic access (optional — needed only for the 'You' channel)"
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    checks.push({
      id: 'mic-access',
      label: micLabel,
      pass: true,
      detail: 'microphone opened successfully'
    })
  } catch (err) {
    checks.push({
      id: 'mic-access',
      label: micLabel,
      pass: null,
      detail: `optional — ${errorMessage(err)}`
    })
  } finally {
    mic?.getTracks().forEach((track) => track.stop())
  }

  return checks
}

const HALLUCINATIONS = new Set([
  'thank you',
  'thanks for watching',
  'thanks for watching!',
  'the water is very clean',
  'the water is very clean.',
  'please subscribe',
  'subtitles by',
  'you',
  'bye',
  'okay.',
  'okay'
])

function uid(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')
  )
}

function focusMenuActiveItem(menu: HTMLElement | null): void {
  if (!menu) return
  const items = menuItems(menu)
  const active = items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0]
  active?.focus()
}

// Shared chip-menu keyboard behavior: arrows wrap, Escape closes and restores
// focus to the trigger, and Enter/Space stay native button activation.
function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  close: () => void,
  trigger: HTMLButtonElement | null
): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    trigger?.focus()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const items = menuItems(event.currentTarget)
  if (items.length === 0) return
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const delta = event.key === 'ArrowDown' ? 1 : -1
  const next =
    current < 0
      ? delta > 0
        ? 0
        : items.length - 1
      : (current + delta + items.length) % items.length
  items[next]?.focus()
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [view, setView] = useState<'home' | 'live' | 'settings' | 'history'>('home')
  const [segments, setSegments] = useState<Segment[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [listening, setListening] = useState(false)
  const [questionMenuOpen, setQuestionMenuOpen] = useState(false)
  const [attachments, setAttachments] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('Interview session')
  const [company, setCompany] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [jobUrl, setJobUrl] = useState('')
  const [jobFetching, setJobFetching] = useState(false)
  const [extraContext, setExtraContext] = useState('')
  const [resume, setResume] = useState('')
  const [background, setBackground] = useState('')
  const [vocabulary, setVocabulary] = useState('')
  const [historyList, setHistoryList] = useState<SessionSummary[]>([])
  const [historyDetail, setHistoryDetail] = useState<SessionData | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [pendingResumePdf, setPendingResumePdf] = useState<{
    text: string
    pagesProcessed: number
    truncated: boolean
  } | null>(null)
  const [pendingJobReplaceUrl, setPendingJobReplaceUrl] = useState<string | null>(null)
  const [asrWarning, setAsrWarning] = useState(false)
  const [autosaveBannerDismissed, setAutosaveBannerDismissed] = useState(false)
  const [corruptBackup, setCorruptBackup] = useState<string | null>(null)
  const [corruptBannerDismissed, setCorruptBannerDismissed] = useState(false)
  const [updateReady, setUpdateReady] = useState<{ version: string } | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false)
  const [regionShot, setRegionShot] = useState<{ dataUrl: string; displayId: number } | null>(null)
  const [regionSel, setRegionSel] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  )
  const [regionSaving, setRegionSaving] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  const engines = useRef<{ you?: AudioEngine; them?: AudioEngine } | null>(null)
  const chains = useRef<Record<Speaker, Promise<void>>>({ You: Promise.resolve(), Them: Promise.resolve() })
  const partialBusy = useRef<Record<Speaker, boolean>>({ You: false, Them: false })
  const partialSeq = useRef<Record<Speaker, number>>({ You: 0, Them: 0 })
  const partialInfo = useRef<
    Record<Speaker, { uid: number; applied: number; finalizing: boolean }>
  >({
    You: { uid: -1, applied: 0, finalizing: false },
    Them: { uid: -1, applied: 0, finalizing: false }
  })
  const streaming = useRef(false)
  // Answers the user stopped: their abort rejection is a silent stop, not an error.
  const abortedAnswers = useRef<Set<string>>(new Set())
  const structuredAnswers = useRef<Set<string>>(new Set())
  const lastAnswerAt = useRef(0)
  const pendingAsks = useRef<Array<{ question: string; anchorUid: number; queuedAt: number }>>([])
  const askedUids = useRef<Set<number>>(new Set())
  const configRef = useRef<AppConfig | null>(null)
  const segmentsRef = useRef<Segment[]>([])
  const answersRef = useRef<Answer[]>([])
  // Bumped only when a saved session is cleared, NOT on Stop. A Stop→Start
  // resume is the same interview, so a late whisper result should still append;
  // results resolving after clearAll (next session) are dropped.
  const sessionEpochRef = useRef(0)
  const promptRef = useRef<Record<Speaker, string>>({ You: '', Them: '' })
  const titleRef = useRef(title)
  const companyRef = useRef(company)
  const endRef = useRef<(thenQuit: boolean) => void>(() => undefined)
  const asrFailures = useRef<Record<Speaker, number>>({ You: 0, Them: 0 })
  const asrWarningDismissed = useRef(false)
  // Set once the current session's transcript has been written for real; a
  // later Quit/close must not save a duplicate.
  const transcriptSavedRef = useRef(false)
  // End is idempotent: a second concurrent call (End, then Alt+F4) returns
  // immediately instead of snapshotting twice into two session files.
  const endingSessionRef = useRef(false)
  // A quit request that lands during an in-flight End still quits after it.
  const endQuitPendingRef = useRef(false)
  const askRef = useRef<(question?: string, anchorUid?: number, useAttachments?: boolean) => void>(
    () => undefined
  )
  const regenerateRef = useRef<(answer: Answer) => void>(() => undefined)
  const shotRef = useRef<() => void>(() => undefined)
  const beginRef = useRef<() => void>(() => undefined)
  const listeningRef = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const queueTimer = useRef<number | null>(null)
  const themPcm = useRef<ThemPcmChunk[]>([])
  const coalesceControllerRef = useRef<CoalesceController | null>(null)
  const regionDrag = useRef<{ startX: number; startY: number; rect: DOMRect } | null>(null)
  const regionImgRef = useRef<HTMLImageElement | null>(null)
  const modelSwitchRef = useRef<HTMLDivElement | null>(null)
  const questionSwitchRef = useRef<HTMLDivElement | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const questionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const questionMenuRef = useRef<HTMLDivElement | null>(null)
  // Direct-DOM meter state: no React state per RMS sample (see handleLevel).
  const meterBars = useRef<{ you: HTMLDivElement | null; them: HTMLDivElement | null }>({
    you: null,
    them: null
  })
  const meterPeak = useRef({ you: 0, them: 0 })
  const meterPeakAt = useRef({ you: 0, them: 0 })
  const meterDecayFrom = useRef({ you: 0, them: 0 })
  const meterDecayStart = useRef({ you: 0, them: 0 })
  const meterRaf = useRef<number | null>(null)
  const noAudioTimer = useRef<number | null>(null)
  const themZeroSince = useRef<number | null>(null)
  const noAudioWarned = useRef(false)
  const toastTimer = useRef<number | null>(null)

  configRef.current = config
  titleRef.current = title
  companyRef.current = company
  answersRef.current = answers
  listeningRef.current = listening

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  // Main also refuses to install while a session is live; a false result means
  // the call raced the listening guard, so explain instead of doing nothing.
  const installUpdate = useCallback((): void => {
    void window.api.installUpdate().then((started) => {
      if (!started) showToast('End your session first — installing restarts the app')
    })
  }, [showToast])

  // Peak-hold meter painted directly on the DOM: the audio callback runs ~4x/s
  // and must not re-render the whole app. rAF stops once both peaks decay.
  const tickMeters = useCallback(() => {
    meterRaf.current = null
    const now = performance.now()
    let active = false
    for (const key of ['you', 'them'] as const) {
      const idle = now - meterPeakAt.current[key]
      if (idle > 1000) {
        // Snapshot the held peak once at expiry, then decay from that original
        // value. Multiplying the already-decayed peak each frame compounded.
        if (meterDecayStart.current[key] === 0) {
          meterDecayFrom.current[key] = meterPeak.current[key]
          meterDecayStart.current[key] = meterPeakAt.current[key] + 1000
        }
        meterPeak.current[key] =
          meterDecayFrom.current[key] *
          Math.exp(-(now - meterDecayStart.current[key]) / 600)
        if (meterPeak.current[key] < 0.001) meterPeak.current[key] = 0
      }
      const bar = meterBars.current[key]
      if (bar) bar.style.width = `${Math.min(100, meterPeak.current[key] * 900)}%`
      if (meterPeak.current[key] > 0.001) active = true
    }
    if (active) meterRaf.current = window.requestAnimationFrame(tickMeters)
  }, [])

  const handleLevel = useCallback(
    (speaker: Speaker, rms: number) => {
      const key = speaker === 'You' ? 'you' : 'them'
      const now = performance.now()
      if (rms >= meterPeak.current[key]) {
        meterPeak.current[key] = rms
        meterPeakAt.current[key] = now
        meterDecayStart.current[key] = 0
      }
      if (meterRaf.current === null) {
        meterRaf.current = window.requestAnimationFrame(tickMeters)
      }
      if (key !== 'them') return
      // One-time field guide: a silent loopback is the usual capture failure.
      if (rms < 0.001) {
        if (themZeroSince.current === null) themZeroSince.current = now
        else if (!noAudioWarned.current && now - themZeroSince.current >= 20_000) {
          noAudioWarned.current = true
          console.log(
            '[audio] no system audio detected for 20s — check output device / volume mixer'
          )
          showToast(
            'No system audio detected — is the meeting audio playing through your default output device?'
          )
        }
      } else {
        themZeroSince.current = null
      }
    },
    [showToast, tickMeters]
  )

  const resetMeters = useCallback(() => {
    if (meterRaf.current !== null) {
      window.cancelAnimationFrame(meterRaf.current)
      meterRaf.current = null
    }
    if (noAudioTimer.current !== null) {
      window.clearTimeout(noAudioTimer.current)
      noAudioTimer.current = null
    }
    meterPeak.current = { you: 0, them: 0 }
    meterPeakAt.current = { you: 0, them: 0 }
    meterDecayFrom.current = { you: 0, them: 0 }
    meterDecayStart.current = { you: 0, them: 0 }
    themZeroSince.current = null
    noAudioWarned.current = false
    for (const key of ['you', 'them'] as const) {
      const bar = meterBars.current[key]
      if (bar) bar.style.width = '0%'
    }
  }, [])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistoryList(await window.api.listSessions())
    } catch {
      setHistoryList([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    void (async () => {
      const { config: loaded, corruptBackupPath } = await window.api.getConfig()
      setConfig(loaded)
      setCorruptBackup(corruptBackupPath)
      setTitle(loaded.session.title || 'Interview session')
      setCompany(loaded.session.company)
      setJobDescription(loaded.session.jobDescription)
      setExtraContext(loaded.session.extraContext)
      setResume(loaded.profile.resume)
      setBackground(loaded.profile.background)
      setVocabulary(loaded.profile.vocabulary)
    })()
  }, [])

  useEffect(() => {
    const offConfig = window.api.onConfigChanged((next) => setConfig(next))
    const offDelta = window.api.onLlmDelta(({ id, text }) => {
      setAnswers((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a
          const nextText = a.text + text
          if (structuredAnswers.current.has(id)) {
            const card = parseStructuredAnswer(nextText)
            if (card) return { ...a, text: nextText, card }
          }
          return { ...a, text: nextText }
        })
      )
    })
    const offDone = window.api.onLlmDone(({ id }) => {
      structuredAnswers.current.delete(id)
      setAnswers((prev) => prev.map((a) => (a.id === id ? { ...a, streaming: false } : a)))
    })
    const offError = window.api.onLlmError(({ id, message }) => {
      structuredAnswers.current.delete(id)
      // A user-initiated stop clears streaming silently instead of raising a
      // scary abort banner. Main still sends llm:error for the aborted request.
      // The id is not removed: the invoke rejection can be delivered before or
      // after this event, and the set is bounded by manual stops per run.
      if (abortedAnswers.current.has(id)) {
        setAnswers((prev) => prev.map((a) => (a.id === id ? { ...a, streaming: false } : a)))
        return
      }
      setAnswers((prev) =>
        prev.map((a) => (a.id === id ? { ...a, streaming: false, error: message } : a))
      )
    })
    return () => {
      offConfig()
      offDelta()
      offDone()
      offError()
    }
  }, [])

  useEffect(() => {
    const off = window.api.onHotkey((name) => {
      console.log('[hotkey]', name)
      if (name === 'answer') askRef.current()
      if (name === 'screenshot') shotRef.current()
      if (name === 'chat') composerRef.current?.focus()
      if (name === 'settings') setView('settings')
      if (name === 'autostart' && !listeningRef.current) beginRef.current()
      // Main asks for this on close/quit: save, then call quitAfterSave().
      if (name === 'end-session') endRef.current(true)
    })
    return off
  }, [])

  useEffect(() => {
    const offReady = window.api.onUpdateReady((payload) => {
      setUpdateReady(payload)
      setUpdateBannerDismissed(false)
    })
    // The same subscription feeds the Home/live banner and Settings, so a user
    // who checked for updates and navigated away still sees progress/readiness.
    const offState = window.api.onUpdateState((next) => {
      setUpdateState(next)
      if (next.status === 'downloading') setUpdateReady(null)
      if (next.status === 'ready') {
        if (next.version) setUpdateReady({ version: next.version })
        setUpdateBannerDismissed(false)
      }
      if (next.status === 'error') setUpdateBannerDismissed(false)
    })
    return () => {
      offReady()
      offState()
    }
  }, [])

  // Dismiss whichever chip menu is open on an outside pointerdown or Escape.
  useEffect(() => {
    if (!modelMenuOpen && !questionMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!modelSwitchRef.current?.contains(target)) setModelMenuOpen(false)
      if (!questionSwitchRef.current?.contains(target)) setQuestionMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setModelMenuOpen(false)
      setQuestionMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modelMenuOpen, questionMenuOpen])

  // Opening a chip menu moves focus to its selected item for keyboard use.
  useEffect(() => {
    if (modelMenuOpen) focusMenuActiveItem(modelMenuRef.current)
  }, [modelMenuOpen])

  useEffect(() => {
    if (questionMenuOpen) focusMenuActiveItem(questionMenuRef.current)
  }, [questionMenuOpen])

  // Sticky-bottom: follow new content only while the reader is already at the
  // bottom; scrolling up pauses following until they return to the bottom.
  useEffect(() => {
    if (!configRef.current?.interaction.autoScroll || !atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [segments, answers])

  useEffect(() => {
    if (!pendingDelete && !pendingDeleteAll) return
    const timer = window.setTimeout(() => {
      setPendingDelete(null)
      setPendingDeleteAll(false)
    }, 3500)
    return () => window.clearTimeout(timer)
  }, [pendingDelete, pendingDeleteAll])

  useEffect(() => {
    if (view !== 'history') return
    void loadHistory()
  }, [view, loadHistory])

  // Company suggestions from previously saved sessions (unique, non-empty).
  const companyOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const session of historyList) {
      const value = session.company.trim()
      if (!value) continue
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(value)
    }
    return out.sort((a, b) => a.localeCompare(b))
  }, [historyList])

  // Autosave slot is a normal session file; offer recovery until History is seen.
  const autosaveAvailable = useMemo(
    () => historyList.some((session) => session.name === AUTOSAVE_FILE_NAME),
    [historyList]
  )

  useEffect(() => {
    if (view === 'history') setAutosaveBannerDismissed(true)
  }, [view])

  useEffect(() => {
    return () => {
      engines.current?.you?.stop()
      engines.current?.them?.stop()
      void window.api.setCaptureListening(false).catch(() => undefined)
      if (queueTimer.current) window.clearTimeout(queueTimer.current)
      if (meterRaf.current !== null) window.cancelAnimationFrame(meterRaf.current)
      if (noAudioTimer.current !== null) window.clearTimeout(noAudioTimer.current)
      coalesceControllerRef.current?.dispose()
    }
  }, [])

  const removePartial = useCallback((id: string) => {
    setSegments((prev) => {
      if (!prev.some((s) => s.id === id)) return prev
      const next = prev.filter((s) => s.id !== id)
      segmentsRef.current = next.filter((s) => !s.partial)
      return next
    })
  }, [])

  // Dispatch the oldest fresh queued follow-up; the caller ensures the stream is free.
  const dispatchQueuedAsk = useCallback(() => {
    if (streaming.current) return
    const now = Date.now()
    let next = pendingAsks.current.shift()
    while (next && now - next.queuedAt > QUEUE_TTL_MS) next = pendingAsks.current.shift()
    if (next) askRef.current(next.question, next.anchorUid, false)
  }, [])

  // Cap the follow-up queue at the two most recent entries; mark the uid at
  // enqueue time so an early partial and the final segment never both queue it.
  const queueAsk = useCallback(
    (question: string, anchorUid: number) => {
      const now = Date.now()
      pendingAsks.current = pendingAsks.current
        .filter((entry) => now - entry.queuedAt <= QUEUE_TTL_MS)
        .concat({ question, anchorUid, queuedAt: now })
      if (pendingAsks.current.length > 2) pendingAsks.current = pendingAsks.current.slice(-2)
      // A question can also be queued because the cooldown (not an active
      // stream) blocked it; schedule the drain for when the cooldown elapses so
      // it is not stranded until some later ask happens to free the lock.
      if (!streaming.current) {
        const cooldown = configRef.current?.interaction.answerCooldownMs ?? 0
        const wait = Math.max(0, cooldown - (Date.now() - lastAnswerAt.current))
        if (queueTimer.current) window.clearTimeout(queueTimer.current)
        queueTimer.current = window.setTimeout(() => {
          queueTimer.current = null
          dispatchQueuedAsk()
        }, wait)
      }
    },
    [dispatchQueuedAsk]
  )

  // Whisper initial_prompt: company + vocabulary first, then the recent
  // transcript carry-over in the remaining budget.
  // OpenAI whisper-1 prompt limit is 224 tokens; 700 chars is safe headroom.
  const whisperPrompt = useCallback((speaker: Speaker): string => {
    const cfg = configRef.current
    return buildWhisperPrompt({
      company: cfg?.session.company,
      vocabulary: cfg?.profile.vocabulary,
      carry: promptRef.current[speaker]
    })
  }, [])

  // Keep the last four Them WAVs as headerless 16 kHz mono 16-bit PCM so a
  // coalesced question can be re-transcribed from the full audio.
  const rememberThemPcm = useCallback((uid: number, wav: ArrayBuffer) => {
    if (wav.byteLength <= 44) return
    const now = Date.now()
    themPcm.current = [
      ...themPcm.current.filter((item) => now - item.at <= 60_000 && item.uid !== uid),
      { uid, pcm: new Uint8Array(wav.slice(44)), at: now }
    ].slice(-4)
  }, [])

  const transcribeCoalesced = useCallback(
    async (uids: number[]): Promise<string | null> => {
      const blocks: Uint8Array[] = []
      for (const uid of [...uids].sort((a, b) => a - b)) {
        const entry = themPcm.current.find((item) => item.uid === uid)
        if (!entry) return null
        blocks.push(entry.pcm)
      }
      if (blocks.length === 0) return null
      try {
        const { text } = await window.api.transcribe(
          encodePcmWav(blocks),
          whisperPrompt('Them')
        )
        return text.trim() || null
      } catch {
        return null
      }
    },
    [whisperPrompt]
  )

  // The coalescing state machine lives in lib/coalesce. Dependencies read refs
  // so the controller is created once and survives config/state re-renders.
  const transcribeRef = useRef<(uids: number[]) => Promise<string | null>>(async () => null)
  transcribeRef.current = transcribeCoalesced
  const queueAskRef = useRef<(question: string, anchorUid: number) => void>(() => undefined)
  queueAskRef.current = queueAsk
  const coalesce =
    coalesceControllerRef.current ??
    new CoalesceController({
      mergeMs: () => configRef.current?.interaction.mergeFollowUpsMs ?? 2000,
      onAsk: (question, anchorUid) => askRef.current(question, anchorUid),
      onQueue: (question, anchorUid) => queueAskRef.current(question, anchorUid),
      isStreaming: () => streaming.current,
      isAutoAnswer: () => configRef.current?.interaction.autoAnswer === true,
      isListening: () => listeningRef.current,
      cooldownMs: () => configRef.current?.interaction.answerCooldownMs ?? 5000,
      lastAnswerAt: () => lastAnswerAt.current,
      timers: {
        set: (fn, ms) => window.setTimeout(fn, ms),
        clear: (id) => window.clearTimeout(id)
      },
      transcribe: (uids) => transcribeRef.current(uids)
    })
  coalesceControllerRef.current = coalesce

  const cancelCoalesce = useCallback(() => coalesce.cancel(), [coalesce])

  // Manual Answer during a grace hold: prefer the merged audio text. The hold
  // is taken synchronously inside the controller, so a concurrent fire cannot
  // ask the same question twice.
  const takeCoalesceForManualAsk = useCallback(async (): Promise<string | null> => {
    const consumed = await coalesce.consumeManual()
    return consumed?.question ?? null
  }, [coalesce])

  const appendSegment = useCallback(
    (speaker: Speaker, text: string, partialId?: string, utteranceId = -1) => {
      const clean = text.trim()
      if (!clean) return
      const normalized = clean.toLowerCase().replace(/[.!?]+$/, '').trim()
      if (HALLUCINATIONS.has(normalized)) return
      if (speaker === 'You') {
        const lastThem = [...segmentsRef.current]
          .reverse()
          .find((s) => s.speaker === 'Them')
        if (lastThem && Date.now() - lastThem.ts < 12000 && similarity(clean, lastThem.text) > 0.6) {
          return
        }
      }
      console.log(`[segment:${speaker}:${utteranceId}] ${clean}`)
      const merged = `${promptRef.current[speaker]} ${clean}`.trim()
      promptRef.current[speaker] = merged.length > 400 ? merged.slice(-400) : merged
      const segment: Segment = {
        id: `final-${speaker}-${utteranceId}`,
        speaker,
        text: clean,
        ts: Date.now()
      }
      segmentsRef.current = [
        ...segmentsRef.current.filter((s) => s.id !== segment.id),
        segment
      ].slice(-MAX_SEGMENTS)
      setSegments((prev) => {
        let base = prev
        if (partialId) base = base.filter((s) => s.id !== partialId)
        if (speaker === 'Them') {
          base = base.filter(
            (s) =>
              !(
                s.speaker === 'You' &&
                Date.now() - s.ts < 8000 &&
                similarity(s.text, clean) > 0.6
              )
          )
        }
        const next = [...base.filter((s) => s.id !== segment.id), segment].slice(-MAX_SEGMENTS)
        segmentsRef.current = next.filter((s) => !s.partial)
        return next
      })
      const cfg = configRef.current
      // A pending hold treats any new Them final as a continuation, even when
      // the fragment alone does not look like a complete question.
      if (
        speaker === 'Them' &&
        coalesce.hasPending() &&
        cfg?.interaction.autoAnswer &&
        listeningRef.current
      ) {
        if (!askedUids.current.has(utteranceId)) askedUids.current.add(utteranceId)
        coalesce.addContinuation(utteranceId, clean)
        return
      }
      if (
        speaker === 'Them' &&
        cfg?.interaction.autoAnswer &&
        listeningRef.current &&
        isQuestion(clean) &&
        !askedUids.current.has(utteranceId)
      ) {
        // Whisper sometimes emits a trailing fragment that looks like a
        // question (observed: a stray "how do"); too few words is never a
        // real interview question, so record the segment but do not answer.
        const wordCount = clean.trim().split(/\s+/).filter(Boolean).length
        if (wordCount < 4) return
        askedUids.current.add(utteranceId)
        // Coalescing applies to final-triggered auto-answers only; early-trigger
        // asks keep their immediate behavior (explicit opt-in for speed). A zero
        // grace window takes the controller's immediate ask/queue branch.
        coalesce.hold(clean, utteranceId)
      }
    },
    [coalesce]
  )

  const handlePartial = useCallback(
    (speaker: Speaker, wav: ArrayBuffer, uid: number) => {
      if (!configRef.current?.interaction.streamingPartials) return
      if (partialBusy.current[speaker]) return
      partialBusy.current[speaker] = true
      const epoch = sessionEpochRef.current
      const seq = ++partialSeq.current[speaker]
      const info = partialInfo.current[speaker]
      info.uid = uid
      info.finalizing = false
      window.api
        .transcribe(wav, whisperPrompt(speaker))
        .then(({ text }) => {
          if (epoch !== sessionEpochRef.current) return
          const clean = text.trim()
          const cur = partialInfo.current[speaker]
          if (!clean || cur.uid !== uid || cur.finalizing || seq <= cur.applied) return
          cur.applied = seq
          const id = `partial-${speaker}-${uid}`
          console.log(`[partial:${speaker}] ${clean}`)
          setSegments((prev) => {
            const idx = prev.findIndex((s) => s.id === id)
            let next: Segment[]
            if (idx >= 0) {
              next = [...prev]
              next[idx] = { ...next[idx], text: clean, ts: Date.now() }
            } else {
              next = [
                ...prev,
                { id, speaker, text: clean, ts: Date.now(), partial: true }
              ].slice(-MAX_SEGMENTS)
            }
            segmentsRef.current = next.filter((s) => !s.partial)
            return next
          })
          const cfg = configRef.current
          if (speaker === 'Them' && coalesce.hasPending()) {
            // More speech is still arriving for the held question; the final
            // chunk will extend the hold, so do not early-ask here.
            coalesce.extend()
            return
          }
          if (
            speaker === 'Them' &&
            cfg?.interaction.autoAnswer &&
            cfg.interaction.earlyAnswer &&
            listeningRef.current &&
            !askedUids.current.has(uid) &&
            looksCompleteQuestion(clean)
          ) {
            askedUids.current.add(uid)
            if (
              !streaming.current &&
              Date.now() - lastAnswerAt.current >= cfg.interaction.answerCooldownMs
            ) {
              console.log('[early-answer]', clean)
              askRef.current(clean, uid)
            } else {
              queueAsk(clean, uid)
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          partialBusy.current[speaker] = false
        })
    },
    [coalesce, queueAsk, whisperPrompt]
  )

  const onWav = useCallback(
    (speaker: Speaker, wav: ArrayBuffer, uid: number) => {
      const partialId = `partial-${speaker}-${uid}`
      const info = partialInfo.current[speaker]
      info.uid = uid
      info.finalizing = true
      if (speaker === 'Them') rememberThemPcm(uid, wav)
      const epoch = sessionEpochRef.current
      chains.current[speaker] = chains.current[speaker]
        .then(async () => {
          const { text } = await window.api.transcribe(wav, whisperPrompt(speaker))
          // End/Stop may have drained and moved on while whisper was working.
          if (epoch !== sessionEpochRef.current) return
          asrFailures.current[speaker] = 0
          asrWarningDismissed.current = false
          setAsrWarning(false)
          if (!text.trim()) {
            removePartial(partialId)
            return
          }
          appendSegment(speaker, text, partialId, uid)
        })
        .catch((err) => {
          asrFailures.current[speaker] += 1
          if (asrFailures.current[speaker] >= 2 && !asrWarningDismissed.current) {
            setAsrWarning(true)
          }
          setError(errorMessage(err))
        })
        .finally(() => {
          if (partialInfo.current[speaker].uid === uid) {
            partialInfo.current[speaker].finalizing = false
          }
        })
    },
    [appendSegment, rememberThemPcm, removePartial, whisperPrompt]
  )

  const ask = useCallback(
    async (opts?: {
      question?: string
      transcript?: string
      answerId?: string
      useAttachments?: boolean
      anchorUid?: number
      answerAnchor?: string
      /** Regenerate a structured card without resending the original image. */
      keepStructured?: boolean
    }) => {
      const cfg = configRef.current
      if (!cfg || streaming.current) return
      // Claim the lock before resolving a pending coalesce so a second rapid
      // Answer press cannot start a parallel ask during the re-transcription.
      streaming.current = true
      const keepStructured = opts?.keepStructured === true
      let question = opts?.question?.trim()
      if (!question && !opts?.answerAnchor && !opts?.answerId) {
        // Manual Answer/hotkey during a grace hold: prefer the merged question.
        const merged = await takeCoalesceForManualAsk()
        if (merged) {
          const lastThem = [...segmentsRef.current]
            .reverse()
            .find((s) => s.speaker === 'Them')
            ?.text.trim()
          if (merged.trim() !== lastThem) question = merged
        }
      }
      const transcript =
        opts?.transcript ??
        segmentsRef.current
          .slice(-40)
          .map((s) => `${s.speaker}: ${s.text}`)
          .join('\n')
      if (!question && !transcript && attachments.length === 0) {
        streaming.current = false
        showToast('No transcript yet — start listening or type a question.')
        return
      }
      const id = opts?.answerId ?? uid()
      const anchorId =
        opts?.answerAnchor ??
        (opts?.anchorUid != null
          ? `final-Them-${opts.anchorUid}`
          : [...segmentsRef.current].reverse().find((s) => s.speaker === 'Them')?.id ?? undefined)
      // Auto resolves from the explicit question, else the latest remote turn.
      const latestThem = [...segmentsRef.current].reverse().find((s) => s.speaker === 'Them')
      const questionType: ResolvedQuestionType = keepStructured
        ? 'coding'
        : resolveQuestionType(
            cfg.answer.questionType,
            question ?? latestThem?.text ?? transcript
          )
      // Outgoing images for this ask: none for regenerate, and none over IPC
      // when vision is off (main would drop them anyway). The model only sees
      // images when vision is enabled.
      const images =
        opts?.useAttachments === false || !cfg.llm.vision ? [] : attachments
      const hasImageAttachment = images.length > 0
      const structured =
        (hasImageAttachment && questionType === 'coding') || keepStructured
      const assistantTurns: ChatMessage[] = answersRef.current
        .filter((a) => a.text.trim() && !a.error)
        .slice(-2)
        .map((a) => ({ role: 'assistant', content: a.text }))
      console.log(`[answer-anchor] ${anchorId ?? 'none'} | ${questionType} | ${question ?? ''}`)
      if (structured) structuredAnswers.current.add(id)
      setAnswers((prev) => {
        const next: Answer[] = [
          ...prev.filter((a) => a.id !== id).slice(-MAX_ANSWERS),
          { id, text: '', streaming: true, question, transcript, anchorId, images }
        ]
        // Only the newest MAX_SESSION_IMAGES-bearing answers can be persisted.
        // Older answers would otherwise pin their full data-URL arrays (up to 9
        // JPEGs each) for the whole 2000-row window — hundreds of MB of dead
        // strings. Blank whole arrays (not partial) once the count is exceeded.
        let withImages = 0
        for (let i = next.length - 1; i >= 0; i--) {
          if (!next[i].images || next[i].images!.length === 0) continue
          withImages += 1
          if (withImages > MAX_SESSION_IMAGES) next[i] = { ...next[i], images: [] }
        }
        return next
      })
      const userContent = [
        `Session: ${titleRef.current}`,
        '',
        'Transcript so far:',
        transcript || '(no transcript yet)',
        '',
        question ? `User question: ${question}` : 'Answer the latest question from the transcript.'
      ].join('\n')
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(cfg, hasImageAttachment, questionType, keepStructured) },
        ...assistantTurns,
        { role: 'user', content: userContent }
      ]
      // Attachments are consumed by this send and cleared from the composer.
      // Regenerating an old answer therefore cannot resend its original images
      // (acceptable tradeoff; avoids silently attaching stale screenshots).
      setAttachments([])
      try {
        const result = await window.api.chat({
          id,
          messages,
          images,
          vision: Boolean(cfg.llm.vision),
          questionType
        })
        if (structured) {
          const card = parseStructuredAnswer(result.text)
          setAnswers((prev) =>
            prev.map((a) => (a.id === id ? { ...a, card: card ?? undefined } : a))
          )
        }
      } catch (err) {
        // A user stop rejects the invoke too; onLlmError handles the silent case.
        if (!abortedAnswers.current.has(id)) setError(errorMessage(err))
      } finally {
        structuredAnswers.current.delete(id)
        streaming.current = false
        lastAnswerAt.current = Date.now()
        setAnswers((prev) => prev.map((a) => (a.id === id ? { ...a, streaming: false } : a)))
        // Queued follow-ups bypass the cooldown: one ask per uid already gates
        // repeats, and the question is already stale by the time the lock frees.
        dispatchQueuedAsk()
      }
    },
    [attachments, showToast, dispatchQueuedAsk, takeCoalesceForManualAsk]
  )

  const regenerate = useCallback(
    (answer: Answer) => {
      if (streaming.current) return
      setAnswers((prev) => prev.filter((a) => a.id !== answer.id))
      void ask({
        question: answer.question,
        transcript: answer.transcript,
        useAttachments: false,
        answerAnchor: answer.anchorId,
        keepStructured: Boolean(answer.card)
      })
    },
    [ask]
  )

  // Indirection keeps these callbacks referentially stable for memoized rows;
  // ask/regenerate identities change when attachments or config change.
  regenerateRef.current = regenerate
  const onRegenerate = useCallback((answer: Answer) => regenerateRef.current(answer), [])
  const onStopAnswer = useCallback((id: string) => {
    abortedAnswers.current.add(id)
    void window.api.abortChat(id).catch(() => undefined)
  }, [])

  askRef.current = (question?: string, anchorUid?: number, useAttachments?: boolean) => {
    void ask({ question, anchorUid, useAttachments })
  }

  const attachImage = useCallback(
    (dataUrl: string, hint?: string) => {
      setAttachments((prev) => [...prev.slice(0, 9), dataUrl])
      const guidance = configRef.current?.llm.vision
        ? 'Screenshot attached — press Answer to include it'
        : 'Screenshot attached — enable "Active model supports images" in Settings → Models to send it'
      showToast(hint ? `${guidance} (${hint})` : guidance)
    },
    [showToast]
  )

  const captureShot = useCallback(async () => {
    try {
      const shot = await window.api.captureScreen()
      attachImage(shot.dataUrl, shot.hint)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [attachImage])

  shotRef.current = () => {
    void captureShot()
  }

  // Region screenshots arrive already cropped from main (shot:image).
  useEffect(() => {
    const off = window.api.onCapturedImage(({ dataUrl, hint, error }) => {
      if (error) {
        setError(error)
        return
      }
      if (dataUrl) attachImage(dataUrl, hint)
    })
    return off
  }, [attachImage])

  const openRegionPicker = useCallback(async () => {
    try {
      const shot = await window.api.captureRegionSource()
      regionDrag.current = null
      setRegionSel(null)
      setRegionShot(shot)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const closeRegionPicker = useCallback(() => {
    regionDrag.current = null
    setRegionSel(null)
    setRegionShot(null)
  }, [])

  useEffect(() => {
    if (!regionShot) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRegionPicker()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [regionShot, closeRegionPicker])

  const startRegionDrag = useCallback((e: ReactPointerEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const startX = Math.min(Math.max(e.clientX - rect.left, 0), rect.width)
    const startY = Math.min(Math.max(e.clientY - rect.top, 0), rect.height)
    regionDrag.current = { startX, startY, rect }
    e.currentTarget.setPointerCapture(e.pointerId)
    setRegionSel({ x: startX, y: startY, w: 0, h: 0 })
  }, [])

  const moveRegionDrag = useCallback((e: ReactPointerEvent<HTMLImageElement>) => {
    const drag = regionDrag.current
    if (!drag) return
    const cx = Math.min(Math.max(e.clientX - drag.rect.left, 0), drag.rect.width)
    const cy = Math.min(Math.max(e.clientY - drag.rect.top, 0), drag.rect.height)
    setRegionSel({
      x: Math.min(drag.startX, cx),
      y: Math.min(drag.startY, cy),
      w: Math.abs(cx - drag.startX),
      h: Math.abs(cy - drag.startY)
    })
  }, [])

  const endRegionDrag = useCallback((e: ReactPointerEvent<HTMLImageElement>) => {
    regionDrag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }, [])

  const saveRegion = useCallback(async () => {
    const image = regionImgRef.current
    if (!regionShot || !regionSel || !image || regionSel.w < 2 || regionSel.h < 2) {
      showToast('Drag a rectangle on the preview first')
      return
    }
    setRegionSaving(true)
    try {
      // Preview CSS px -> captured-image px. Aspect ratio is preserved, so the
      // naturalWidth / renderedWidth scale applies identically on both axes.
      const scale = image.naturalWidth / image.getBoundingClientRect().width
      const region = {
        x: Math.round(regionSel.x * scale),
        y: Math.round(regionSel.y * scale),
        w: Math.round(regionSel.w * scale),
        h: Math.round(regionSel.h * scale),
        displayId: regionShot.displayId,
        frameW: image.naturalWidth,
        frameH: image.naturalHeight
      }
      const next = await window.api.setConfig({ capture: { region } })
      setConfig(next)
      closeRegionPicker()
      showToast(`Capture region saved (${region.w}×${region.h}px)`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRegionSaving(false)
    }
  }, [closeRegionPicker, regionSel, regionShot, showToast])

  const clearRegion = useCallback(async () => {
    try {
      const next = await window.api.setConfig({ capture: { region: null } })
      setConfig(next)
      closeRegionPicker()
      showToast('Capture region cleared')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [closeRegionPicker, showToast])

  const clearAll = useCallback(() => {
    // Session boundary: any transcription still in flight belongs to the old
    // session and must not contaminate the next one.
    sessionEpochRef.current += 1
    setSegments([])
    segmentsRef.current = []
    setAnswers([])
    setAttachments([])
    transcriptSavedRef.current = false
    cancelCoalesce()
    themPcm.current = []
    resetMeters()
    partialInfo.current = {
      You: { uid: -1, applied: 0, finalizing: false },
      Them: { uid: -1, applied: 0, finalizing: false }
    }
    partialSeq.current = { You: 0, Them: 0 }
    partialBusy.current = { You: false, Them: false }
    askedUids.current = new Set()
    pendingAsks.current = []
    promptRef.current = { You: '', Them: '' }
  }, [cancelCoalesce, resetMeters])

  const startCapture = useCallback(async () => {
    setError(null)
    resetMeters()
    try {
      const wantMic = configRef.current?.interaction.transcribeMic ?? false
      const silenceMs = configRef.current?.interaction.silenceSplitMs ?? 900
      const micPromise: Promise<MediaStream | null> = wantMic
        ? startMicStream()
        : Promise.resolve(null)
      const results = await Promise.allSettled([micPromise, startSystemStream()])
      const mic = results[0].status === 'fulfilled' ? results[0].value : null
      const system = results[1].status === 'fulfilled' ? results[1].value : null
      const systemError =
        results[1].status === 'rejected' ? errorMessage(results[1].reason) : null
      console.log('[capture] sources', {
        mic: Boolean(mic),
        system: Boolean(system),
        systemTracks: system?.getAudioTracks().length ?? 0,
        micError: results[0].status === 'rejected' ? String(results[0].reason) : null,
        systemError
      })
      if (system) {
        const track = system.getAudioTracks()[0]
        const settings = track?.getSettings()
        console.log('[capture] system audio', {
          present: Boolean(track),
          tracks: system.getAudioTracks().length,
          label: track?.label || '(none)',
          sampleRate: settings?.sampleRate ?? null,
          channelCount: settings?.channelCount ?? null
        })
        track?.addEventListener('ended', () => {
          if (noAudioTimer.current !== null) {
            window.clearTimeout(noAudioTimer.current)
            noAudioTimer.current = null
          }
          const stats = engines.current?.them?.getStats()
          console.log('[capture] system track ended', stats ?? null)
          showToast('System audio capture ended')
        })
        track?.addEventListener('mute', () => console.log('[capture] system track muted'))
        track?.addEventListener('unmute', () => console.log('[capture] system track unmuted'))
      }
      if (!mic && !system) {
        throw new Error(
          systemError
            ? `No audio sources available — ${systemError}`
            : 'No audio sources available. Check your microphone and Windows output device.'
        )
      }
      const you = mic
        ? new AudioEngine('You', onWav, handleLevel, handlePartial, silenceMs, showToast)
        : undefined
      const them = system
        ? new AudioEngine('Them', onWav, handleLevel, handlePartial, silenceMs, showToast)
        : undefined
      try {
        if (you && mic) await you.startWithStream(mic)
        if (them && system) await them.startWithStream(system)
      } catch (err) {
        you?.stop()
        them?.stop()
        throw err
      }
      engines.current?.you?.stop()
      engines.current?.them?.stop()
      engines.current = { you, them }
      if (them) {
        // Complements the RMS watchdog: fires only when the engine produced no
        // level callbacks at all in the first 20 s (silent/broken loopback).
        noAudioTimer.current = window.setTimeout(() => {
          noAudioTimer.current = null
          if (noAudioWarned.current || meterPeakAt.current.them > 0) return
          noAudioWarned.current = true
          console.log(
            '[audio] no system audio callbacks for 20s — check output device / volume mixer'
          )
          showToast(
            'No system audio detected — is the meeting audio playing through your default output device?'
          )
        }, 20_000)
      }
      cancelCoalesce()
      themPcm.current = []
      askedUids.current = new Set()
      pendingAsks.current = []
      chains.current = { You: Promise.resolve(), Them: Promise.resolve() }
      transcriptSavedRef.current = false
      setListening(true)
      void window.api.setCaptureListening(true).catch(() => undefined)
      setView('live')
      if (wantMic && !mic) setError('Microphone unavailable — capturing system audio only.')
      if (!system) {
        setError(
          systemError
            ? `System audio unavailable — ${systemError}`
            : 'System audio unavailable — check your Windows output device.'
        )
      }
    } catch (err) {
      setError(errorMessage(err))
      setListening(false)
      void window.api.setCaptureListening(false).catch(() => undefined)
    }
  }, [onWav, cancelCoalesce, handleLevel, resetMeters, showToast])

  const beginSession = useCallback(async () => {
    // A fresh session never inherits the previous transcript; resuming from the
    // live view (Stop → Start) keeps the capture already in progress.
    if (view !== 'live') clearAll()
    const next = await window.api.setConfig({
      session: { title, company, jobDescription, extraContext },
      profile: { resume, background, vocabulary }
    })
    setConfig(next)
    // `next` is the authoritative merged config for this start; configRef only
    // updates on the next render, which is too late for startCapture's reads.
    configRef.current = next
    await startCapture()
  }, [
    view,
    clearAll,
    title,
    company,
    jobDescription,
    extraContext,
    resume,
    background,
    vocabulary,
    startCapture
  ])

  beginRef.current = () => {
    if (!listeningRef.current) void beginSession()
  }

  const applyResumePdf = (result: {
    text: string
    pagesProcessed: number
    truncated: boolean
  }): void => {
    setResume(result.text.slice(0, 30000))
    const pages = result.pagesProcessed
    const detail = result.truncated
      ? 'stopped at the character cap'
      : 'up to 30,000 characters'
    showToast(`Imported ${pages} page${pages === 1 ? '' : 's'} (${detail})`)
  }

  const importResumePdf = async (): Promise<void> => {
    try {
      const result = await window.api.extractPdf()
      if (!result) return
      if (!result.text.trim()) {
        showToast('No text found in that PDF')
        return
      }
      // Inline confirm: native dialogs are visible to everyone on a screen share.
      if (resume.trim()) {
        setPendingResumePdf(result)
        return
      }
      applyResumePdf(result)
    } catch (err) {
      showToast(`PDF import failed: ${errorMessage(err)}`)
    }
  }

  const importJobLink = async (opts?: { url?: string; force?: boolean }): Promise<void> => {
    const url = (opts?.url ?? jobUrl).trim()
    if (!url || jobFetching) return
    if (!opts?.force && jobDescription.trim()) {
      setPendingJobReplaceUrl(url)
      return
    }
    setPendingJobReplaceUrl(null)
    setJobFetching(true)
    try {
      const result = await window.api.fetchJob(url)
      setJobDescription(result.text.slice(0, 10000))
      if (!company.trim() && result.title) setCompany(result.title)
      setJobUrl('')
      showToast('Job description imported')
    } catch (err) {
      const reason = errorMessage(err)
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
      showToast(
        reason
          ? `Couldn't fetch (${reason}) — paste it manually`
          : "Couldn't fetch — paste it manually"
      )
    } finally {
      setJobFetching(false)
    }
  }

  // Test hook: main process can trigger capture when PC_AUTOSTART=1.
  useEffect(() => {
    window.__pcAutostart = () => {
      void startCapture()
    }
    return () => {
      delete window.__pcAutostart
    }
  }, [startCapture])

  const stopCapture = useCallback(() => {
    const themStats = engines.current?.them?.getStats()
    if (themStats) console.log('[capture] stop', themStats)
    engines.current?.you?.stop()
    engines.current?.them?.stop()
    engines.current = null
    cancelCoalesce()
    themPcm.current = []
    resetMeters()
    askedUids.current = new Set()
    pendingAsks.current = []
    if (queueTimer.current) {
      window.clearTimeout(queueTimer.current)
      queueTimer.current = null
    }
    setListening(false)
    void window.api.setCaptureListening(false).catch(() => undefined)
  }, [cancelCoalesce, resetMeters])

  // Snapshot shared by the real save and the 120s autosave. Orphan anchors get
  // a placeholder so history keeps the Q→A pairing.
  const buildSavePayload = useCallback((endedAt: string) => {
    const sessionSegments = [...segmentsRef.current]
    const currentAnswers = answersRef.current
    // Build the id index once instead of rescanning the growing segment array
    // for every answer; placeholders are added to the set so duplicate orphan
    // anchors still produce one placeholder.
    const segmentIds = new Set(sessionSegments.map((s) => s.id))
    for (const answer of currentAnswers) {
      const anchorId = answer.anchorId
      if (anchorId && !segmentIds.has(anchorId)) {
        segmentIds.add(anchorId)
        sessionSegments.push({
          id: anchorId,
          speaker: 'Them',
          text: '(question not captured)',
          ts: Date.now()
        })
      }
    }
    // Keep the 10 most recent unique screenshots, newest answers first.
    const keptImages = new Set<string>()
    const imagesByAnswer: Array<string[] | undefined> = []
    for (let i = currentAnswers.length - 1; i >= 0; i--) {
      const keep: string[] = []
      const imageList = currentAnswers[i].images ?? []
      for (let j = imageList.length - 1; j >= 0; j--) {
        const url = imageList[j]
        if (keptImages.has(url) || keptImages.size >= MAX_SESSION_IMAGES) continue
        keptImages.add(url)
        keep.unshift(url)
      }
      imagesByAnswer[i] = keep.length > 0 ? keep : undefined
    }
    return {
      title: titleRef.current,
      company: companyRef.current.trim(),
      endedAt,
      segments: sessionSegments,
      answers: currentAnswers.map((a, index) => ({
        text: a.text,
        error: a.error,
        question: a.question,
        anchorId: a.anchorId,
        card: a.card,
        images: imagesByAnswer[index]
      }))
    }
  }, [])

  // In-flight finals must land before the snapshot; one stalled ASR call cannot
  // hold End/quit hostage for longer than the cap.
  const drainChains = useCallback(async (): Promise<void> => {
    const pending = [chains.current.You, chains.current.Them].filter(Boolean)
    if (pending.length === 0) return
    let timer: number | undefined
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, CHAIN_DRAIN_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const endSession = useCallback(
    async (thenQuit = false) => {
      if (thenQuit) endQuitPendingRef.current = true
      // Quit path: main is waiting on us; acknowledge before the drain so its
      // 2s "unreachable renderer" fallback does not kill a real save. A second
      // concurrent call still acks, then returns without saving again.
      if (thenQuit) void window.api.ackEndSession().catch(() => undefined)
      if (endingSessionRef.current) return
      endingSessionRef.current = true
      try {
        stopCapture()
        await drainChains()
        let saveFailed = false
        if (
          !transcriptSavedRef.current &&
          (segmentsRef.current.length > 0 || answersRef.current.length > 0)
        ) {
          try {
            const saved = await window.api.saveSession(buildSavePayload(new Date().toISOString()))
            if (saved) {
              transcriptSavedRef.current = true
              showToast(`Session saved: ${saved}`)
              // Start the next session empty; otherwise Settings → Back could
              // re-save this transcript into a new session file.
              clearAll()
            } else {
              saveFailed = true
              setError('Session save failed')
              showToast('Session save failed')
            }
            void loadHistory()
          } catch (err) {
            // session:save now rejects on a write failure; keep it visible.
            saveFailed = true
            const message = errorMessage(err).replace(
              /^Error invoking remote method '[^']+': (?:Error: )?/,
              ''
            )
            setError(message)
            showToast(message)
          }
        }
        // A failed save must not strand the transcript on Home (Start wipes it):
        // stay on the live view so End can retry. Quit still proceeds below via
        // main's autosave fallback, so the user is never trapped. No clearAll
        // ran, so the epoch is unchanged: a delayed drain result may append to
        // this stopped session, but listening=false blocks any auto-ask.
        if (!saveFailed) setView('home')
        if (thenQuit || endQuitPendingRef.current) {
          try {
            await window.api.quitAfterSave()
          } catch {
            /* main is already quitting */
          }
        }
      } finally {
        endingSessionRef.current = false
        endQuitPendingRef.current = false
      }
    },
    [buildSavePayload, clearAll, drainChains, showToast, stopCapture, loadHistory]
  )

  endRef.current = (thenQuit) => {
    void endSession(thenQuit)
  }

  // Crash/quit recovery: overwrite one fixed session file every 2 minutes while
  // listening (no toast). A successful real save removes it in main.
  useEffect(() => {
    if (!listening) return
    const timer = window.setInterval(() => {
      if (segmentsRef.current.length === 0 && answersRef.current.length === 0) return
      void window.api
        .saveSession(buildSavePayload(new Date().toISOString()), { autosave: true })
        .catch(() => undefined)
    }, AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [listening, buildSavePayload])

  const deleteSession = useCallback(
    async (name: string) => {
      if (pendingDelete !== name) {
        setPendingDelete(name)
        return
      }
      try {
        await window.api.deleteSession(name)
        setHistoryList((prev) => prev.filter((session) => session.name !== name))
        showToast('Session deleted')
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setPendingDelete(null)
      }
    },
    [pendingDelete, showToast]
  )

  const exportSession = useCallback(
    async (name: string) => {
      try {
        const path = await window.api.exportSession(name)
        showToast(`Exported: ${path}`)
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [showToast]
  )

  // Detail loading stays in App so HistoryView stays presentational.
  const openHistorySession = useCallback((name: string) => {
    void (async () => {
      try {
        const data = (await window.api.getSession(name)) as SessionData
        setHistoryDetail(data)
      } catch (err) {
        setError(errorMessage(err))
      }
    })()
  }, [])

  const deleteAllSessions = useCallback(async () => {
    if (!pendingDeleteAll) {
      setPendingDeleteAll(true)
      return
    }
    try {
      const count = await window.api.deleteAllSessions()
      setHistoryList([])
      showToast(`${count} session${count === 1 ? '' : 's'} deleted`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPendingDeleteAll(false)
    }
  }, [pendingDeleteAll, showToast])

  const sendMessage = useCallback(() => {
    const question = input.trim()
    if (!question) return
    setInput('')
    cancelCoalesce()
    void ask({ question })
  }, [ask, input, cancelCoalesce])

  // Chat-style thread: each answer renders directly beneath its question segment.
  const thread = useMemo(() => {
    type ThreadItem = { kind: 'seg'; segment: Segment } | { kind: 'ans'; answer: Answer }
    const byAnchor = new Map<string, Answer[]>()
    const loose: Answer[] = []
    for (const answer of answers) {
      if (answer.anchorId) {
        const list = byAnchor.get(answer.anchorId) ?? []
        list.push(answer)
        byAnchor.set(answer.anchorId, list)
      } else {
        loose.push(answer)
      }
    }
    const out: ThreadItem[] = []
    for (const segment of segments) {
      out.push({ kind: 'seg', segment })
      const anchored = byAnchor.get(segment.id)
      if (anchored) {
        for (const answer of anchored) out.push({ kind: 'ans', answer })
        byAnchor.delete(segment.id)
      }
    }
    for (const list of byAnchor.values()) {
      for (const answer of list) out.push({ kind: 'ans', answer })
    }
    for (const answer of loose) out.push({ kind: 'ans', answer })
    return out
  }, [segments, answers])

  if (!config) {
    return (
      <div className="app">
        <div className="panel">
          <div className="loading">Loading…</div>
        </div>
      </div>
    )
  }

  const activeProfile =
    config.llm.profiles.find((profile) => profile.id === config.llm.activeProfileId) ??
    config.llm.profiles[0]

  // Saved immediately; main resolves the active profile when the next ask
  // starts, so switching never touches an in-flight stream.
  const switchProfile = async (id: string): Promise<void> => {
    setModelMenuOpen(false)
    if (id === config.llm.activeProfileId) return
    try {
      const next = await window.api.setConfig({ llm: { ...config.llm, activeProfileId: id } })
      setConfig(next)
      showToast(`Model: ${next.llm.profiles.find((profile) => profile.id === id)?.label ?? id}`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // Auto resolves live from the composer text, else the latest remote turn.
  const resolvedQuestionType = resolveQuestionType(
    config.answer.questionType,
    input.trim() || [...segments].reverse().find((s) => s.speaker === 'Them')?.text || ''
  )

  // Persisted immediately; the next ask reads it from configRef.
  const updateQuestionType = (value: QuestionType): void => {
    if (value === config.answer.questionType) return
    setConfig((prev) =>
      prev ? { ...prev, answer: { ...prev.answer, questionType: value } } : prev
    )
    void window.api
      .setConfig({ answer: { ...config.answer, questionType: value } })
      .then(setConfig)
      .catch((err) => {
        setError(errorMessage(err))
        void window.api
          .getConfig()
          .then(({ config: latest }) => setConfig(latest))
          .catch(() => undefined)
      })
  }

  return (
    <div className="app">
      <div
        className="panel"
        style={{ backgroundColor: `rgba(13, 13, 18, ${config.panelOpacity})` }}
      >
        <div className="topbar">
          <div className="brand">
            <span className={`dot ${listening ? 'on' : ''}`} />
            <div>
              <div className="brand-title">Parakeet Clone</div>
              <div className="brand-sub">
                {view === 'live'
                  ? listening
                    ? 'Listening'
                    : 'Idle'
                  : 'Local-first interview copilot'}
              </div>
            </div>
          </div>
          <div className="topbar-actions">
            {view === 'live' && (
              <>
                <button className="icon-btn" title="Settings" onClick={() => setView('settings')}>
                  ⚙
                </button>
                <button className="icon-btn" title="Hide (Ctrl+Shift+H)" onClick={() => void window.api.hideWindow()}>
                  ▁
                </button>
              </>
            )}
            {view !== 'live' && (
              <button className="icon-btn" title="Hide (Ctrl+Shift+H)" onClick={() => void window.api.hideWindow()}>
                ▁
              </button>
            )}
          </div>
        </div>

        {config.clickThrough && (
          <div className="banner">
            Click-through is ON — press <strong>Ctrl+Shift+F9</strong> to interact again.
          </div>
        )}
        {error && (
          <div className="banner error" onClick={() => setError(null)}>
            {error} <span className="dismiss">×</span>
          </div>
        )}
        {toast && <div className="banner info">{toast}</div>}
        {corruptBackup && !corruptBannerDismissed && (
          <div className="banner error" onClick={() => setCorruptBannerDismissed(true)}>
            config.json was corrupt; defaults loaded. Backup:{' '}
            <span className="mono">{corruptBackup}</span>
            <span className="dismiss">×</span>
          </div>
        )}
        {asrWarning && (
          <div
            className="banner error"
            onClick={() => {
              setAsrWarning(false)
              asrWarningDismissed.current = true
            }}
          >
            Speech endpoint not responding — check whisper-server
            (scripts\start-whisper.ps1) <span className="dismiss">×</span>
          </div>
        )}
        {view === 'home' &&
          !updateReady &&
          !updateBannerDismissed &&
          updateState.status === 'downloading' && (
            <div className="banner info">
              Downloading update{updateState.version ? ` ${updateState.version}` : ''}…{' '}
              {updateState.percent ?? 0}%
            </div>
          )}
        {(view === 'home' || view === 'live') &&
          !updateBannerDismissed &&
          updateState.status === 'error' && (
            <div className="banner error update-banner">
              <span>Update failed: {updateState.errorMessage ?? 'unknown error'}</span>
              <button
                className="icon-btn"
                title="Dismiss"
                onClick={() => setUpdateBannerDismissed(true)}
              >
                ×
              </button>
            </div>
          )}
        {(view === 'home' || view === 'live') && updateReady && !updateBannerDismissed && (
          <div className="banner info update-banner">
            <span>
              Parakeet Clone {updateReady.version} is ready — Restart &amp; install
              {listening && (
                <span className="hint small">
                  {' '}
                  End your session first — installing restarts the app
                </span>
              )}
            </span>
            <button
              className="btn tiny"
              disabled={listening}
              title={
                listening
                  ? 'End your session first — installing restarts the app'
                  : 'Restart and install the update'
              }
              onClick={installUpdate}
            >
              Install now
            </button>
            <button
              className="icon-btn"
              title="Dismiss"
              onClick={() => setUpdateBannerDismissed(true)}
            >
              ×
            </button>
          </div>
        )}

        {regionShot && (
          // Rendered inside the capture-protected overlay on purpose: the preview
          // and the drag selection must never be visible in screen shares.
          <div className="region-modal" role="dialog" aria-label="Set capture region">
            <div className="region-modal-head">
              <strong>Set capture region</strong>
              <button className="icon-btn" title="Cancel (Esc)" onClick={closeRegionPicker}>
                ×
              </button>
            </div>
            <p className="hint small">
              Drag a rectangle around the area to capture. Saving binds it to this display; the
              region is used by Ctrl+Alt+R.
            </p>
            <div className="region-preview">
              <img
                ref={regionImgRef}
                src={regionShot.dataUrl}
                alt="Screen capture preview"
                draggable={false}
                onPointerDown={startRegionDrag}
                onPointerMove={moveRegionDrag}
                onPointerUp={endRegionDrag}
                onPointerCancel={endRegionDrag}
              />
              {regionSel && regionSel.w > 0 && regionSel.h > 0 && (
                <div
                  className="region-selection"
                  style={{
                    left: `${regionSel.x}px`,
                    top: `${regionSel.y}px`,
                    width: `${regionSel.w}px`,
                    height: `${regionSel.h}px`
                  }}
                />
              )}
            </div>
            <div className="row gap">
              <button
                className="btn primary"
                disabled={regionSaving}
                onClick={() => void saveRegion()}
              >
                Save region
              </button>
              <button className="btn" disabled={regionSaving} onClick={() => void clearRegion()}>
                Clear region
              </button>
              <button className="btn ghost" onClick={closeRegionPicker}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {view === 'home' && (
          <div className="home">
            {autosaveAvailable && !autosaveBannerDismissed && (
              <div className="banner info">
                Unsaved transcript recovered —{' '}
                <button className="btn tiny" onClick={() => setView('history')}>
                  view in History
                </button>
                <span className="dismiss" onClick={() => setAutosaveBannerDismissed(true)}>
                  ×
                </span>
              </div>
            )}
            <label className="field">
              <span>Session title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Backend interview — Acme"
              />
            </label>
            <button className="btn primary big" onClick={() => void beginSession()}>
              Start listening
            </button>
            <p className="hint">
              Captures Windows system audio (loopback). Nothing leaves your machine except requests
              to the endpoints you configure.
            </p>

            <h3>Context (optional — improves answers)</h3>
            <label className="field">
              <span>Company</span>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Acme Corp"
                list="company-history"
              />
              <datalist id="company-history">
                {companyOptions.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Job description</span>
              <textarea
                rows={3}
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value.slice(0, 10000))}
                placeholder="Paste the role description"
              />
            </label>
            <div className="row gap">
              <input
                className="job-link"
                value={jobUrl}
                onChange={(e) => setJobUrl(e.target.value)}
                placeholder="https://company.com/jobs/123"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void importJobLink()
                  }
                }}
              />
              <button
                className="btn tiny"
                disabled={jobFetching || !jobUrl.trim()}
                onClick={() => void importJobLink()}
              >
                {jobFetching ? 'Fetching…' : 'Paste job link'}
              </button>
            </div>
            {pendingJobReplaceUrl && (
              // Inline (not native) so the prompt never appears in a screen share.
              <div className="row gap">
                <span className="hint small">Replace the current job description?</span>
                <button
                  className="btn tiny"
                  onClick={() =>
                    void importJobLink({
                      url: pendingJobReplaceUrl ?? undefined,
                      force: true
                    })
                  }
                >
                  Replace
                </button>
                <button className="btn tiny ghost" onClick={() => setPendingJobReplaceUrl(null)}>
                  Cancel
                </button>
              </div>
            )}
            <label className="field">
              <span>Extra instructions</span>
              <textarea
                rows={2}
                value={extraContext}
                onChange={(e) => setExtraContext(e.target.value)}
                placeholder="e.g. Keep answers under 100 words; emphasize leadership"
              />
            </label>
            <label className="field">
              <span>Your background</span>
              <textarea
                rows={2}
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                placeholder="e.g. 6 years backend engineering, Go + Postgres, led a team of 4"
              />
            </label>
            <label className="field">
              <span>Names &amp; jargon (for transcription)</span>
              <textarea
                rows={2}
                value={vocabulary}
                onChange={(e) => setVocabulary(e.target.value)}
                placeholder="e.g. Acme, KubeRAG, gRPC, SRE"
              />
            </label>
            <p className="hint small">
              Comma or newline separated. Prepended to the speech prompt with the company name
              (700-char budget).
            </p>
            <label className="field">
              <span>Résumé text</span>
              <textarea
                rows={4}
                value={resume}
                onChange={(e) => setResume(e.target.value.slice(0, 30000))}
                placeholder="Paste your résumé (used as the factual source for answers)"
              />
            </label>
            <div className="row gap">
              <label className="btn tiny file-btn">
                Load résumé file
                <input
                  type="file"
                  accept=".txt,.md,.json"
                  hidden
                  onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                    const input = e.currentTarget
                    const file = input.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    setResume(text.slice(0, 30000))
                    input.value = ''
                  }}
                />
              </label>
              <button className="btn tiny" onClick={() => void importResumePdf()}>
                Import PDF
              </button>
              <span className="hint small">.txt / .md / .json, or Import PDF</span>
            </div>
            <p className="hint small">
              File dialogs aren't hidden during screen shares — import before you start sharing.
            </p>
            {pendingResumePdf && (
              // Inline (not native) so the prompt never appears in a screen share.
              <div className="row gap">
                <span className="hint small">Replace existing résumé text?</span>
                <button
                  className="btn tiny"
                  onClick={() => {
                    const pending = pendingResumePdf
                    if (!pending) return
                    setPendingResumePdf(null)
                    applyResumePdf(pending)
                  }}
                >
                  Replace
                </button>
                <button className="btn tiny ghost" onClick={() => setPendingResumePdf(null)}>
                  Cancel
                </button>
              </div>
            )}

            <div className="providers">
              <div>
                <span className="label">Answers</span>
                <span className="mono">{activeProfile.model || activeProfile.label}</span>
              </div>
              <div>
                <span className="label">Speech</span>
                <span className="mono">
                  {config.asr.mode === 'whispercpp' ? 'whisper.cpp' : 'OpenAI-compatible'}
                </span>
              </div>
            </div>
            <div className="row gap">
              <button className="btn" onClick={() => setView('settings')}>
                Settings
              </button>
              <button className="btn" onClick={() => setView('history')}>
                History
              </button>
              <button className="btn ghost" onClick={() => void window.api.quit()}>
                Quit
              </button>
            </div>
            <p className="hint small">
              Hotkeys: Ctrl+Shift+Enter answer · Ctrl+Alt+Enter screenshot · Ctrl+Shift+Space chat ·
              Ctrl+Shift+arrows move · Ctrl+Shift+H hide
            </p>
          </div>
        )}

        {view === 'live' && (
          <div className="live">
            <div className="live-head">
              <div className="model-switch" ref={modelSwitchRef}>
                <button
                  ref={modelTriggerRef}
                  className="model-chip"
                  title="Applies to your next question"
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  onClick={() => setModelMenuOpen((open) => !open)}
                >
                  <span className={`badge ${activeProfile.badge}`}>
                    {badgeLabel(activeProfile.badge)}
                  </span>
                  <span className="model-chip-label">{activeProfile.label}</span>
                  <span className="model-chip-caret">▾</span>
                </button>
                {modelMenuOpen && (
                  <div
                    className="model-menu"
                    role="menu"
                    ref={modelMenuRef}
                    onKeyDown={(e) =>
                      handleMenuKeyDown(e, () => setModelMenuOpen(false), modelTriggerRef.current)
                    }
                  >
                    {config.llm.profiles.map((profile) => {
                      const selected = profile.id === config.llm.activeProfileId
                      return (
                        <button
                          key={profile.id}
                          role="menuitemradio"
                          aria-checked={selected}
                          className={`model-menu-item${selected ? ' active' : ''}`}
                          onClick={() => void switchProfile(profile.id)}
                        >
                          <span className={`badge ${profile.badge}`}>
                            {badgeLabel(profile.badge)}
                          </span>
                          <span className="model-menu-label">{profile.label}</span>
                          <span className="model-menu-check">{selected ? '✓' : ''}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            {listening && (
              <div className="meters">
                <div className="meter">
                  <span className="meter-label">You</span>
                  <div className="meter-track">
                    <div
                      className="meter-fill you"
                      ref={(el) => {
                        meterBars.current.you = el
                      }}
                    />
                  </div>
                </div>
                <div className="meter">
                  <span className="meter-label meter-label-them">Them ◂▮▮▸</span>
                  <div className="meter-track">
                    <div
                      className="meter-fill them"
                      ref={(el) => {
                        meterBars.current.them = el
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            <div
              className="scroll"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget
                atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48
              }}
            >
              {segments.length === 0 && answers.length === 0 && (
                <div className="empty">
                  {listening
                    ? 'Listening… speak or play call audio.'
                    : 'Capture is stopped. Press Start to listen again.'}
                </div>
              )}

              {thread.map((item) =>
                item.kind === 'seg' ? (
                  <SegmentRow key={item.segment.id} segment={item.segment} />
                ) : (
                  <AnswerRow
                    key={item.answer.id}
                    answer={item.answer}
                    onRegenerate={onRegenerate}
                    onStop={onStopAnswer}
                  />
                )
              )}
            </div>

            {attachments.length > 0 && (
              <div className="attachments">
                {attachments.map((url, i) => (
                  <img key={i} src={url} alt={`attachment ${i + 1}`} className="thumb" />
                ))}
                <button className="btn tiny" onClick={() => setAttachments([])}>
                  clear
                </button>
              </div>
            )}

            <div className="composer">
              <textarea
                ref={composerRef}
                className="input"
                value={input}
                placeholder="Ask anything, or press Answer…"
                rows={2}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage()
                  }
                }}
              />
              <div className="composer-actions">
                <div className="model-switch question-switch" ref={questionSwitchRef}>
                  <button
                    ref={questionTriggerRef}
                    className="model-chip question-chip"
                    title="Question type — Auto guesses from the question and affects effort, STAR and coding format"
                    aria-haspopup="menu"
                    aria-expanded={questionMenuOpen}
                    onClick={() => setQuestionMenuOpen((open) => !open)}
                  >
                    <span className="model-chip-label">
                      {config.answer.questionType === 'auto'
                        ? `Auto · ${QUESTION_TYPE_LABELS[resolvedQuestionType]}`
                        : QUESTION_TYPE_LABELS[config.answer.questionType]}
                    </span>
                    <span className="model-chip-caret">▾</span>
                  </button>
                  {questionMenuOpen && (
                    <div
                      className="model-menu question-menu"
                      role="menu"
                      ref={questionMenuRef}
                      onKeyDown={(e) =>
                        handleMenuKeyDown(
                          e,
                          () => setQuestionMenuOpen(false),
                          questionTriggerRef.current
                        )
                      }
                    >
                      {QUESTION_TYPE_MENU.map((type) => {
                        const selected = config.answer.questionType === type
                        return (
                          <button
                            key={type}
                            role="menuitemradio"
                            aria-checked={selected}
                            className={`model-menu-item${selected ? ' active' : ''}`}
                            onClick={() => {
                              setQuestionMenuOpen(false)
                              updateQuestionType(type)
                            }}
                          >
                            <span className="model-menu-label">
                              {type === 'auto'
                                ? `Auto · ${QUESTION_TYPE_LABELS[resolvedQuestionType]}`
                                : QUESTION_TYPE_LABELS[type]}
                            </span>
                            <span className="model-menu-check">{selected ? '✓' : ''}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                <button className="btn" onClick={() => void captureShot()} title="Ctrl+Alt+Enter">
                  Screenshot
                </button>
                <button
                  className="btn"
                  onClick={() => void openRegionPicker()}
                  title="Capture a saved region (Ctrl+Alt+R after saving)"
                >
                  Set region…
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    if (input.trim()) cancelCoalesce()
                    void ask({ question: input.trim() || undefined })
                  }}
                  disabled={streaming.current}
                >
                  Answer
                </button>
                {listening ? (
                  <button className="btn ghost" onClick={stopCapture}>
                    Stop
                  </button>
                ) : (
                  <button className="btn" onClick={() => void beginSession()}>
                    Start
                  </button>
                )}
                <button className="btn ghost" onClick={() => void endSession()}>
                  End
                </button>
              </div>
            </div>
          </div>
        )}

        {view === 'settings' && (
          <SettingsView
            config={config}
            badgeLabel={badgeLabel}
            newId={uid}
            errorMessage={errorMessage}
            runCaptureChecks={runRendererCaptureChecks}
            updateState={updateState}
            updateReady={updateReady}
            listening={listening}
            onToast={showToast}
            onSave={async (draft) => {
              const next = await window.api.setConfig({
                ...draft,
                session: { ...draft.session, title, company, jobDescription, extraContext },
                profile: { resume, background, vocabulary }
              })
              setConfig(next)
              showToast('Settings saved')
              setView(segments.length > 0 ? 'live' : 'home')
            }}
            onBack={() => setView(segments.length > 0 ? 'live' : 'home')}
            onClear={clearAll}
          />
        )}

        {view === 'history' && (
          <HistoryView
            detail={historyDetail}
            sessions={historyList}
            loading={historyLoading}
            pendingDelete={pendingDelete}
            pendingDeleteAll={pendingDeleteAll}
            onOpen={openHistorySession}
            onCloseDetail={() => setHistoryDetail(null)}
            onBackHome={() => setView('home')}
            onDelete={(name) => void deleteSession(name)}
            onExport={(name) => void exportSession(name)}
            onDeleteAll={() => void deleteAllSessions()}
            AnswerCard={StructuredAnswerCard}
          />
        )}
      </div>
    </div>
  )
}



