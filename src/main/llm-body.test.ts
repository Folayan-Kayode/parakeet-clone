import { describe, expect, it } from 'vitest'
import type {
  AnswerStyle,
  ChatMessage,
  EffortSetting,
  LlmConfig,
  ModelProfile,
  WindowConfig
} from '../shared/types'
import {
  activeProfile,
  buildChatMessages,
  chatBody,
  clampAnswerCooldown,
  clampMaxTokens,
  clampReasoningEffort,
  clampTemperature,
  computeResponseDeadlineMs,
  coerceWindowBounds,
  decomposeMessages,
  effectiveEffort,
  legacyProfile,
  normalizeAnswer,
  normalizeLlm,
  vendorRulesFor
} from './llm-body'

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p1',
    label: 'Profile 1',
    badge: 'recommended',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-6.1-terra',
    temperature: 0.2,
    maxTokens: 4096,
    effort: 'low',
    escalateOnCode: false,
    ...overrides
  }
}

const defaultLlm: LlmConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen2.5vl:7b',
  temperature: 0.2,
  maxTokens: 4096,
  reasoningEffort: 'low',
  autoEscalate: false,
  vision: false,
  profiles: [],
  activeProfileId: ''
}

const defaultWindow: WindowConfig = {
  screenMode: 'primary',
  x: null,
  y: null,
  width: null,
  height: null
}

const defaultAnswer: AnswerStyle = {
  length: 'balanced',
  format: 'balanced',
  tone: 'formal',
  star: false,
  fillerWords: false,
  codeLanguage: 'python',
  questionType: 'auto'
}

describe('clampTemperature', () => {
  it('clamps to 0–1 and falls back for non-finite input', () => {
    expect(clampTemperature(0.5)).toBe(0.5)
    expect(clampTemperature(-1)).toBe(0)
    expect(clampTemperature(0)).toBe(0)
    expect(clampTemperature(2)).toBe(1)
    expect(clampTemperature(Number.NaN)).toBe(0.2)
    expect(clampTemperature(Number.POSITIVE_INFINITY)).toBe(0.2)
  })
})

describe('clampMaxTokens', () => {
  it('clamps to 128–8192, rounds and falls back for non-finite input', () => {
    expect(clampMaxTokens(4096)).toBe(4096)
    expect(clampMaxTokens(0)).toBe(128)
    expect(clampMaxTokens(100)).toBe(128)
    expect(clampMaxTokens(99999)).toBe(8192)
    expect(clampMaxTokens(1000.6)).toBe(1001)
    expect(clampMaxTokens(Number.NaN)).toBe(4096)
    expect(clampMaxTokens(Number.POSITIVE_INFINITY)).toBe(4096)
  })
})

describe('clampReasoningEffort', () => {
  it('only allows low/medium/high, mapping everything else to low', () => {
    expect(clampReasoningEffort('low')).toBe('low')
    expect(clampReasoningEffort('medium')).toBe('medium')
    expect(clampReasoningEffort('high')).toBe('high')
    // Out-of-contract values that can still arrive from hand-edited JSON.
    expect(clampReasoningEffort('minimal' as unknown as LlmConfig['reasoningEffort'])).toBe('low')
    expect(clampReasoningEffort('none' as unknown as LlmConfig['reasoningEffort'])).toBe('low')
  })
})

describe('effectiveEffort', () => {
  it('omits effort entirely for default', () => {
    expect(effectiveEffort(profile({ effort: 'default' }), false)).toBeNull()
    expect(effectiveEffort(profile({ effort: 'default' }), true)).toBeNull()
  })

  it('escalates only from low to high', () => {
    expect(effectiveEffort(profile({ effort: 'low' }), true)).toBe('high')
    expect(effectiveEffort(profile({ effort: 'low' }), false)).toBe('low')
    expect(effectiveEffort(profile({ effort: 'medium' }), true)).toBe('medium')
    expect(effectiveEffort(profile({ effort: 'medium' }), false)).toBe('medium')
    expect(effectiveEffort(profile({ effort: 'high' }), false)).toBe('high')
    expect(effectiveEffort(profile({ effort: 'high' }), true)).toBe('high')
  })

  it('coerces unknown efforts to low before escalating', () => {
    const unknown = profile({ effort: 'none' as unknown as EffortSetting })
    expect(effectiveEffort(unknown, false)).toBe('low')
    expect(effectiveEffort(unknown, true)).toBe('high')
  })
})

