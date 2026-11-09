export type AsrMode = 'whispercpp' | 'openai'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  reasoningEffort: 'low' | 'medium' | 'high'
  autoEscalate: boolean
  vision: boolean
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

export interface AnswerStyle {
  length: AnswerLength
  format: AnswerFormat
  tone: AnswerTone
  star: boolean
  fillerWords: boolean
  codeLanguage: 'python' | 'javascript' | 'java' | 'cpp'
}

export interface ProfileContext {
  resume: string
  background: string
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
}

export interface TranscribeRequest {
  wav: ArrayBuffer
}

export interface TranscribeResult {
  text: string
}

export interface HotkeyName {
  answer: 'answer'
  screenshot: 'screenshot'
  chat: 'chat'
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
