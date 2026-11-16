// Spoken-question heuristics extracted from App.tsx.
// Pure and closure-free: the renderer uses these to decide whether a transcript
// fragment is a question, how to classify it, and whether two utterances echo
// each other.

import type { QuestionType, ResolvedQuestionType } from './types'

// Same intent as the main process CODE_RE, widened just enough for spoken questions.
const CODING_GUESS_RE =
  /\b(algorithm|complexity|optimi[sz]e|dynamic programming|data structure|binary search|recursion|two pointers|sliding window|implement|write (a|the) (function|method|program)|leetcode|array|linked list|hash ?map|stack|queue|binary tree|graph|big.?o)\b/i

const BEHAVIORAL_GUESS_RE =
  /\b(tell me about a time|describe a (situation|time|challenge)|give me an example|conflict|disagree|teamwork|worked (with|on a team)|challenge|failure|mistake|proud of|strength|weakness|leadership|deadline|under pressure|went wrong|difficult (person|situation))\b/i

const BEHAVIORAL_OPENER_RE = /^\s*(tell me about (a time|yourself)|describe (a time|a situation))/i

export function guessQuestionType(text: string): ResolvedQuestionType {
  // A story-style opener wins even when it mentions a coding verb ("...implement a change").
  if (BEHAVIORAL_OPENER_RE.test(text)) return 'behavioral'
  if (CODING_GUESS_RE.test(text)) return 'coding'
  if (BEHAVIORAL_GUESS_RE.test(text)) return 'behavioral'
  return 'other'
}

export function resolveQuestionType(setting: QuestionType, text: string): ResolvedQuestionType {
  return setting === 'auto' ? guessQuestionType(text) : setting
}

export function similarity(a: string, b: string): number {
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

export function isQuestion(text: string): boolean {
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

export function looksCompleteQuestion(text: string): boolean {
  const t = text.trim()
  if (!t.endsWith('?')) return false
  const words = t.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w))
  return words.length >= 5
}