describe('vendorRulesFor', () => {
  it('disables temperature and effort for catalog Anthropic models', () => {
    expect(
      vendorRulesFor(
        profile({ model: 'claude-haiku-5-5', baseUrl: 'https://api.anthropic.com/v1/' })
      )
    ).toEqual({ temperature: false, effort: false })
  })

  it('disables both for any model pointed at the Anthropic endpoint', () => {
    expect(
      vendorRulesFor(
        profile({ model: 'custom-claude', baseUrl: 'https://API.Anthropic.com/v1' })
      )
    ).toEqual({ temperature: false, effort: false })
  })

  it('follows catalog flags for known non-Anthropic models', () => {
    expect(vendorRulesFor(profile({ model: 'gemini-3.8-flash' }))).toEqual({
      temperature: true,
      effort: true
    })
    expect(vendorRulesFor(profile({ model: 'gpt-6.1-sol' }))).toEqual({
      temperature: true,
      effort: true
    })
  })

  it('stays permissive for unknown custom models', () => {
    expect(
      vendorRulesFor(profile({ model: 'my-local-model', baseUrl: 'http://127.0.0.1:1234/v1' }))
    ).toEqual({ temperature: true, effort: true })
  })
})

describe('chatBody', () => {
  const messages = [{ role: 'user', content: 'hi' }]

  it('omits null temperature, null max_tokens and default effort', () => {
    const body = chatBody(
      profile({ temperature: null, maxTokens: null, effort: 'default' }),
      messages,
      { stream: true, escalate: false }
    )
    expect(body).toEqual({ model: 'gpt-6.1-terra', stream: true, messages })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('emits clamped temperature, max_tokens and effort', () => {
    const body = chatBody(profile({ temperature: 2, maxTokens: 100, effort: 'low' }), messages, {
      stream: true,
      escalate: false
    })
    expect(body.temperature).toBe(1)
    expect(body.max_tokens).toBe(128)
    expect(body.reasoning_effort).toBe('low')
    expect(body.stream).toBe(true)
    expect(body.messages).toBe(messages)
  })

  it('escalates low effort to high on code asks', () => {
    const body = chatBody(profile({ effort: 'low' }), messages, {
      stream: true,
      escalate: true
    })
    expect(body.reasoning_effort).toBe('high')
  })

  it('does not escalate medium or high effort', () => {
    expect(
      chatBody(profile({ effort: 'medium' }), messages, { stream: true, escalate: true })
        .reasoning_effort
    ).toBe('medium')
    expect(
      chatBody(profile({ effort: 'high' }), messages, { stream: true, escalate: true })
        .reasoning_effort
    ).toBe('high')
  })

  it('omits both temperature and reasoning_effort for Anthropic by model', () => {
    const body = chatBody(
      profile({
        model: 'claude-haiku-5-5',
        baseUrl: 'https://api.anthropic.com/v1/',
        temperature: 0.5,
        effort: 'high',
        maxTokens: 1000
      }),
      messages,
      { stream: false, escalate: true }
    )
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body.max_tokens).toBe(1000)
    expect(body.stream).toBe(false)
  })

  it('omits both for Anthropic by baseUrl', () => {
    const body = chatBody(
      profile({
        model: 'custom-claude',
        baseUrl: 'https://API.Anthropic.com/v1',
        temperature: 0.5,
        effort: 'high'
      }),
      messages,
      { stream: true, escalate: true }
    )
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('still omits the effort field when effort is default on Anthropic', () => {
    const body = chatBody(
      profile({
        model: 'claude-sonnet-5-5',
        baseUrl: 'https://api.anthropic.com/v1/',
        effort: 'default'
      }),
      messages,
      { stream: true, escalate: false }
    )
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})

describe('legacyProfile', () => {
  it('wraps flat legacy fields without losing anything', () => {
    expect(
      legacyProfile({
        ...defaultLlm,
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk-test',
        model: 'gemini-4-argon',
        temperature: 0.7,
        maxTokens: 4096,
        reasoningEffort: 'high',
        autoEscalate: true
      })
    ).toEqual({
      id: 'default',
      label: 'My model',
      badge: 'recommended',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'gemini-4-argon',
      temperature: 0.7,
      maxTokens: 4096,
      effort: 'high',
      escalateOnCode: true
    })
  })

  it('nulls non-finite temperature/maxTokens and coerces unknown effort', () => {
    const legacy = legacyProfile({
      ...defaultLlm,
      temperature: Number.NaN,
      maxTokens: Number.POSITIVE_INFINITY,
      reasoningEffort: 'minimal' as unknown as LlmConfig['reasoningEffort'],
      autoEscalate: false
    })
    expect(legacy.temperature).toBeNull()
    expect(legacy.maxTokens).toBeNull()
    expect(legacy.effort).toBe('low')
    expect(legacy.escalateOnCode).toBe(false)
  })
})

describe('normalizeLlm', () => {
  it('migrates a pre-v1.2 flat config into one intact profile', () => {
    const llm: LlmConfig = {
      ...defaultLlm,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'key',
      model: 'gemini-4-argon',
      temperature: 0.35,
      maxTokens: 4096,
      reasoningEffort: 'high',
      autoEscalate: true,
      profiles: [],
      activeProfileId: ''
    }
    const out = normalizeLlm(llm, defaultLlm)
    expect(out.profiles).toHaveLength(1)
    expect(out.profiles[0]).toEqual({
      id: 'default',
      label: 'My model',
      badge: 'recommended',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'key',
      model: 'gemini-4-argon',
      temperature: 0.35,
      maxTokens: 4096,
      effort: 'high',
      escalateOnCode: true
    })
    expect(out.activeProfileId).toBe('default')
  })

  it('repairs duplicate ids, skipping ids that already exist', () => {
    const llm: LlmConfig = {
      ...defaultLlm,
      profiles: [profile({ id: 'a' }), profile({ id: 'a-2' }), profile({ id: 'a' })],
      activeProfileId: 'a'
    }
    const out = normalizeLlm(llm, defaultLlm)
    expect(out.profiles.map((p) => p.id)).toEqual(['a', 'a-2', 'a-1'])
    expect(out.activeProfileId).toBe('a')
  })

  it('repairs a duplicate when the suffix id is already taken', () => {
    const llm: LlmConfig = {
      ...defaultLlm,
      profiles: [profile({ id: 'a' }), profile({ id: 'a-1' }), profile({ id: 'a' })],
      activeProfileId: 'a'
    }
    expect(normalizeLlm(llm, defaultLlm).profiles.map((p) => p.id)).toEqual([
      'a',
      'a-1',
      'a-2'
    ])
  })

  it('repairs a missing active profile id to the first profile', () => {
    const llm: LlmConfig = {
      ...defaultLlm,
      profiles: [profile({ id: 'first' }), profile({ id: 'second' })],
      activeProfileId: 'missing'
    }
    expect(normalizeLlm(llm, defaultLlm).activeProfileId).toBe('first')
  })

  it('coerces hand-edited garbage profile fields', () => {
    const garbage = {
      id: 7,
      label: null,
      badge: 'nope',
      baseUrl: 1,
      apiKey: ['x'],
      model: {},
      temperature: 'hot',
      maxTokens: Number.NaN,
      effort: 'none',
      escalateOnCode: 'yes'
    }
    const llm = {
      ...defaultLlm,
      profiles: [garbage as unknown as ModelProfile],
      activeProfileId: 'nope'
    }
    const out = normalizeLlm(llm, defaultLlm)
    expect(out.profiles[0]).toEqual({
      id: 'profile-0',
      label: 'Model 1',
      badge: 'recommended',
      baseUrl: defaultLlm.baseUrl,
      apiKey: '',
      model: defaultLlm.model,
      temperature: null,
      maxTokens: null,
      effort: 'default',
      escalateOnCode: false
    })
    expect(out.activeProfileId).toBe('profile-0')
  })

  it('replaces a non-array profiles field with the legacy profile', () => {
    const llm = {
      ...defaultLlm,
      profiles: 'nope' as unknown as ModelProfile[]
    }
    const out = normalizeLlm(llm, defaultLlm)
    expect(out.profiles).toHaveLength(1)
    expect(out.profiles[0].id).toBe('default')
    expect(out.activeProfileId).toBe('default')
  })

  it('falls back to the provided defaults when llm is not an object', () => {
    const out = normalizeLlm(null as unknown as LlmConfig, defaultLlm)
    expect(out.profiles).toHaveLength(1)
    expect(out.profiles[0]).toEqual(legacyProfile(defaultLlm))
    expect(out.activeProfileId).toBe('default')
  })
})

describe('normalizeAnswer', () => {
  it('keeps a valid question type', () => {
    const answer = { ...defaultAnswer, questionType: 'coding' as const }
    expect(normalizeAnswer(answer, defaultAnswer)).toBe(answer)
  })

  it('resets an invalid question type to auto', () => {
    const answer = {
      ...defaultAnswer,
      questionType: 'nonsense' as unknown as AnswerStyle['questionType']
    }
    expect(normalizeAnswer(answer, defaultAnswer)).toEqual({
      ...defaultAnswer,
      questionType: 'auto'
    })
  })

  it('returns a copy of the fallback for non-object input', () => {
    const out = normalizeAnswer(null as unknown as AnswerStyle, defaultAnswer)
    expect(out).toEqual(defaultAnswer)
    expect(out).not.toBe(defaultAnswer)
  })
})

describe('coerceWindowBounds', () => {
  it('coerces numeric strings and rejects garbage', () => {
    expect(
      coerceWindowBounds(
        { screenMode: 'cursor', x: '800', y: '100.5', width: '', height: 'abc' },
        defaultWindow
      )
    ).toEqual({ screenMode: 'cursor', x: 800, y: 100.5, width: null, height: null })
  })

  it('trims string numbers and rejects non-finite values', () => {
    expect(coerceWindowBounds({ width: ' 1200 ', height: Number.POSITIVE_INFINITY }, defaultWindow))
      .toEqual({ ...defaultWindow, width: 1200, height: null })
  })

  it('falls back to the provided defaults for non-object input', () => {
    expect(coerceWindowBounds(null, defaultWindow)).toEqual(defaultWindow)
  })

  it('defaults an unknown screenMode to primary', () => {
    expect(coerceWindowBounds({ screenMode: 'weird' }, defaultWindow).screenMode).toBe('primary')
  })
})

describe('clampAnswerCooldown', () => {
  it('clamps valid numbers into 1000–30000 ms', () => {
    expect(clampAnswerCooldown(50)).toBe(1000)
    expect(clampAnswerCooldown(999999)).toBe(30000)
    expect(clampAnswerCooldown(5000)).toBe(5000)
    expect(clampAnswerCooldown(1000)).toBe(1000)
    expect(clampAnswerCooldown(30000)).toBe(30000)
    expect(clampAnswerCooldown(1000.4)).toBe(1000)
    expect(clampAnswerCooldown(29999.6)).toBe(30000)
  })

  it('falls back to 5000 for non-numeric or non-finite input', () => {
    expect(clampAnswerCooldown(Number.NaN)).toBe(5000)
    expect(clampAnswerCooldown(Number.POSITIVE_INFINITY)).toBe(5000)
    expect(clampAnswerCooldown('5000')).toBe(5000)
    expect(clampAnswerCooldown(null)).toBe(5000)
    expect(clampAnswerCooldown(undefined)).toBe(5000)
  })
})

describe('computeResponseDeadlineMs', () => {
  it('scales 60s base by 5s per image, capped at 120s', () => {
    expect(computeResponseDeadlineMs(0)).toBe(60_000)
    expect(computeResponseDeadlineMs(1)).toBe(65_000)
    expect(computeResponseDeadlineMs(6)).toBe(90_000)
    expect(computeResponseDeadlineMs(12)).toBe(120_000)
    expect(computeResponseDeadlineMs(20)).toBe(120_000)
  })
})

describe('activeProfile', () => {
  it('resolves the active id, then falls back to the first profile, then legacy', () => {
    const a = profile({ id: 'a' })
    const b = profile({ id: 'b' })
    expect(activeProfile({ ...defaultLlm, profiles: [a, b], activeProfileId: 'b' })).toBe(b)
    expect(activeProfile({ ...defaultLlm, profiles: [a, b], activeProfileId: 'missing' })).toBe(a)
    expect(activeProfile({ ...defaultLlm, profiles: [], activeProfileId: '' })).toEqual(
      legacyProfile(defaultLlm)
    )
  })
})

describe('buildChatMessages', () => {
  const systemPrompt = 'You are the copilot.'
  const assistant: ChatMessage = { role: 'assistant', content: 'Earlier answer' }
  const question = 'Tell me about a hard bug.'

  it('emits system first and a plain-text user turn when there are no images', () => {
    const messages = buildChatMessages({ systemPrompt, question, images: [], vision: true })
    expect(messages).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ])
    expect(typeof messages[1].content).toBe('string')
  })

  it('keeps prior assistant turns in order between system and the new user turn', () => {
    const first: ChatMessage = { role: 'assistant', content: 'first' }
    const second: ChatMessage = { role: 'assistant', content: 'second' }
    expect(
      buildChatMessages({
        systemPrompt,
        priorTurns: [first, second],
        question,
        images: []
      })
    ).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: question }
    ])
  })

  it('attaches image parts to the latest user turn only when vision is on', () => {
    const images = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']
    const messages = buildChatMessages({
      systemPrompt,
      priorTurns: [assistant],
      question,
      images,
      vision: true
    })
    expect(messages).toHaveLength(3)
    // System and earlier turns stay plain text.
    expect(messages[0]).toEqual({ role: 'system', content: systemPrompt })
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Earlier answer' })
    // Text part first, then every image as image_url, in order.
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: images[0] } },
        { type: 'image_url', image_url: { url: images[1] } }
      ]
    })
  })

  it('omits image parts when vision is off even if images were passed', () => {
    const messages = buildChatMessages({
      systemPrompt,
      question,
      images: ['data:image/jpeg;base64,AAA'],
      vision: false
    })
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: question })
  })

  it('omits the parts array when vision is on but there are no images', () => {
    const messages = buildChatMessages({ systemPrompt, question, images: [], vision: true })
    expect(Array.isArray(messages[messages.length - 1].content)).toBe(false)
  })

  it('emits only the system turn when there is no user question', () => {
    expect(buildChatMessages({ systemPrompt, images: [], vision: true })).toEqual([
      { role: 'system', content: systemPrompt }
    ])
  })
})

