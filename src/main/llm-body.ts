import { MODEL_CATALOG } from '../shared/types'
import type {
  AnswerStyle,
  ChatMessage,
  LlmConfig,
  ModelProfile,
  WindowConfig
} from '../shared/types'

// Pure model-profile / request-body layer extracted from main/index.ts.
// No Electron imports: the callers pass the config default as a parameter where
// the original code closed over DEFAULT_CONFIG.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function clampTemperature(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.2
}

export function clampMaxTokens(value: number): number {
  return Number.isFinite(value) ? Math.min(8192, Math.max(128, Math.round(value))) : 4096
}

// Never send 'minimal' (errors on current Flash models) or 'none' (unsupported on Gemini 3.x/4.x).
export function clampReasoningEffort(
  value: LlmConfig['reasoningEffort']
): 'low' | 'medium' | 'high' {
  return value === 'medium' || value === 'high' ? value : 'low'
}

export const ANSWER_COOLDOWN_MIN_MS = 1000
export const ANSWER_COOLDOWN_MAX_MS = 30_000
export const ANSWER_COOLDOWN_DEFAULT_MS = 5000

// A hand-edited/out-of-range cooldown would hammer the LLM endpoint (or stall
// auto-answer); the settings input uses the same 1000–30000 bounds.
export function clampAnswerCooldown(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ANSWER_COOLDOWN_DEFAULT_MS
  return Math.min(ANSWER_COOLDOWN_MAX_MS, Math.max(ANSWER_COOLDOWN_MIN_MS, Math.round(value)))
}

// Hand-edited window bounds may be strings or garbage; setBounds() throws on a
// non-finite value, so persist only real numbers (null = use the default size).
export function coerceWindowBounds(raw: unknown, base: WindowConfig): WindowConfig {
  if (!isPlainObject(raw)) return { ...base }
  const num = (value: unknown): number | null => {
    if (typeof value === 'string' && value.trim() === '') return null
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    screenMode: raw.screenMode === 'cursor' ? 'cursor' : 'primary',
    x: num(raw.x),
    y: num(raw.y),
    width: num(raw.width),
    height: num(raw.height)
  }
}

// Pre-v1.2 configs had one flat model config; wrap it so nothing is lost.
export function legacyProfile(llm: LlmConfig): ModelProfile {
  return {
    id: 'default',
    label: 'My model',
    badge: 'recommended',
    baseUrl: typeof llm.baseUrl === 'string' ? llm.baseUrl : '',
    apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : '',
    model: typeof llm.model === 'string' ? llm.model : '',
    temperature:
      typeof llm.temperature === 'number' && Number.isFinite(llm.temperature)
        ? llm.temperature
        : null,
    maxTokens:
      typeof llm.maxTokens === 'number' && Number.isFinite(llm.maxTokens) ? llm.maxTokens : null,
    effort:
      llm.reasoningEffort === 'medium' || llm.reasoningEffort === 'high'
        ? llm.reasoningEffort
        : 'low',
    escalateOnCode: llm.autoEscalate === true
  }
}

// Config files are user-editable JSON, so coerce each persisted profile instead
// of trusting its shape.
export function coerceProfile(
  raw: unknown,
  index: number,
  fallback: ModelProfile
): ModelProfile {
  if (!isPlainObject(raw)) return { ...fallback, id: `profile-${index}` }
  const str = (value: unknown, def: string): string => (typeof value === 'string' ? value : def)
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const effort = raw.effort
  const badge = raw.badge
  return {
    id: str(raw.id, `profile-${index}`),
    label: str(raw.label, `Model ${index + 1}`),
    badge:
      badge === 'fast' || badge === 'slow' || badge === 'very-slow' ? badge : 'recommended',
    baseUrl: str(raw.baseUrl, fallback.baseUrl),
    apiKey: str(raw.apiKey, ''),
    model: str(raw.model, fallback.model),
    temperature: num(raw.temperature),
    maxTokens: num(raw.maxTokens),
    effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'default',
    escalateOnCode: raw.escalateOnCode === true
  }
}

