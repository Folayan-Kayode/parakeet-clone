import { parseStructuredAnswerText, structuredAnswerMarkdown } from './structuredAnswer'

// Pure Markdown assembly for sessions:export, extracted from main/index.ts so
// the rendering can be tested without touching the filesystem.

export interface SessionExportSegment {
  id?: string
  speaker?: string
  text?: string
}

export interface SessionExportAnswer {
  text?: string
  error?: string
  question?: string
  anchorId?: string
}

export interface SessionExportData {
  title?: string
  endedAt?: string
  segments?: SessionExportSegment[]
  answers?: SessionExportAnswer[]
}

export function buildSessionMarkdown(
  data: SessionExportData,
  exportedAt: string = new Date().toISOString()
): string {
  const answersByAnchor = new Map<string, string[]>()
  const loose: string[] = []
  for (const answer of data.answers ?? []) {
    const body = (answer.text || answer.error || '').trim()
    if (!body) continue
    const fallback = body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const rendered = answer.error
      ? fallback
      : structuredAnswerMarkdown(parseStructuredAnswerText(answer.text ?? ''), fallback)
    if (answer.anchorId) {
      const list = answersByAnchor.get(answer.anchorId) ?? []
      list.push(rendered)
      answersByAnchor.set(answer.anchorId, list)
    } else {
      loose.push(rendered)
    }
  }
  const lines: string[] = [`# ${data.title?.trim() || 'Session'}`, '']
  for (const segment of data.segments ?? []) {
    const speaker = segment.speaker === 'You' ? 'You' : 'Them'
    lines.push(`**${speaker}:** ${(segment.text ?? '').trim()}`, '')
    if (segment.id) {
      for (const quote of answersByAnchor.get(segment.id) ?? []) lines.push(quote, '')
      answersByAnchor.delete(segment.id)
    }
  }
  for (const list of answersByAnchor.values()) {
    for (const quote of list) lines.push(quote, '')
  }
  for (const quote of loose) lines.push(quote, '')
  lines.push(
    '---',
    `Exported from Parakeet Clone — ${data.endedAt ?? exportedAt}`,
    ''
  )
  return lines.join('\n')
}