describe('decomposeMessages', () => {
  const system: ChatMessage = { role: 'system', content: 'You are the copilot.' }
  const first: ChatMessage = { role: 'assistant', content: 'first' }
  const second: ChatMessage = { role: 'assistant', content: 'second' }
  const user: ChatMessage = { role: 'user', content: 'Tell me about a hard bug.' }

  it('splits [system, ...assistants, user] into prompt, prior turns and question', () => {
    expect(decomposeMessages([system, first, second, user])).toEqual({
      systemPrompt: system.content,
      priorTurns: [first, second],
      question: user
    })
  })

  it('uses the first message as the system prompt even when it is not role=system', () => {
    expect(decomposeMessages([first, user])).toEqual({
      systemPrompt: first.content,
      priorTurns: [],
      question: user
    })
  })

  it('returns a blank system, no prior turns and a blank user placeholder for an empty array', () => {
    // The chat handler guards on messages.length, so this placeholder never
    // becomes a wire-level user turn (matching the old last?.content behavior).
    expect(decomposeMessages([])).toEqual({
      systemPrompt: '',
      priorTurns: [],
      question: { role: 'user', content: '' }
    })
  })

  it('uses a single user message as both the system prompt and the question', () => {
    expect(decomposeMessages([user])).toEqual({
      systemPrompt: user.content,
      priorTurns: [],
      question: user
    })
  })

  it('uses a lone system message as the question because it is the last message', () => {
    expect(decomposeMessages([system])).toEqual({
      systemPrompt: system.content,
      priorTurns: [],
      question: system
    })
  })

  it('has no prior turns for a system+user request', () => {
    expect(decomposeMessages([system, user])).toEqual({
      systemPrompt: system.content,
      priorTurns: [],
      question: user
    })
  })
})
