import { describe, expect, it } from 'vitest'
import type { AnswerStyle } from './types'
import { buildAnswerPreview, sampleBehavioral, sampleCoding } from './answer-preview'

function style(overrides: Partial<AnswerStyle> = {}): AnswerStyle {
  return {
    length: 'balanced',
    format: 'paragraph',
    tone: 'formal',
    star: false,
    fillerWords: false,
    codeLanguage: 'python',
    questionType: 'auto',
    ...overrides
  }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

describe('sampleBehavioral', () => {
  it('grows with the length setting', () => {
    const concise = wordCount(sampleBehavioral(style({ length: 'concise' })))
    const balanced = wordCount(sampleBehavioral(style({ length: 'balanced' })))
    const detailed = wordCount(sampleBehavioral(style({ length: 'detailed' })))
    expect(concise).toBeLessThan(balanced)
    expect(balanced).toBeLessThan(detailed)
  })

  it('renders one bullet per beat for the bullets format', () => {
    const text = sampleBehavioral(style({ format: 'bullets' }))
    const lines = text.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.startsWith('• ')).toBe(true)
  })

  it('renders two paragraphs for the balanced format', () => {
    const text = sampleBehavioral(style({ format: 'balanced' }))
    expect(text).toContain('\n\n')
    expect(text.startsWith('• ')).toBe(false)
  })

  it('renders a single flowing paragraph for the paragraph format', () => {
    expect(sampleBehavioral(style({ format: 'paragraph' }))).not.toContain('\n')
  })

  it('adds the casual opener only in the casual tone', () => {
    const casual = sampleBehavioral(style({ tone: 'casual' }))
    expect(casual.startsWith('So, ')).toBe(true)
    expect(casual).toContain('you know?')
    expect(sampleBehavioral(style({ tone: 'formal' }))).not.toContain('you know?')
  })

  it('inserts a filler line when fillerWords is on and the tone is not casual', () => {
    expect(sampleBehavioral(style({ fillerWords: true, tone: 'formal' }))).toContain(
      'Honestly, that week was intense.'
    )
    expect(sampleBehavioral(style({ fillerWords: true, tone: 'simple' }))).toContain(
      'Honestly, that week was intense.'
    )
    // Casual already carries its own filler phrase; no second filler line.
    expect(sampleBehavioral(style({ fillerWords: true, tone: 'casual' }))).not.toContain(
      'Honestly, that week was intense.'
    )
    expect(sampleBehavioral(style({ fillerWords: false }))).not.toContain('Honestly')
  })

  it('swaps the technical phrase in the simple tone', () => {
    const text = sampleBehavioral(style({ tone: 'simple', length: 'detailed' }))
    expect(text).toContain('checked where the time went')
    expect(text).not.toContain('profiled the hot path')
  })

  it('adds the Result beat only when STAR is on', () => {
    expect(sampleBehavioral(style({ star: true, length: 'balanced' }))).toContain(
      'As a result, p95 fell'
    )
    expect(sampleBehavioral(style({ star: false, length: 'balanced' }))).not.toContain(
      'As a result'
    )
  })

  it('keeps the closing lesson beat in the detailed output', () => {
    expect(sampleBehavioral(style({ star: true, length: 'detailed' }))).toContain(
      'The lesson was'
    )
  })
})

describe('sampleCoding', () => {
  it('always closes with the complexity line and separates blocks', () => {
    const text = sampleCoding(style())
    expect(text).toContain('\n\n')
    expect(text).toContain('Time complexity: O(n). Space complexity: O(n).')
  })

  it('prints the code for the configured language', () => {
    const markers: Array<[AnswerStyle['codeLanguage'], string]> = [
      ['python', 'def two_sum'],
      ['javascript', 'function twoSum'],
      ['java', 'int[] twoSum'],
      ['cpp', 'vector<int> twoSum']
    ]
    for (const [codeLanguage, marker] of markers) {
      expect(sampleCoding(style({ codeLanguage }))).toContain(marker)
    }
  })

  it('keeps steps on one line for the paragraph format', () => {
    const text = sampleCoding(style({ format: 'paragraph' }))
    const between = text.slice(text.indexOf('1. '), text.indexOf('2. '))
    expect(between.length).toBeGreaterThan(0)
    expect(between).not.toContain('\n')
  })

  it('puts each step on its own line for bullets and balanced formats', () => {
    for (const format of ['bullets', 'balanced'] as const) {
      const text = sampleCoding(style({ format }))
      expect(text).toContain('\n2. ')
      expect(text).toContain('\n4. ')
    }
  })

  it('switches the approach sentence for the casual tone', () => {
    expect(sampleCoding(style({ tone: 'casual' })).startsWith("So, I'd scan")).toBe(true)
    expect(sampleCoding(style({ tone: 'formal' })).startsWith('I would scan')).toBe(true)
    expect(sampleCoding(style({ tone: 'simple' })).startsWith('I would scan')).toBe(true)
  })

  it('adds the filler sentence only when fillerWords is on and the tone is not formal', () => {
    expect(sampleCoding(style({ fillerWords: true, tone: 'casual' }))).toContain(
      'Honestly, that keeps it linear.'
    )
    expect(sampleCoding(style({ fillerWords: true, tone: 'simple' }))).toContain(
      'Honestly, that keeps it linear.'
    )
    expect(sampleCoding(style({ fillerWords: true, tone: 'formal' }))).not.toContain('Honestly')
    expect(sampleCoding(style({ fillerWords: false, tone: 'casual' }))).not.toContain('Honestly')
  })

  it('does not change with the length setting', () => {
    expect(sampleCoding(style({ length: 'concise' }))).toBe(sampleCoding(style({ length: 'detailed' })))
  })
})

describe('buildAnswerPreview', () => {
  it('bundles both samples for the same style draft', () => {
    const draft = style({ format: 'bullets', tone: 'casual', length: 'detailed' })
    const preview = buildAnswerPreview(draft)
    expect(preview.behavioral).toBe(sampleBehavioral(draft))
    expect(preview.coding).toBe(sampleCoding(draft))
    expect(preview.behavioral.length).toBeGreaterThan(0)
    expect(preview.coding.length).toBeGreaterThan(0)
  })
})
