export interface StructuredAnswer {
  approach: string
  keySteps: string[]
  code: { language: string; source: string }
  complexity: { time: string; space: string }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Lenient because models sometimes wrap JSON in fences or add prose. No risky
// quote rewriting: if JSON.parse fails, the caller keeps the raw answer text.
export function parseStructuredAnswerText(text: string): StructuredAnswer | null {
  let candidate = text
    .trim()
    .replace(/^```[a-z0-9-]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  candidate = candidate.slice(start, end + 1)

  let raw: unknown
  try {
    raw = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!isPlainObject(raw)) return null

  const approach = typeof raw.approach === 'string' ? raw.approach.trim() : ''
  const stepsRaw: unknown[] = Array.isArray(raw.key_steps) ? raw.key_steps : []
  const keySteps = stepsRaw
    .filter((step): step is string => typeof step === 'string')
    .map((step) => step.trim())
    .filter(Boolean)
  const code = isPlainObject(raw.code) ? raw.code : null
  const source = typeof code?.source === 'string' ? code.source : ''
  const language = typeof code?.language === 'string' ? code.language : ''
  const complexity = isPlainObject(raw.complexity) ? raw.complexity : null
  const time = typeof complexity?.time === 'string' ? complexity.time : ''
  const space = typeof complexity?.space === 'string' ? complexity.space : ''
  if (!approach && !source) return null
  return { approach, keySteps, code: { language, source }, complexity: { time, space } }
}

function longestBacktickRun(text: string): number {
  let longest = 0
  let current = 0
  for (const char of text) {
    if (char === '`') {
      current += 1
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return longest
}

// Markdown rendering for session export; `fallback` is returned when the answer
// did not parse as the structured contract.
export function structuredAnswerMarkdown(
  card: StructuredAnswer | null,
  fallback: string
): string {
  if (!card) return fallback
  const lines: string[] = []
  if (card.approach) lines.push(card.approach, '')
  if (card.keySteps.length > 0) {
    card.keySteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
    lines.push('')
  }
  if (card.code.source) {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(card.code.source) + 1))
    lines.push(`${fence}${card.code.language}`, card.code.source, fence, '')
  }
  const complexity = [
    card.complexity.time && `time ${card.complexity.time}`,
    card.complexity.space && `space ${card.complexity.space}`
  ].filter(Boolean)
  if (complexity.length > 0) lines.push(`**Complexity:** ${complexity.join(' · ')}`, '')
  return lines.join('\n').trim()
}
