// Pure Whisper initial_prompt builder extracted from App.tsx.
// OpenAI whisper-1's prompt limit is 224 tokens; 700 chars is safe headroom.
export const WHISPER_PROMPT_BUDGET = 700

export function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export interface WhisperPromptInput {
  company?: string | null
  vocabulary?: string | null
  carry?: string | null
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

// Company + vocabulary first, then the recent transcript carry-over in the
// remaining budget.
export function buildWhisperPrompt({ company, vocabulary, carry }: WhisperPromptInput): string {
  const companyText = normalize(company)
  const vocabularyText = normalize(vocabulary)
  const prefix = [
    companyText && `Company: ${companyText}.`,
    vocabularyText && `Terms: ${vocabularyText}.`
  ]
    .filter(Boolean)
    .join(' ')
  const carryOver = carry ?? ''
  if (!prefix) return carryOver
  const budget = WHISPER_PROMPT_BUDGET
  const clipped = prefix.slice(0, budget)
  const room = Math.max(0, budget - clipped.length - 1)
  return `${clipped}${room > 0 && carryOver ? ` ${carryOver.slice(-room)}` : ''}`.slice(0, budget)
}