// Guarantees at least one profile and a valid active id, even from a hand-edited
// or partially migrated config. `defaults` replaces the DEFAULT_CONFIG.llm the
// original closure referenced.
export function normalizeLlm(llm: LlmConfig, defaults: LlmConfig): LlmConfig {
  if (!isPlainObject(llm)) return normalizeLlm(defaults, defaults)
  const legacy = legacyProfile(llm)
  const rawProfiles = Array.isArray(llm.profiles) ? llm.profiles : []
  const profiles = rawProfiles.map((profile, index) => coerceProfile(profile, index, legacy))
  if (profiles.length === 0) profiles.push(legacy)
  const seen = new Set<string>()
  for (const profile of profiles) {
    if (seen.has(profile.id)) {
      // Skip ids that already exist too (e.g. ["a", "a-2", "a"]).
      let n = 1
      let candidate = `${profile.id}-${n}`
      while (seen.has(candidate)) candidate = `${profile.id}-${++n}`
      profile.id = candidate
    }
    seen.add(profile.id)
  }
  const activeProfileId = profiles.some((profile) => profile.id === llm.activeProfileId)
    ? llm.activeProfileId
    : profiles[0].id
  return { ...llm, profiles, activeProfileId }
}

const QUESTION_TYPES = new Set([
  'auto',
  'behavioral',
  'coding',
  'system-design',
  'experience',
  'technical',
  'other'
])

export function normalizeAnswer(answer: AnswerStyle, fallback: AnswerStyle): AnswerStyle {
  if (!isPlainObject(answer)) return { ...fallback }
  return QUESTION_TYPES.has(answer.questionType as string)
    ? answer
    : { ...answer, questionType: 'auto' }
}

export function activeProfile(llm: LlmConfig): ModelProfile {
  return (
    llm.profiles.find((profile) => profile.id === llm.activeProfileId) ??
    llm.profiles[0] ??
    legacyProfile(llm)
  )
}

export interface VendorRules {
  temperature: boolean
  effort: boolean
}

// The catalog is the single source of vendor quirks. Unknown/custom models stay
// permissive unless they point at Anthropic's endpoint, where Claude 5.x still
// rejects temperature and ignores reasoning_effort.
export function vendorRulesFor(profile: ModelProfile): VendorRules {
  const entry = MODEL_CATALOG.find((item) => item.model === profile.model)
  if (profile.baseUrl.toLowerCase().includes('anthropic.com') || entry?.vendor === 'anthropic') {
    return { temperature: false, effort: false }
  }
  return {
    temperature: entry ? entry.supportsTemperature : true,
    effort: entry ? entry.supportsEffort : true
  }
}

// Escalation only ever raises low → high, and never when effort is omitted.
export function effectiveEffort(
  profile: ModelProfile,
  escalate: boolean
): 'low' | 'medium' | 'high' | null {
  if (profile.effort === 'default') return null
  const configured = clampReasoningEffort(profile.effort)
  return escalate && configured === 'low' ? 'high' : configured
}

export function chatBody(
  profile: ModelProfile,
  messages: unknown[],
  opts: { stream: boolean; escalate: boolean }
): Record<string, unknown> {
  const rules = vendorRulesFor(profile)
  const body: Record<string, unknown> = {
    model: profile.model,
    stream: opts.stream,
    messages
  }
  // null means "let the vendor choose" — omit the key instead of picking one.
  if (profile.temperature != null && rules.temperature) {
    body.temperature = clampTemperature(profile.temperature)
  }
  if (profile.maxTokens != null) body.max_tokens = clampMaxTokens(profile.maxTokens)
  const effort = effectiveEffort(profile, opts.escalate)
  if (effort && rules.effort) body.reasoning_effort = effort
  return body
}

export type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** OpenAI chat content: plain text, or multimodal parts for the latest turn. */
export type ChatMessageContent = string | ChatMessagePart[]

export interface OpenAiChatMessage {
  role: ChatMessage['role']
  content: ChatMessageContent
}

export interface BuildChatMessagesInput {
  /** Rendered system prompt; always emitted first. */
  systemPrompt: string
  /** Earlier assistant turns, kept in order between system and the new user turn. */
  priorTurns?: ChatMessage[]
  /** Text of the latest user turn; omitted only when the request has no user turn. */
  question?: string
  /** Screenshot data URLs for the latest turn only. */
  images?: string[]
  /** Images are only sent when the active profile advertises vision support. */
  vision?: boolean
}

// Pure assembly of the OpenAI messages array. The multimodal form replaces the
// text of the latest user turn with `[text, ...images]`; older turns and the
// system prompt stay plain. Callers pass `question` from the turn that was the
// last one before this replacement.
export function buildChatMessages({
  systemPrompt,
  priorTurns = [],
  question,
  images = [],
  vision = false
}: BuildChatMessagesInput): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...priorTurns.map((turn) => ({ role: turn.role, content: turn.content }))
  ]
  if (question === undefined) return messages
  const content: ChatMessageContent =
    vision && images.length > 0
      ? [
          { type: 'text', text: question },
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
        ]
      : question
  messages.push({ role: 'user', content })
  return messages
}
