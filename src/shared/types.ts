export type AsrMode = 'whispercpp' | 'openai'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
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
}

export interface UpdatesConfig {
  enabled: boolean
  feedUrl: string
}

export interface MeetingsConfig {
  detect: boolean
  autoStart: boolean
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
