import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  AnswerStyle,
  AppConfig,
  CaptureTestCheck,
  CaptureTestReport,
  ChatMessage,
  EffortSetting,
  HotkeyInfo,
  ModelCatalogEntry,
  ModelProfile,
  QuestionType,
  ResolvedQuestionType,
  SpeedBadge
} from '../../shared/types'
import { MODEL_CATALOG } from '../../shared/types'
import {
  parseStructuredAnswerText as parseStructuredAnswer,
  type StructuredAnswer
} from '../../shared/structuredAnswer'
import {
  AudioEngine,
  startMicStream,
  startSystemStream,
  type Speaker
} from './lib/audio'

interface Segment {
  id: string
  speaker: Speaker
  text: string
  ts: number
  partial?: boolean
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

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
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

// Same intent as the main process CODE_RE, widened just enough for spoken questions.
const CODING_GUESS_RE =
  /\b(algorithm|complexity|optimi[sz]e|dynamic programming|data structure|binary search|recursion|two pointers|sliding window|implement|write (a|the) (function|method|program)|leetcode|array|linked list|hash ?map|stack|queue|binary tree|graph|big.?o)\b/i

const BEHAVIORAL_GUESS_RE =
  /\b(tell me about a time|describe a (situation|time|challenge)|give me an example|conflict|disagree|teamwork|worked (with|on a team)|challenge|failure|mistake|proud of|strength|weakness|leadership|deadline|under pressure|went wrong|difficult (person|situation))\b/i

const BEHAVIORAL_OPENER_RE = /^\s*(tell me about (a time|yourself)|describe (a time|a situation))/i

function guessQuestionType(text: string): ResolvedQuestionType {
  // A story-style opener wins even when it mentions a coding verb ("...implement a change").
  if (BEHAVIORAL_OPENER_RE.test(text)) return 'behavioral'
  if (CODING_GUESS_RE.test(text)) return 'coding'
  if (BEHAVIORAL_GUESS_RE.test(text)) return 'behavioral'
  return 'other'
}

function resolveQuestionType(setting: QuestionType, text: string): ResolvedQuestionType {
  return setting === 'auto' ? guessQuestionType(text) : setting
}

// Static preview corpus: shaped by the live style draft, never sent anywhere.
// Rough word targets: concise ~45, balanced ~85, detailed ~140.
function sampleBehavioral(a: AnswerStyle): string {
  const story = [
    'At my last company our checkout p95 doubled a week before launch',
    'I owned the rollout and had to recover latency without moving the date',
    'I profiled the hot path, split a blocking write, and paired with the on-call engineer on a bounded cache',
    'As a result, p95 fell under 200 ms and we shipped on time with no rollbacks',
    'The lesson was to measure first and keep the fix small'
  ]
  let beats: string[]
  if (a.star) {
    beats =
      a.length === 'concise'
        ? [story[0], story[2], story[3]]
        : a.length === 'detailed'
          ? story
          : story.slice(0, 4)
  } else {
    beats =
      a.length === 'concise'
        ? [story[0], story[2]]
        : a.length === 'detailed'
          ? [...story.slice(0, 3), story[4]]
          : story.slice(0, 3)
  }
  if (a.tone === 'simple') {
    beats = beats.map((beat) => beat.replace('profiled the hot path', 'checked where the time went'))
  }
  const lines = beats.map((beat) => `${beat}.`)
  if (a.tone === 'casual') {
    lines[0] = `So, ${lines[0].charAt(0).toLowerCase()}${lines[0].slice(1)} you know?`
  }
  if (a.fillerWords && a.tone !== 'casual') {
    lines.splice(1, 0, 'Honestly, that week was intense.')
  }
  if (a.format === 'bullets') return lines.map((line) => `• ${line}`).join('\n')
  if (a.format === 'balanced') {
    const split = Math.max(1, Math.ceil(lines.length / 2))
    return `${lines.slice(0, split).join(' ')}\n\n${lines.slice(split).join(' ')}`
  }
  return lines.join(' ')
}

function sampleCoding(a: AnswerStyle): string {
  const code: Record<AnswerStyle['codeLanguage'], string> = {
    python:
      'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n    return []',
    javascript:
      'function twoSum(nums, target) {\n  const seen = new Map()\n  for (let i = 0; i < nums.length; i++) {\n    const need = target - nums[i]\n    if (seen.has(need)) return [seen.get(need), i]\n    seen.set(nums[i], i)\n  }\n  return []\n}',
    java:
      'int[] twoSum(int[] nums, int target) {\n    Map<Integer, Integer> seen = new HashMap<>();\n    for (int i = 0; i < nums.length; i++) {\n        int need = target - nums[i];\n        if (seen.containsKey(need)) return new int[]{seen.get(need), i};\n        seen.put(nums[i], i);\n    }\n    return new int[]{};\n}',
    cpp:
      'vector<int> twoSum(vector<int>& nums, int target) {\n    unordered_map<int, int> seen;\n    for (int i = 0; i < nums.size(); i++) {\n        int need = target - nums[i];\n        if (seen.count(need)) return {seen[need], i};\n        seen[nums[i]] = i;\n    }\n    return {};\n}'
  }
  const approach =
    a.tone === 'casual'
      ? "So, I'd scan the array once, stash each value's index, and look for the complement — you know, the classic one-pass hash map."
      : 'I would scan the array once, store each value and index in a hash map, and check for the complement at every step.'
  const steps = [
    'Create a map from value to index.',
    'For each element, check whether target - value is already in the map.',
    'If it is, return both indices; otherwise store the current index.',
    'Return an empty result when no pair exists.'
  ]
  const stepText =
    a.format === 'paragraph'
      ? steps.map((step, i) => `${i + 1}. ${step}`).join(' ')
      : steps.map((step, i) => `${i + 1}. ${step}`).join('\n')
  const filler = a.fillerWords && a.tone !== 'formal' ? ' Honestly, that keeps it linear.' : ''
  return `${approach}${filler}\n\n${stepText}\n\n${code[a.codeLanguage]}\n\nTime complexity: O(n). Space complexity: O(n).`
}

function structuredAnswerText(card: StructuredAnswer): string {
  const parts: string[] = []
  if (card.approach) parts.push(card.approach)
  if (card.keySteps.length > 0) {
    parts.push(card.keySteps.map((step, index) => `${index + 1}. ${step}`).join('\n'))
  }
  if (card.code.source) {
    parts.push(`\`\`\`${card.code.language}\n${card.code.source}\n\`\`\``)
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

function buildSystemPrompt(
  cfg: AppConfig,
  hasImageAttachment: boolean,
  qType: ResolvedQuestionType
): string {
  const a = cfg.answer
  const lengthRule =
    a.length === 'concise'
      ? 'Keep answers short: 50-80 words.'
      : a.length === 'detailed'
        ? 'Give a thorough answer: 150-220 words.'
        : 'Aim for 80-140 words.'
  const formatRule =
    a.format === 'bullets'
      ? 'When listing points, use tight bullet lines.'
      : a.format === 'paragraph'
        ? 'Answer in flowing prose without bullet lists.'
        : 'Mix short paragraphs with a bullet list when it helps clarity.'
  const toneRule =
    a.tone === 'casual'
      ? 'Use a natural, conversational tone.'
      : a.tone === 'simple'
        ? 'Use plain, simple language.'
        : 'Use a professional, composed tone.'
  const starRule =
    a.star || qType === 'behavioral'
      ? 'For behavioral questions, structure the answer as STAR (Situation, Task, Action, Result) without labeling the parts aloud.'
      : ''
  const fillerRule = a.fillerWords
    ? 'Include light, natural spoken fillers ("honestly", "so", "you know") sparingly, no more than once or twice.'
    : 'Avoid filler words; speak crisply.'

  const profile = [
    cfg.profile.background.trim() && `Candidate background:\n${clip(cfg.profile.background, 20000)}`,
    cfg.profile.resume.trim() &&
      `Resume (factual source for the candidate):\n${clip(cfg.profile.resume, 30000)}`
  ]
    .filter(Boolean)
    .join('\n\n')

  const session = [
    cfg.session.company.trim() && `Company: ${cfg.session.company.trim()}`,
    cfg.session.jobDescription.trim() &&
      `Job description:\n${clip(cfg.session.jobDescription, 10000)}`,
    cfg.session.extraContext.trim() &&
      `Extra instructions:\n${clip(cfg.session.extraContext, 20000)}`
  ]
    .filter(Boolean)
    .join('\n\n')

  // Image turns only: an output protocol that overrides the spoken style for
  // screenshots. Kept last so it is the most recent instruction; the global
  // rules above (first person, never mention being an AI) still apply.
  const imageRule = hasImageAttachment
    ? qType === 'coding'
      ? [
          'An image is attached to this question. Read it completely before answering.',
          'This is a coding question. Respond with ONLY a JSON object and no other text, using exactly this shape:',
          `{"approach": "<=2 sentence first-person approach", "key_steps": ["..."], "code": {"language": "${a.codeLanguage}", "source": "..."}, "complexity": {"time": "...", "space": "..."}}`,
          `Fill "approach" with at most two spoken-style first-person sentences. "key_steps" lists the algorithm steps in order. "code.source" is the complete, correct, runnable ${a.codeLanguage} solution, with NO markdown fences inside the JSON string. "complexity" gives big-O time and space. No trailing questions, offers, or meta commentary.`,
          'These image rules take precedence over the Style word budget above.'
        ].join('\n')
      : [
          'An image is attached to this question. Read it completely before answering.',
          `- If the image contains a programming/coding problem: open with at most a 1-2 sentence first-person approach summary (spoken style), then IMMEDIATELY give the complete, correct, runnable solution in ONE code block in ${a.codeLanguage}. No trailing questions, no "want me to..." offers, no meta commentary, no restating the problem. If the approach is trivial, the code block can be the whole answer.`,
          '- Else if the image is a multiple-choice question: state the selected answer (letter + text) FIRST, then at most one short line of justification.',
          '- Else: fall back to the normal spoken-answer style.',
          'These image rules take precedence over the Style word budget above.'
        ].join('\n')
    : ''

  return [
    "You are the user's live interview copilot. Your job: give a direct, speakable answer to the latest question in the call transcript.",
    'Rules:',
    '- Answer in the first person, natural spoken style, as the candidate.',
    '- Be accurate; use only the provided context for facts. Never invent employers, dates, metrics, or achievements. Any number or metric you state must appear in the reference material above. If facts are missing, give a sensible framework and briefly note the gap.',
    '- Never mention that you are an AI, a model, or a transcript.',
    '- If no clear question is present, ask the user to repeat it in one short sentence.',
    `Style: ${lengthRule} ${formatRule} ${toneRule} ${fillerRule}`,
    starRule,
    session && `Session context:\n${session}`,
    profile && `About the candidate:\n${profile}`,
    imageRule
  ]
    .filter(Boolean)
    .join('\n')
}

// In-memory render cap; sessions keep everything retained. Raised for long interviews.
const MAX_SEGMENTS = 2000

// Session JSON keeps only the most recent screenshots to bound file size.
const MAX_SESSION_IMAGES = 10

// Queued follow-ups older than this are stale for a live interview and dropped.
const QUEUE_TTL_MS = 60_000

// While listening, snapshot the live session so a crash/quit loses at most this.
const AUTOSAVE_INTERVAL_MS = 120_000
const AUTOSAVE_FILE_NAME = 'autosave.json'

// Overall cap for letting in-flight finals land before End/quit saves.
const CHAIN_DRAIN_TIMEOUT_MS = 4000

function formatAccelerator(accelerator: string): string {
  return accelerator.replace(/CommandOrControl/g, 'Ctrl')
}

const BADGE_LABELS: Record<SpeedBadge, string> = {
  recommended: 'Recommended',
  fast: 'Fast',
  slow: 'Slow',
  'very-slow': 'Very slow'
}

function badgeLabel(badge: SpeedBadge): string {
  return BADGE_LABELS[badge]
}

// Presets apply effort to the active profile; the legacy field is mirrored so
// configs migrated later keep the same intent.
function presetLlm(cfg: AppConfig, effort: 'low' | 'high'): AppConfig['llm'] {
  return {
    ...cfg.llm,
    reasoningEffort: effort,
    profiles: cfg.llm.profiles.map((profile) =>
      profile.id === cfg.llm.activeProfileId ? { ...profile, effort } : profile
    )
  }
}

// Settings presets only patch the draft: the user still reviews and saves.
// The model is intentionally never changed here.
function applyPreset(cfg: AppConfig, preset: 'behavioral' | 'coding'): AppConfig {
  if (preset === 'behavioral') {
    return {
      ...cfg,
      llm: presetLlm(cfg, 'low'),
      answer: {
        ...cfg.answer,
        length: 'balanced',
        format: 'paragraph',
        tone: 'casual',
        star: true,
        fillerWords: true
      }
    }
  }
  return {
    ...cfg,
    llm: presetLlm(cfg, 'high'),
    answer: {
      ...cfg.answer,
      length: 'concise',
      format: 'bullets',
      tone: 'simple',
      star: false,
      fillerWords: false
    }
  }
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

function similarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[.!?]+$/, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    )
  const left = tokenize(a)
  const right = tokenize(b)
  let intersection = 0
  for (const w of left) if (right.has(w)) intersection++
  const union = left.size + right.size - intersection
  return union > 0 ? intersection / union : 0
}

function isQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (t.includes('?')) return true
  const normalized = t.toLowerCase()
  if (
    /(a time when|a time you|tell me about|walk me through|experience with|example of|greatest strength|greatest weakness)/.test(
      normalized
    )
  ) {
    return true
  }
  return /^(?:\S+\s+){0,2}(what|how|why|when|where|who|which|can|could|would|do|did|have|are)\b/i.test(
    t
  )
}

function looksCompleteQuestion(text: string): boolean {
  const t = text.trim()
  if (!t.endsWith('?')) return false
  const words = t.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w))
  return words.length >= 5
}

