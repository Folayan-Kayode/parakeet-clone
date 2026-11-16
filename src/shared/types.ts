export type AsrMode = 'whispercpp' | 'openai'

export type SpeedBadge = 'recommended' | 'fast' | 'slow' | 'very-slow'

/** 'default' = omit reasoning_effort from the request entirely. */
export type EffortSetting = 'low' | 'medium' | 'high' | 'default'

export interface ModelProfile {
  id: string
  label: string
  badge: SpeedBadge
  baseUrl: string
  apiKey: string
  model: string
  /** null = omit the field from the request body entirely */
  temperature: number | null
  /** null = omit the field from the request body entirely */
  maxTokens: number | null
  effort: EffortSetting
  escalateOnCode: boolean
}

export type ModelVendor = 'google' | 'openai' | 'anthropic'

export interface ModelCatalogEntry {
  label: string
  vendor: ModelVendor
  model: string
  baseUrl: string
  badge: SpeedBadge
  effort: EffortSetting
  supportsEffort: boolean
  supportsTemperature: boolean
}

// Model IDs verified against vendor docs 2026-11-10. Anthropic 5.x REJECTS temperature
// (must be omitted) and IGNORES reasoning_effort — enforced via supportsTemperature/supportsEffort.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    label: 'Gemini 3.8 Flash',
    vendor: 'google',
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    badge: 'recommended',
    effort: 'medium',
    supportsEffort: true,
    supportsTemperature: true
  },
  {
    label: 'GPT-6.1 Terra',
    vendor: 'openai',
    model: 'gpt-6.1-terra',
    baseUrl: 'https://api.openai.com/v1',
    badge: 'fast',
    effort: 'low',
    supportsEffort: true,
    supportsTemperature: true
  },
  {
    label: 'Claude Haiku 5.5',
    vendor: 'anthropic',
    model: 'claude-haiku-5-5',
    baseUrl: 'https://api.anthropic.com/v1/',
    badge: 'fast',
    effort: 'default',
    supportsEffort: false,
    supportsTemperature: false
  },
  {
    label: 'Claude Sonnet 5.5',
    vendor: 'anthropic',
    model: 'claude-sonnet-5-5',
    baseUrl: 'https://api.anthropic.com/v1/',
    badge: 'fast',
    effort: 'default',
    supportsEffort: false,
    supportsTemperature: false
  },
  {
    label: 'Gemini 3.5 Flash-Lite',
    vendor: 'google',
    model: 'gemini-3.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    badge: 'fast',
    effort: 'low',
    supportsEffort: true,
    supportsTemperature: true
  },
  {
    label: 'GPT-6.1 Sol',
    vendor: 'openai',
    model: 'gpt-6.1-sol',
    baseUrl: 'https://api.openai.com/v1',
    badge: 'slow',
    effort: 'high',
    supportsEffort: true,
    supportsTemperature: true
  },
  {
    label: 'Claude Fable 5.2',
    vendor: 'anthropic',
    model: 'claude-fable-5-2',
    baseUrl: 'https://api.anthropic.com/v1/',
    badge: 'very-slow',
    effort: 'default',
    supportsEffort: false,
    supportsTemperature: false
  }
]

export interface LlmConfig {
  /** Legacy single-model fields: kept as the migration fallback for older config files. */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  reasoningEffort: 'low' | 'medium' | 'high'
  autoEscalate: boolean
  vision: boolean
  profiles: ModelProfile[]
  activeProfileId: string
}

export interface AsrConfig {
  mode: AsrMode
  url: string
  apiKey: string
  model: string
}

export interface InteractionConfig {
  autoAnswer: boolean
  answerCooldownMs: number
  transcribeMic: boolean
  streamingPartials: boolean
  earlyAnswer: boolean
  autoScroll: boolean
}

export type AnswerLength = 'concise' | 'balanced' | 'detailed'
export type AnswerFormat = 'bullets' | 'balanced' | 'paragraph'
export type AnswerTone = 'formal' | 'casual' | 'simple'

export type QuestionType =
  | 'auto'
  | 'behavioral'
  | 'coding'
  | 'system-design'
  | 'experience'
  | 'technical'
  | 'other'

/** Concrete type chosen for one ask ('auto' is resolved before sending). */
export type ResolvedQuestionType = Exclude<QuestionType, 'auto'>

export interface AnswerStyle {
  length: AnswerLength
  format: AnswerFormat
  tone: AnswerTone
  star: boolean
  fillerWords: boolean
  codeLanguage: 'python' | 'javascript' | 'java' | 'cpp'
  questionType: QuestionType
}

export interface ProfileContext {
  resume: string
  background: string
  /** Comma/newline-separated names and acronyms for the speech prompt. */
  vocabulary: string
}

export interface SessionContext {
  title: string
  company: string
  jobDescription: string
  extraContext: string
}

export interface WindowConfig {
  screenMode: 'primary' | 'cursor'
  x: number | null
  y: number | null
  width: number | null
  height: number | null
}

export interface UpdatesConfig {
  enabled: boolean
  feedUrl: string
}

export interface MeetingsConfig {
  detect: boolean
  autoStart: boolean
  /**
   * Show a tray balloon when a meeting/background app is detected. Off by
   * default: OS balloons render on the shared screen.
   */
  balloon: boolean
}

export interface CaptureRegion {
  /** Origin/size in captured-image pixels for the overlay's display. */
  x: number
  y: number
  w: number
  h: number
  /** Region is bound to one display; a move to another falls back to full screen. */
  displayId: number
  /** Captured frame size when the region was set; a DPI/resolution change falls back. */
  frameW: number
  frameH: number
}

export interface CaptureConfig {
  region: CaptureRegion | null
}

export interface AudioConfig {
  /**
   * Frame capture samples on the audio thread with an AudioWorklet (default).
   * false forces the legacy ScriptProcessorNode path — an escape hatch only;
   * the engine also falls back automatically when the module fails to load.
   */
  useWorklet: boolean
}

export interface AppConfig {
  privateMode: boolean
  clickThrough: boolean
  panelOpacity: number
  llm: LlmConfig
  asr: AsrConfig
  interaction: InteractionConfig
  answer: AnswerStyle
  profile: ProfileContext
  session: SessionContext
  window: WindowConfig
  updates: UpdatesConfig
  meetings: MeetingsConfig
  capture: CaptureConfig
  audio: AudioConfig
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  id: string
  messages: ChatMessage[]
  images: string[]
  vision: boolean
  /** Resolved question type for this ask; 'coding' may escalate effort. */
  questionType?: QuestionType
}

export interface CaptureTestCheck {
  id: string
  label: string
  /** true = pass, false = fail, null = skipped/unknown */
  pass: boolean | null
  detail: string
}

export interface CaptureTestReport {
  checks: CaptureTestCheck[]
  ranAt: number
}

export interface HotkeyInfo {
  accelerator: string
  description: string
  registered: boolean
}
