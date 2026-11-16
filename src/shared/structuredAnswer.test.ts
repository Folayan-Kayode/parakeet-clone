import { describe, expect, it } from 'vitest'
import {
  parseStructuredAnswerText,
  structuredAnswerMarkdown,
  type StructuredAnswer
} from './structuredAnswer'

describe('parseStructuredAnswerText', () => {
  it('parses a fenced JSON answer', () => {
    const text = [
      '```json',
      '{',
      '  "approach": "Use a hash map",',
      '  "key_steps": ["Build the map", "Look up each value"],',
      '  "code": { "language": "python", "source": "def f(x):\\n    return x" },',
      '  "complexity": { "time": "O(n)", "space": "O(n)" }',
      '}',
      '```'
    ].join('\n')

    expect(parseStructuredAnswerText(text)).toEqual({
      approach: 'Use a hash map',
      keySteps: ['Build the map', 'Look up each value'],
      code: { language: 'python', source: 'def f(x):\n    return x' },
      complexity: { time: 'O(n)', space: 'O(n)' }
    })
  })

  it('parses JSON wrapped in prose', () => {
    const text = [
      'Sure! Here is the answer:',
      '',
      '{"approach":"Binary search","key_steps":[],"code":{"language":"","source":""},"complexity":{"time":"O(log n)","space":"O(1)"}}',
      '',
      'Hope that helps.'
    ].join('\n')

    const parsed = parseStructuredAnswerText(text)
    expect(parsed?.approach).toBe('Binary search')
    expect(parsed?.complexity).toEqual({ time: 'O(log n)', space: 'O(1)' })
    expect(parsed?.keySteps).toEqual([])
  })

  it('returns null for partial or unbalanced JSON', () => {
    expect(parseStructuredAnswerText('{"approach":"x"')).toBeNull()
    expect(parseStructuredAnswerText('not json at all')).toBeNull()
    expect(parseStructuredAnswerText('')).toBeNull()
  })

  it('returns null when approach and code source are both empty', () => {
    expect(
      parseStructuredAnswerText(
        '{"approach":"   ","key_steps":["step"],"code":{"source":""},"complexity":{}}'
      )
    ).toBeNull()
  })

  it('accepts a card that only has code', () => {
    const parsed = parseStructuredAnswerText(
      '{"approach":"","key_steps":[],"code":{"language":"ts","source":"const x = 1"},"complexity":{}}'
    )
    expect(parsed).toEqual({
      approach: '',
      keySteps: [],
      code: { language: 'ts', source: 'const x = 1' },
      complexity: { time: '', space: '' }
    })
  })

  it('filters non-string, blank and whitespace-only key_steps', () => {
    const parsed = parseStructuredAnswerText(
      '{"approach":"A","key_steps":["  first  ",42,null,"", "   ",{"x":1},"second"],"code":{},"complexity":{}}'
    )
    expect(parsed?.keySteps).toEqual(['first', 'second'])
  })

  it('defaults missing code/complexity fields to empty strings', () => {
    const parsed = parseStructuredAnswerText('{"approach":"Only approach"}')
    expect(parsed).toEqual({
      approach: 'Only approach',
      keySteps: [],
      code: { language: '', source: '' },
      complexity: { time: '', space: '' }
    })
  })

  it('does not accept a bare JSON scalar', () => {
    expect(parseStructuredAnswerText('42')).toBeNull()
    expect(parseStructuredAnswerText('[]')).toBeNull()
  })
})

describe('structuredAnswerMarkdown', () => {
  it('returns the fallback when the card is null', () => {
    expect(structuredAnswerMarkdown(null, '> raw answer')).toBe('> raw answer')
  })

  it('renders approach, numbered steps and complexity', () => {
    const card: StructuredAnswer = {
      approach: 'Walk the array once.',
      keySteps: ['Init total', 'Add each item'],
      code: { language: '', source: '' },
      complexity: { time: 'O(n)', space: 'O(1)' }
    }
    expect(structuredAnswerMarkdown(card, 'fallback')).toBe(
      ['Walk the array once.', '', '1. Init total', '2. Add each item', '', '**Complexity:** time O(n) · space O(1)'].join(
        '\n'
      )
    )
  })

  it('escapes a backtick run in code with a longer fence', () => {
    const card: StructuredAnswer = {
      approach: '',
      keySteps: [],
      code: { language: 'md', source: 'a ``` fence' },
      complexity: { time: '', space: '' }
    }
    expect(structuredAnswerMarkdown(card, 'fallback')).toBe(
      ['````md', 'a ``` fence', '````'].join('\n')
    )
  })

  it('bumps a four-backtick run to a five-backtick fence', () => {
    const card: StructuredAnswer = {
      approach: '',
      keySteps: [],
      code: { language: '', source: '````' },
      complexity: { time: '', space: '' }
    }
    const rendered = structuredAnswerMarkdown(card, 'fallback')
    expect(rendered).toContain('`````')
    expect(rendered).toBe(['`````', '````', '`````'].join('\n'))
  })

  it('omits empty sections', () => {
    const card: StructuredAnswer = {
      approach: '',
      keySteps: [],
      code: { language: 'ts', source: 'const x = 1' },
      complexity: { time: '', space: 'O(1)' }
    }
    expect(structuredAnswerMarkdown(card, 'fallback')).toBe(
      ['```ts', 'const x = 1', '```', '', '**Complexity:** space O(1)'].join('\n')
    )
  })
})