function uid(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

interface SessionSummary {
  name: string
  title: string
  company: string
  endedAt: string | null
  segments: number
  answers: number
}

interface SessionData {
  title?: string
  company?: string
  endedAt?: string
  segments?: Array<{ id?: string; speaker: string; text: string; ts: number }>
  answers?: Array<{
    text: string
    error?: string
    question?: string
    anchorId?: string
    images?: string[]
  }>
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [view, setView] = useState<'home' | 'live' | 'settings' | 'history'>('home')
  const [segments, setSegments] = useState<Segment[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [listening, setListening] = useState(false)
  const [levels, setLevels] = useState({ you: 0, them: 0 })
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
  const regionDrag = useRef<{ startX: number; startY: number; rect: DOMRect } | null>(null)
  const regionImgRef = useRef<HTMLImageElement | null>(null)
  const modelSwitchRef = useRef<HTMLDivElement | null>(null)
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
    const off = window.api.onUpdateReady((payload) => setUpdateReady(payload))
    return off
  }, [])

  // Dismiss the profile menu on an outside pointerdown or Escape.
  useEffect(() => {
    if (!modelMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (modelSwitchRef.current?.contains(event.target as Node)) return
      setModelMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modelMenuOpen])

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
      if (
        speaker === 'Them' &&
        cfg?.interaction.autoAnswer &&
        isQuestion(clean) &&
        !askedUids.current.has(utteranceId)
      ) {
        askedUids.current.add(utteranceId)
        if (
          !streaming.current &&
          Date.now() - lastAnswerAt.current >= cfg.interaction.answerCooldownMs
        ) {
          askRef.current(clean, utteranceId)
        } else {
          queueAsk(clean, utteranceId)
        }
      }
    },
    [queueAsk]
  )

  // Whisper initial_prompt: company + vocabulary first, then the recent
  // transcript carry-over in the remaining budget.
  // OpenAI whisper-1 prompt limit is 224 tokens; 700 chars is safe headroom.
  const whisperPrompt = useCallback((speaker: Speaker): string => {
    const carry = promptRef.current[speaker]
    const cfg = configRef.current
    const company = (cfg?.session.company ?? '').replace(/\s+/g, ' ').trim()
    const vocabulary = (cfg?.profile.vocabulary ?? '').replace(/\s+/g, ' ').trim()
    const prefix = [
      company && `Company: ${company}.`,
      vocabulary && `Terms: ${vocabulary}.`
    ]
      .filter(Boolean)
      .join(' ')
    if (!prefix) return carry
    const budget = 700
    const clipped = prefix.slice(0, budget)
    const room = Math.max(0, budget - clipped.length - 1)
    return `${clipped}${room > 0 && carry ? ` ${carry.slice(-room)}` : ''}`.slice(0, budget)
  }, [])

  const handlePartial = useCallback(
    (speaker: Speaker, wav: ArrayBuffer, uid: number) => {
      if (!configRef.current?.interaction.streamingPartials) return
      if (partialBusy.current[speaker]) return
      partialBusy.current[speaker] = true
      const seq = ++partialSeq.current[speaker]
      const info = partialInfo.current[speaker]
      info.uid = uid
      info.finalizing = false
      window.api
        .transcribe(wav, whisperPrompt(speaker))
        .then(({ text }) => {
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
          if (
            speaker === 'Them' &&
            cfg?.interaction.autoAnswer &&
            cfg.interaction.earlyAnswer &&
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
    [queueAsk, whisperPrompt]
  )

  const onWav = useCallback(
    (speaker: Speaker, wav: ArrayBuffer, uid: number) => {
      const partialId = `partial-${speaker}-${uid}`
      const info = partialInfo.current[speaker]
      info.uid = uid
      info.finalizing = true
      chains.current[speaker] = chains.current[speaker]
        .then(async () => {
          const { text } = await window.api.transcribe(wav, whisperPrompt(speaker))
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
    [appendSegment, removePartial, whisperPrompt]
  )

  const ask = useCallback(
    async (opts?: {
      question?: string
      transcript?: string
      answerId?: string
      useAttachments?: boolean
      anchorUid?: number
      answerAnchor?: string
    }) => {
      const cfg = configRef.current
      if (!cfg || streaming.current) return
      const question = opts?.question?.trim()
      const transcript =
        opts?.transcript ??
        segmentsRef.current
          .slice(-40)
          .map((s) => `${s.speaker}: ${s.text}`)
          .join('\n')
      if (!question && !transcript && attachments.length === 0) {
        showToast('No transcript yet — start listening or type a question.')
        return
      }
      streaming.current = true
      const id = opts?.answerId ?? uid()
      const anchorId =
        opts?.answerAnchor ??
        (opts?.anchorUid != null
          ? `final-Them-${opts.anchorUid}`
          : [...segmentsRef.current].reverse().find((s) => s.speaker === 'Them')?.id ?? undefined)
      // Auto resolves from the explicit question, else the latest remote turn.
      const latestThem = [...segmentsRef.current].reverse().find((s) => s.speaker === 'Them')
      const questionType = resolveQuestionType(
        cfg.answer.questionType,
        question ?? latestThem?.text ?? transcript
      )
      // Outgoing images for this ask: none for regenerate, and none over IPC
      // when vision is off (main would drop them anyway). The model only sees
      // images when vision is enabled.
      const images =
        opts?.useAttachments === false || !cfg.llm.vision ? [] : attachments
      const hasImageAttachment = images.length > 0
      const structured = hasImageAttachment && questionType === 'coding'
      const assistantTurns: ChatMessage[] = answersRef.current
        .filter((a) => a.text.trim() && !a.error)
        .slice(-2)
        .map((a) => ({ role: 'assistant', content: a.text }))
      console.log(`[answer-anchor] ${anchorId ?? 'none'} | ${questionType} | ${question ?? ''}`)
      if (structured) structuredAnswers.current.add(id)
      setAnswers((prev) => [
        ...prev.filter((a) => a.id !== id).slice(-9),
        { id, text: '', streaming: true, question, transcript, anchorId, images }
      ])
      const userContent = [
        `Session: ${titleRef.current}`,
        '',
        'Transcript so far:',
        transcript || '(no transcript yet)',
        '',
        question ? `User question: ${question}` : 'Answer the latest question from the transcript.'
      ].join('\n')
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(cfg, hasImageAttachment, questionType) },
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
    [attachments, showToast, dispatchQueuedAsk]
  )

  const regenerate = useCallback(
    (answer: Answer) => {
      if (streaming.current) return
      setAnswers((prev) => prev.filter((a) => a.id !== answer.id))
      void ask({
        question: answer.question,
        transcript: answer.transcript,
        useAttachments: false,
        answerAnchor: answer.anchorId
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
    setSegments([])
    segmentsRef.current = []
    setAnswers([])
    setAttachments([])
    transcriptSavedRef.current = false
    partialInfo.current = {
      You: { uid: -1, applied: 0, finalizing: false },
      Them: { uid: -1, applied: 0, finalizing: false }
    }
    partialSeq.current = { You: 0, Them: 0 }
    partialBusy.current = { You: false, Them: false }
    askedUids.current = new Set()
    pendingAsks.current = []
    promptRef.current = { You: '', Them: '' }
  }, [])

  const startCapture = useCallback(async () => {
    setError(null)
    try {
      const wantMic = configRef.current?.interaction.transcribeMic ?? false
      const micPromise: Promise<MediaStream | null> = wantMic
        ? startMicStream()
        : Promise.resolve(null)
      const results = await Promise.allSettled([micPromise, startSystemStream()])
      const mic = results[0].status === 'fulfilled' ? results[0].value : null
      const system = results[1].status === 'fulfilled' ? results[1].value : null
      console.log('[capture] sources', {
        mic: Boolean(mic),
        system: Boolean(system),
        systemTracks: system?.getAudioTracks().length ?? 0,
        micError: results[0].status === 'rejected' ? String(results[0].reason) : null,
        systemError: results[1].status === 'rejected' ? String(results[1].reason) : null
      })
      if (system) {
        const track = system.getAudioTracks()[0]
        track?.addEventListener('ended', () => console.log('[capture] system track ended'))
        track?.addEventListener('mute', () => console.log('[capture] system track muted'))
        track?.addEventListener('unmute', () => console.log('[capture] system track unmuted'))
      }
      if (!mic && !system) {
        throw new Error(
          'No audio sources available. Check your microphone and Windows output device.'
        )
      }
      const you = mic
        ? new AudioEngine(
            'You',
            onWav,
            (level) => setLevels((prev) => ({ ...prev, you: level })),
            handlePartial
          )
        : undefined
      const them = system
        ? new AudioEngine(
            'Them',
            onWav,
            (level) => setLevels((prev) => ({ ...prev, them: level })),
            handlePartial
          )
        : undefined
      if (you && mic) await you.startWithStream(mic)
      if (them && system) await them.startWithStream(system)
      engines.current?.you?.stop()
      engines.current?.them?.stop()
      engines.current = { you, them }
      askedUids.current = new Set()
      pendingAsks.current = []
      chains.current = { You: Promise.resolve(), Them: Promise.resolve() }
      transcriptSavedRef.current = false
      setListening(true)
      void window.api.setCaptureListening(true).catch(() => undefined)
      setView('live')
      if (wantMic && !mic) setError('Microphone unavailable — capturing system audio only.')
      if (!system) setError('System audio unavailable — check your Windows output device.')
    } catch (err) {
      setError(errorMessage(err))
      setListening(false)
      void window.api.setCaptureListening(false).catch(() => undefined)
    }
  }, [onWav])

  const beginSession = useCallback(async () => {
    // A fresh session never inherits the previous transcript; resuming from the
    // live view (Stop → Start) keeps the capture already in progress.
    if (view !== 'live') clearAll()
    const next = await window.api.setConfig({
      session: { title, company, jobDescription, extraContext },
      profile: { resume, background, vocabulary }
    })
    setConfig(next)
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
    engines.current?.you?.stop()
    engines.current?.them?.stop()
    engines.current = null
    askedUids.current = new Set()
    pendingAsks.current = []
    if (queueTimer.current) {
      window.clearTimeout(queueTimer.current)
      queueTimer.current = null
    }
    setListening(false)
    void window.api.setCaptureListening(false).catch(() => undefined)
    setLevels({ you: 0, them: 0 })
  }, [])

  // Snapshot shared by the real save and the 120s autosave. Orphan anchors get
  // a placeholder so history keeps the Q→A pairing.
  const buildSavePayload = useCallback((endedAt: string) => {
    const sessionSegments = [...segmentsRef.current]
    const currentAnswers = answersRef.current
    for (const answer of currentAnswers) {
      const anchorId = answer.anchorId
      if (anchorId && !sessionSegments.some((s) => s.id === anchorId)) {
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
            }
            void loadHistory()
          } catch (err) {
            // session:save now rejects on a write failure; keep it visible.
            const message = errorMessage(err).replace(
              /^Error invoking remote method '[^']+': (?:Error: )?/,
              ''
            )
            setError(message)
            showToast(message)
          }
        }
        setView('home')
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
    void ask({ question })
  }, [ask, input])

  const levelStyle = useMemo(
    () => ({
      you: { width: `${Math.min(100, levels.you * 900)}%` },
      them: { width: `${Math.min(100, levels.them * 900)}%` }
    }),
    [levels]
  )

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
        {updateReady && (
          <div className="banner info">
            Update {updateReady.version} downloaded —{' '}
            <button className="btn tiny" onClick={() => void window.api.installUpdate()}>
              Restart & install
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
                  className="model-chip"
                  title="Applies to your next question"
                  onClick={() => setModelMenuOpen((open) => !open)}
                >
                  <span className={`badge ${activeProfile.badge}`}>
                    {badgeLabel(activeProfile.badge)}
                  </span>
                  <span className="model-chip-label">{activeProfile.label}</span>
                  <span className="model-chip-caret">▾</span>
                </button>
                {modelMenuOpen && (
                  <div className="model-menu" role="menu">
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
            <div className="meters">
              <div className="meter">
                <span className="meter-label">You</span>
                <div className="meter-track">
                  <div className="meter-fill you" style={levelStyle.you} />
                </div>
              </div>
              <div className="meter">
                <span className="meter-label">Them</span>
                <div className="meter-track">
                  <div className="meter-fill them" style={levelStyle.them} />
                </div>
              </div>
            </div>

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
                <select
                  className="type-select"
                  title="Question type — Auto guesses from the question and affects effort, STAR and coding format"
                  value={config.answer.questionType}
                  onChange={(e) => updateQuestionType(e.target.value as QuestionType)}
                >
                  <option value="auto">
                    Auto · {QUESTION_TYPE_LABELS[resolvedQuestionType]}
                  </option>
                  {QUESTION_TYPE_OPTIONS.map((type) => (
                    <option key={type} value={type}>
                      {QUESTION_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
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
                  onClick={() => void ask({ question: input.trim() || undefined })}
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
          <Settings
            config={config}
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
          <div className="history">
            {historyDetail ? (
              <>
                <div className="row gap history-head">
                  <button className="btn tiny" onClick={() => setHistoryDetail(null)}>
                    Back
                  </button>
                  <strong>{historyDetail.title ?? 'Session'}</strong>
                  <span className="hint small">
                    {historyDetail.endedAt
                      ? new Date(historyDetail.endedAt).toLocaleString()
                      : ''}
                  </span>
                </div>
                <div className="scroll">
                  {(() => {
                    const segments = historyDetail.segments ?? []
                    const answerList = historyDetail.answers ?? []
                    const byAnchor = new Map<string, typeof answerList>()
                    const loose: typeof answerList = []
                    for (const answer of answerList) {
                      if (answer.anchorId) {
                        const list = byAnchor.get(answer.anchorId) ?? []
                        list.push(answer)
                        byAnchor.set(answer.anchorId, list)
                      } else {
                        loose.push(answer)
                      }
                    }
                    const items: Array<
                      | { kind: 'seg'; key: string; speaker: string; text: string }
                      | {
                          kind: 'ans'
                          key: string
                          text: string
                          images?: string[]
                          card?: StructuredAnswer
                        }
                    > = []
                    const answerItem = (answer: (typeof answerList)[number], key: string) => ({
                      kind: 'ans' as const,
                      key,
                      text: answer.text || answer.error || '',
                      images: answer.images,
                      card: answer.error
                        ? undefined
                        : parseStructuredAnswer(answer.text ?? '') ?? undefined
                    })
                    segments.forEach((segment, index) => {
                      items.push({
                        kind: 'seg',
                        key: `s${index}`,
                        speaker: segment.speaker,
                        text: segment.text
                      })
                      if (!segment.id) return
                      const anchored = byAnchor.get(segment.id)
                      if (anchored) {
                        anchored.forEach((answer, answerIndex) =>
                          items.push(answerItem(answer, `s${index}a${answerIndex}`))
                        )
                        byAnchor.delete(segment.id)
                      }
                    })
                    let extra = 0
                    for (const list of byAnchor.values()) {
                      for (const answer of list) {
                        items.push(answerItem(answer, `x${extra++}`))
                      }
                    }
                    for (const answer of loose) {
                      items.push(answerItem(answer, `l${extra++}`))
                    }
                    return items.map((item) =>
                      item.kind === 'seg' ? (
                        <div key={item.key} className="seg">
                          <span className={`speaker ${item.speaker === 'You' ? 'you' : 'them'}`}>
                            {item.speaker}
                          </span>
                          <span className="seg-text">{item.text}</span>
                        </div>
                      ) : (
                        <div key={item.key} className="answer">
                          <div className="answer-head">
                            <span className="speaker answer-tag">Answer</span>
                            {item.card && <span className="answer-kind">coded</span>}
                          </div>
                          {item.card ? (
                            <StructuredAnswerCard card={item.card} />
                          ) : (
                            <div className="answer-text">{item.text}</div>
                          )}
                          {item.images && item.images.length > 0 && (
                            <div className="attachments history-images">
                              {item.images.map((url, imageIndex) => (
                                <img
                                  key={imageIndex}
                                  className="thumb"
                                  src={url}
                                  alt={`Screenshot ${imageIndex + 1}`}
                                  title="Screenshot"
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    )
                  })()}
                </div>
              </>
            ) : (
              <>
                <div className="row gap history-head">
                  <button className="btn tiny" onClick={() => setView('home')}>
                    Back
                  </button>
                  <strong>Session history</strong>
                  {historyList.length > 0 && (
                    <button
                      className="btn tiny danger"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => void deleteAllSessions()}
                    >
                      {pendingDeleteAll ? 'Confirm delete all' : 'Delete all'}
                    </button>
                  )}
                </div>
                <div className="scroll">
                  {historyLoading && <div className="empty">Loading…</div>}
                  {!historyLoading && historyList.length === 0 && (
                    <div className="empty">No saved sessions yet. End a session to save it.</div>
                  )}
                  {historyList.map((session) => (
                    <div key={session.name} className="history-row">
                      <button
                        className="history-item"
                        onClick={() => {
                          void (async () => {
                            try {
                              const data = (await window.api.getSession(session.name)) as SessionData
                              setHistoryDetail(data)
                            } catch (err) {
                              setError(errorMessage(err))
                            }
                          })()
                        }}
                      >
                        <div className="history-title">{session.title}</div>
                        <div className="hint small">
                          {session.endedAt
                            ? new Date(session.endedAt).toLocaleString()
                            : 'unknown date'}{' '}
                          · {session.segments} transcript · {session.answers} answers
                        </div>
                      </button>
                      <button
                        className="btn tiny"
                        title="Export this session as Markdown"
                        onClick={() => void exportSession(session.name)}
                      >
                        Export
                      </button>
                      <button
                        className="btn tiny danger"
                        title="Delete this session"
                        onClick={() => void deleteSession(session.name)}
                      >
                        {pendingDelete === session.name ? 'Confirm' : 'Delete'}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Settings({
  config,
  onToast,
  onSave,
  onBack,
  onClear
}: {
  config: AppConfig
  onToast: (message: string) => void
  onSave: (draft: AppConfig) => Promise<void>
  onBack: () => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState<AppConfig>(config)
  const [captureTest, setCaptureTest] = useState<CaptureTestReport | null>(null)
  const [captureTesting, setCaptureTesting] = useState(false)
  const [hotkeys, setHotkeys] = useState<HotkeyInfo[]>([])

  // Background config writes (hotkeys, click-through, meeting toggles) must not
  // clobber edits in progress: only re-sync when the draft is clean.
  const draftRef = useRef(draft)
  const syncedConfigRef = useRef(config)
  draftRef.current = draft

  useEffect(() => {
    if (JSON.stringify(draftRef.current) !== JSON.stringify(syncedConfigRef.current)) return
    syncedConfigRef.current = config
    setDraft(config)
  }, [config])

  useEffect(() => {
    void window.api
      .getHotkeys()
      .then(setHotkeys)
      .catch(() => undefined)
  }, [])

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  const setLlm = <K extends keyof AppConfig['llm']>(key: K, value: AppConfig['llm'][K]): void => {
    setDraft((prev) => ({ ...prev, llm: { ...prev.llm, [key]: value } }))
  }
  const setAsr = <K extends keyof AppConfig['asr']>(key: K, value: AppConfig['asr'][K]): void => {
    setDraft((prev) => ({ ...prev, asr: { ...prev.asr, [key]: value } }))
  }
  const setInteraction = <K extends keyof AppConfig['interaction']>(
    key: K,
    value: AppConfig['interaction'][K]
  ): void => {
    setDraft((prev) => ({ ...prev, interaction: { ...prev.interaction, [key]: value } }))
  }
  const setAnswer = <K extends keyof AppConfig['answer']>(
    key: K,
    value: AppConfig['answer'][K]
  ): void => {
    setDraft((prev) => ({ ...prev, answer: { ...prev.answer, [key]: value } }))
  }
  const setMeetings = (key: keyof AppConfig['meetings'], value: boolean): void => {
    setDraft((prev) => ({ ...prev, meetings: { ...prev.meetings, [key]: value } }))
  }

  // --- Model profile editing (saved with the rest of the draft) ------------
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({})
  const [pickingModel, setPickingModel] = useState(false)
  // Remember the last numeric value while a field is omitted, so toggling Omit
  // restores it instead of a hard-coded default.
  const [lastNumbers, setLastNumbers] = useState<
    Record<string, { temperature?: number; maxTokens?: number }>
  >({})

  const updateProfile = (id: string, patch: Partial<ModelProfile>): void => {
    setDraft((prev) => ({
      ...prev,
      llm: {
        ...prev.llm,
        profiles: prev.llm.profiles.map((profile) =>
          profile.id === id ? { ...profile, ...patch } : profile
        )
      }
    }))
  }

  const rememberNumber = (
    id: string,
    key: 'temperature' | 'maxTokens',
    value: number
  ): void => {
    setLastNumbers((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        ...(key === 'temperature' ? { temperature: value } : { maxTokens: value })
      }
    }))
  }

  const setProfileNumber = (
    id: string,
    key: 'temperature' | 'maxTokens',
    value: number | null
  ): void => {
    if (value != null) rememberNumber(id, key, value)
    if (key === 'temperature') updateProfile(id, { temperature: value })
    else updateProfile(id, { maxTokens: value })
  }

  const toggleOmit = (
    profile: ModelProfile,
    key: 'temperature' | 'maxTokens',
    omit: boolean
  ): void => {
    if (!omit) {
      const fallback = key === 'temperature' ? 0.2 : 4096
      setProfileNumber(profile.id, key, lastNumbers[profile.id]?.[key] ?? fallback)
      return
    }
    const current = key === 'temperature' ? profile.temperature : profile.maxTokens
    if (current != null) rememberNumber(profile.id, key, current)
    updateProfile(
      profile.id,
      key === 'temperature' ? { temperature: null } : { maxTokens: null }
    )
  }

  const addProfile = (profile: ModelProfile): void => {
    setDraft((prev) => ({
      ...prev,
      llm: { ...prev.llm, profiles: [...prev.llm.profiles, profile] }
    }))
    setPickingModel(false)
  }

  const addCatalogProfile = (entry: ModelCatalogEntry): void => {
    addProfile({
      id: uid(),
      label: entry.label,
      badge: entry.badge,
      baseUrl: entry.baseUrl,
      apiKey: '',
      model: entry.model,
      // Anthropic 5.x rejects temperature: the catalog flag decides.
      temperature: entry.supportsTemperature ? 0.2 : null,
      maxTokens: 4096,
      effort: entry.effort,
      escalateOnCode: false
    })
  }

  const addCustomProfile = (): void => {
    addProfile({
      id: uid(),
      label: 'Custom / OpenRouter',
      badge: 'recommended',
      baseUrl: '',
      apiKey: '',
      model: '',
      // Blank fields stay omitted until the user chooses values.
      temperature: null,
      maxTokens: null,
      effort: 'default',
      escalateOnCode: false
    })
  }

  const removeProfile = (id: string): void => {
    setDraft((prev) => {
      if (prev.llm.profiles.length <= 1) return prev
      const profiles = prev.llm.profiles.filter((profile) => profile.id !== id)
      return {
        ...prev,
        llm: {
          ...prev.llm,
          profiles,
          activeProfileId:
            prev.llm.activeProfileId === id ? profiles[0].id : prev.llm.activeProfileId
        }
      }
    })
  }

  const activateProfile = (id: string): void => {
    setDraft((prev) => ({ ...prev, llm: { ...prev.llm, activeProfileId: id } }))
  }

  const runCaptureTest = async (): Promise<void> => {
    setCaptureTesting(true)
    try {
      const rendererChecks = await runRendererCaptureChecks()
      let mainChecks: CaptureTestCheck[] = []
      let ranAt = Date.now()
      try {
        const report = await window.api.testCapture()
        mainChecks = report.checks
        ranAt = report.ranAt
      } catch (err) {
        mainChecks = [
          {
            id: 'main-test',
            label: 'Main-process checks',
            pass: false,
            detail: errorMessage(err)
          }
        ]
      }
      setCaptureTest({ checks: [...mainChecks, ...rendererChecks], ranAt })
    } catch (err) {
      setCaptureTest({
        checks: [
          {
            id: 'capture-test',
            label: 'Capture self-test',
            pass: false,
            detail: errorMessage(err)
          }
        ],
        ranAt: Date.now()
      })
    } finally {
      setCaptureTesting(false)
    }
  }

  return (
    <div className="settings">
      <div className="settings-scroll">
        <h3>Interview presets</h3>
        <div className="row gap">
          <button
            className="btn"
            onClick={() => setDraft((prev) => applyPreset(prev, 'behavioral'))}
          >
            Behavioral
          </button>
          <button
            className="btn"
            onClick={() => setDraft((prev) => applyPreset(prev, 'coding'))}
          >
            Coding
          </button>
        </div>
        <p className="hint small">Presets change effort and answer style only — the model is not changed.</p>

        <h3>Models</h3>
        <p className="hint small">
          Each profile is a full endpoint identity (base URL, key, model, sampling). The active
          profile is used for new questions; switch it from the live-view header — no restart, and
          it never interrupts a streaming answer.
        </p>
        {draft.llm.profiles.map((profile) => {
          const isActive = profile.id === draft.llm.activeProfileId
          const showAdvanced = Boolean(advanced[profile.id])
          return (
            <div className={`profile-card${isActive ? ' active' : ''}`} key={profile.id}>
              <div className="profile-head">
                <input
                  className="profile-label"
                  value={profile.label}
                  aria-label="Profile label"
                  onChange={(e) => updateProfile(profile.id, { label: e.target.value })}
                />
                <span className={`badge ${profile.badge}`}>{badgeLabel(profile.badge)}</span>
                <button
                  className="btn tiny"
                  title={isActive ? 'This profile answers new questions' : 'Use this profile'}
                  disabled={isActive}
                  onClick={() => activateProfile(profile.id)}
                >
                  {isActive ? 'Active' : 'Use'}
                </button>
              </div>
              <span className="mono profile-model">{profile.model || '(no model id yet)'}</span>
              <label className="field">
                <span>Model ID</span>
                <input
                  value={profile.model}
                  onChange={(e) => updateProfile(profile.id, { model: e.target.value })}
                  placeholder="gemini-3.8-flash"
                />
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  value={profile.apiKey}
                  onChange={(e) => updateProfile(profile.id, { apiKey: e.target.value })}
                  placeholder="sk-…"
                />
              </label>
              <button
                className="btn tiny ghost"
                onClick={() => setAdvanced((prev) => ({ ...prev, [profile.id]: !showAdvanced }))}
              >
                {showAdvanced ? 'Advanced ▲' : 'Advanced ▼'}
              </button>
              {showAdvanced && (
                <div className="profile-advanced">
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      value={profile.baseUrl}
                      onChange={(e) => updateProfile(profile.id, { baseUrl: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <div className="grid2">
                    <label className="field">
                      <span>Temperature (0–1)</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        placeholder="omitted"
                        value={profile.temperature ?? ''}
                        onChange={(e) => {
                          if (e.target.value === '') {
                            toggleOmit(profile, 'temperature', true)
                            return
                          }
                          const parsed = Number(e.target.value)
                          if (Number.isFinite(parsed)) {
                            setProfileNumber(profile.id, 'temperature', parsed)
                          }
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Max tokens (128–8192)</span>
                      <input
                        type="number"
                        step="64"
                        min="128"
                        max="8192"
                        placeholder="omitted"
                        value={profile.maxTokens ?? ''}
                        onChange={(e) => {
                          if (e.target.value === '') {
                            toggleOmit(profile, 'maxTokens', true)
                            return
                          }
                          const parsed = Number(e.target.value)
                          if (Number.isFinite(parsed)) {
                            setProfileNumber(profile.id, 'maxTokens', parsed)
                          }
                        }}
                      />
                    </label>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profile.temperature === null}
                      onChange={(e) => toggleOmit(profile, 'temperature', e.target.checked)}
                    />
                    <span>Omit temperature — let the vendor pick its default</span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profile.maxTokens === null}
                      onChange={(e) => toggleOmit(profile, 'maxTokens', e.target.checked)}
                    />
                    <span>Omit max tokens</span>
                  </label>
                  <label className="field">
                    <span>Reasoning effort</span>
                    <select
                      value={profile.effort}
                      onChange={(e) =>
                        updateProfile(profile.id, { effort: e.target.value as EffortSetting })
                      }
                    >
                      <option value="default">Default — omit (vendor decides)</option>
                      <option value="low">Low — fast</option>
                      <option value="medium">Medium — balanced</option>
                      <option value="high">High — hard questions (slower)</option>
                    </select>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profile.escalateOnCode}
                      onChange={(e) =>
                        updateProfile(profile.id, { escalateOnCode: e.target.checked })
                      }
                    />
                    <span>Escalate low → high for coding/screenshot questions</span>
                  </label>
                  <button
                    className="btn tiny danger"
                    disabled={draft.llm.profiles.length <= 1}
                    onClick={() => removeProfile(profile.id)}
                  >
                    Delete profile
                  </button>
                </div>
              )}
            </div>
          )
        })}
        <div className="row gap">
          <button className="btn" onClick={() => setPickingModel((open) => !open)}>
            {pickingModel ? 'Close catalog' : 'Add model'}
          </button>
          <span className="hint small">
            Badges show expected speed. Anthropic 5.x profiles omit temperature and effort.
          </span>
        </div>
        {pickingModel && (
          <div className="catalog">
            {MODEL_CATALOG.map((entry) => (
              <button
                key={entry.model}
                className="catalog-item"
                onClick={() => addCatalogProfile(entry)}
              >
                <span className={`badge ${entry.badge}`}>{badgeLabel(entry.badge)}</span>
                <span className="catalog-label">{entry.label}</span>
                <span className="catalog-vendor">{entry.vendor}</span>
                <span className="mono catalog-model">{entry.model}</span>
              </button>
            ))}
            <button className="catalog-item custom" onClick={addCustomProfile}>
              <span className="catalog-label">Custom / OpenRouter…</span>
              <span className="catalog-vendor">manual — blank fields</span>
            </button>
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.llm.vision}
            onChange={(e) => setLlm('vision', e.target.checked)}
          />
          <span>Active model supports images (needed for screenshots in answers)</span>
        </label>
        <p className="hint small">
          Vision models only, e.g. Gemini Flash, GPT-6.1, qwen2.5vl. Vision is app-wide, not
          per-profile.
        </p>
        <label className="field">
          <span>Code language</span>
          <select
            value={draft.answer.codeLanguage}
            onChange={(e) =>
              setAnswer('codeLanguage', e.target.value as AppConfig['answer']['codeLanguage'])
            }
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
            <option value="java">Java</option>
            <option value="cpp">C++</option>
          </select>
        </label>

        <h3>Answer style</h3>
        <div className="grid2">
          <label className="field">
            <span>Length</span>
            <select
              value={draft.answer.length}
              onChange={(e) => setAnswer('length', e.target.value as AppConfig['answer']['length'])}
            >
              <option value="concise">Concise</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
          <label className="field">
            <span>Format</span>
            <select
              value={draft.answer.format}
              onChange={(e) => setAnswer('format', e.target.value as AppConfig['answer']['format'])}
            >
              <option value="bullets">Bullets</option>
              <option value="balanced">Balanced</option>
              <option value="paragraph">Paragraph</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Tone</span>
          <select
            value={draft.answer.tone}
            onChange={(e) => setAnswer('tone', e.target.value as AppConfig['answer']['tone'])}
          >
            <option value="formal">Formal</option>
            <option value="casual">Casual</option>
            <option value="simple">Simple</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.answer.star}
            onChange={(e) => setAnswer('star', e.target.checked)}
          />
          <span>Use STAR structure for behavioral answers</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.answer.fillerWords}
            onChange={(e) => setAnswer('fillerWords', e.target.checked)}
          />
          <span>Allow natural filler words (sounds less scripted)</span>
        </label>

        <div className="answer-preview">
          <div className="answer-preview-head">
            <span className="label">Answer preview</span>
            <span className="hint small">Static sample — no model call</span>
          </div>
          <div className="answer-preview-sample">
            <span className="label">Behavioral</span>
            <pre className="answer-preview-body">{sampleBehavioral(draft.answer)}</pre>
          </div>
          <div className="answer-preview-sample">
            <span className="label">Coding · {draft.answer.codeLanguage}</span>
            <pre className="answer-preview-body code">{sampleCoding(draft.answer)}</pre>
          </div>
        </div>

        <h3>Speech-to-text</h3>
        <label className="field">
          <span>Backend</span>
          <select
            value={draft.asr.mode}
            onChange={(e) => setAsr('mode', e.target.value as AppConfig['asr']['mode'])}
          >
            <option value="whispercpp">whisper.cpp server (local)</option>
            <option value="openai">OpenAI-compatible transcription</option>
          </select>
        </label>
        <label className="field">
          <span>Endpoint</span>
          <input
            value={draft.asr.url}
            onChange={(e) => setAsr('url', e.target.value)}
            placeholder="http://127.0.0.1:8080/inference"
          />
        </label>
        <label className="field">
          <span>API key (optional)</span>
          <input
            type="password"
            value={draft.asr.apiKey}
            onChange={(e) => setAsr('apiKey', e.target.value)}
          />
        </label>
        <label className="field">
          <span>Model (OpenAI-compatible mode)</span>
          <input
            value={draft.asr.model}
            onChange={(e) => setAsr('model', e.target.value)}
            placeholder="whisper-1"
          />
        </label>

        <h3>Overlay</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.privateMode}
            onChange={(e) => set('privateMode', e.target.checked)}
          />
          <span>Screen-capture protection (window excluded from sharing/recording)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.clickThrough}
            onChange={(e) => set('clickThrough', e.target.checked)}
          />
          <span>Click-through (mouse passes to apps below; Ctrl+Shift+F9 toggles)</span>
        </label>
        <label className="field">
          <span>Panel opacity: {Math.round(draft.panelOpacity * 100)}%</span>
          <input
            type="range"
            min="0.3"
            max="1"
            step="0.02"
            value={draft.panelOpacity}
            onChange={(e) => set('panelOpacity', Number(e.target.value))}
          />
        </label>

        <h3>Display</h3>
        <label className="field">
          <span>Start on</span>
          <select
            value={draft.window.screenMode}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                window: { ...prev.window, screenMode: e.target.value as 'primary' | 'cursor' }
              }))
            }
          >
            <option value="primary">Primary monitor</option>
            <option value="cursor">Monitor under cursor</option>
          </select>
        </label>
        <div className="row gap">
          <button
            className="btn"
            onClick={async () => {
              await window.api.moveToCursorDisplay()
              onToast('Moved to the cursor screen')
            }}
          >
            Move to cursor screen
          </button>
          <span className="hint small">Hotkey: Ctrl+Shift+M</span>
        </div>

        <h3>Hotkeys</h3>
        <div className="hotkey-list">
          {hotkeys.map((hotkey) => (
            <div className="hotkey-row" key={hotkey.accelerator}>
              <span className="hotkey-keys">
                {formatAccelerator(hotkey.accelerator)
                  .split('+')
                  .map((part) => (
                    <kbd key={part}>{part}</kbd>
                  ))}
              </span>
              <span className="hotkey-desc">
                {hotkey.description}
                {!hotkey.registered && (
                  <span className="hotkey-warn"> ⚠️ in use by another app</span>
                )}
              </span>
            </div>
          ))}
        </div>

        <h3>Meetings</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.meetings.detect}
            onChange={(e) => setMeetings('detect', e.target.checked)}
          />
          <span>
            Detect meeting apps (Zoom, Teams, Webex, Discord, Slack, Chime, Lark, WhatsApp)
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.meetings.autoStart}
            onChange={(e) => setMeetings('autoStart', e.target.checked)}
          />
          <span>Start listening automatically when a meeting is detected</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.meetings.balloon}
            onChange={(e) => setMeetings('balloon', e.target.checked)}
          />
          <span>Show meeting-detection notification (visible during screen shares)</span>
        </label>

        <h3>Updates (optional)</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.updates.enabled}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                updates: { ...prev.updates, enabled: e.target.checked }
              }))
            }
          />
          <span>Check for updates from a published feed</span>
        </label>
        <label className="field">
          <span>Feed URL</span>
          <input
            value={draft.updates.feedUrl}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, updates: { ...prev.updates, feedUrl: e.target.value } }))
            }
            placeholder="https://example.com/updates/"
          />
        </label>
        <div className="row gap">
          <button
            className="btn"
            onClick={async () => {
              const result = await window.api.checkForUpdates()
              onToast(
                result.ok
                  ? `Update check: ${result.version ?? 'up to date'}`
                  : `Update check failed: ${result.error ?? 'unknown error'}`
              )
            }}
          >
            Check now
          </button>
          <span className="hint small">
            Feed must host electron-builder artifacts (latest.yml + installer).
          </span>
        </div>

        <h3>Connections</h3>
        <div className="row gap">
          <button
            className="btn"
            onClick={async () => {
              const result = await window.api.testLlm()
              onToast(
                result.ok ? `LLM OK: ${result.text}` : `LLM failed: ${result.error ?? 'unknown'}`
              )
            }}
          >
            Test LLM
          </button>
          <button
            className="btn"
            onClick={async () => {
              const result = await window.api.testAsr()
              onToast(result.ok ? 'Speech endpoint OK' : `Speech failed: ${result.error ?? 'unknown'}`)
            }}
          >
            Test speech
          </button>
        </div>

        <h3>Capture self-test</h3>
        <div className="row gap">
          <button className="btn" disabled={captureTesting} onClick={() => void runCaptureTest()}>
            {captureTesting ? 'Testing…' : 'Run capture self-test'}
          </button>
          <span className="hint small">Runs invisibly — no window, picker or prompt appears.</span>
        </div>
        {captureTest && (
          <div className="test-results">
            {captureTest.checks.map((check) => (
              <div className="test-check" key={check.id}>
                <span
                  className={`test-mark ${
                    check.pass === true ? 'pass' : check.pass === false ? 'fail' : 'skip'
                  }`}
                >
                  {check.pass === true ? '✓' : check.pass === false ? '✗' : '–'}
                </span>
                <span className="test-check-body">
                  <span className="test-check-label">{check.label}</span>
                  <span className="test-check-detail">{check.detail}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <h3>Behavior</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.earlyAnswer}
            onChange={(e) => setInteraction('earlyAnswer', e.target.checked)}
          />
          <span>Answer as soon as a question is recognized (early trigger; requires Auto Answer)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.streamingPartials}
            onChange={(e) => setInteraction('streamingPartials', e.target.checked)}
          />
          <span>Live partial transcripts (updates while the person is still speaking; extra GPU use)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.transcribeMic}
            onChange={(e) => setInteraction('transcribeMic', e.target.checked)}
          />
          <span>
            Transcribe microphone ("You") — off by default; the interviewer is captured from the
            system-audio loopback
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.autoScroll}
            onChange={(e) => setInteraction('autoScroll', e.target.checked)}
          />
          <span>Auto-scroll answers (follow new content; pauses while you scroll up)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.autoAnswer}
            onChange={(e) => setInteraction('autoAnswer', e.target.checked)}
          />
          <span>Auto Answer (beta) — answer detected questions automatically</span>
        </label>
        <label className="field">
          <span>Auto-answer cooldown (ms)</span>
          <input
            type="number"
            step="500"
            min="1000"
            max="30000"
            value={draft.interaction.answerCooldownMs}
            onChange={(e) => {
              // Clamp in the draft so the field never shows a value main will
              // silently clamp on save (same 1000–30000 bounds).
              const next = Math.round(Number(e.target.value))
              setInteraction(
                'answerCooldownMs',
                Number.isFinite(next) ? Math.min(30000, Math.max(1000, next)) : 5000
              )
            }}
          />
        </label>

        <div className="row gap">
          <button className="btn primary" onClick={() => void onSave(draft)}>
            Save
          </button>
          <button className="btn" onClick={onBack}>
            Back
          </button>
          <button className="btn ghost danger" onClick={onClear}>
            Clear transcript
          </button>
        </div>
      </div>
    </div>
  )
}
