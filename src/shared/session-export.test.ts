import { describe, expect, it } from 'vitest'
import { buildSessionMarkdown } from './session-export'

describe('buildSessionMarkdown', () => {
  it('renders title, segments, anchored answers, orphan answers and loose answers in order', () => {
    const markdown = buildSessionMarkdown(
      {
        title: ' Interview ',
        endedAt: '2026-01-02T03:04:05.000Z',
        segments: [
          { id: 's1', speaker: 'Them', text: ' Tell me about yourself ' },
          { id: 's2', speaker: 'You', text: 'Sure' }
        ],
        answers: [
          { text: 'Plain answer', anchorId: 's1' },
          { text: 'Orphan answer', anchorId: 'missing' },
          { text: 'Loose answer' },
          { text: '   ' },
          { error: 'boom\nline2', anchorId: 's1' }
        ]
      },
      '2026-06-01T00:00:00.000Z'
    )

    expect(markdown).toBe(
      [
        '# Interview',
        '',
        '**Them:** Tell me about yourself',
        '',
        '> Plain answer',
        '',
        '> boom\n> line2',
        '',
        '**You:** Sure',
        '',
        '> Orphan answer',
        '',
        '> Loose answer',
        '',
        '---',
        'Exported from Parakeet Clone — 2026-01-02T03:04:05.000Z',
        ''
      ].join('\n')
    )
  })

  it('renders a parsed structured card as approach/steps/fenced-code/complexity', () => {
    const card = {
      approach: 'Use three pointers.',
      key_steps: ['Save next', 'Reverse link', 'Advance'],
      code: { language: 'python', source: 'def reverse(head):\n    pass' },
      complexity: { time: 'O(n)', space: 'O(1)' }
    }
    const markdown = buildSessionMarkdown(
      {
        title: 'Coding',
        segments: [{ id: 's1', speaker: 'Them', text: 'Reverse a linked list' }],
        answers: [{ text: JSON.stringify(card), anchorId: 's1' }]
      },
      '2026-06-01T00:00:00.000Z'
    )

    expect(markdown).toBe(
      [
        '# Coding',
        '',
        '**Them:** Reverse a linked list',
        '',
        'Use three pointers.',
        '',
        '1. Save next',
        '2. Reverse link',
        '3. Advance',
        '',
        '```python',
        'def reverse(head):',
        '    pass',
        '```',
        '',
        '**Complexity:** time O(n) · space O(1)',
        '',
        '---',
        'Exported from Parakeet Clone — 2026-06-01T00:00:00.000Z',
        ''
      ].join('\n')
    )
    expect(markdown).not.toContain('> {')
  })

  it('sanitizes a fence language containing newlines and backticks', () => {
    const card = {
      approach: 'Keep the fence intact.',
      key_steps: [],
      code: { language: 'py\n```\nthon', source: 'print(1)' },
      complexity: { time: '', space: '' }
    }
    const markdown = buildSessionMarkdown(
      { answers: [{ text: JSON.stringify(card) }] },
      'T'
    )
    expect(markdown).toContain('```python\nprint(1)\n```')
    expect(markdown).not.toContain('```py\n')
  })

  it('omits the fence language when sanitization leaves nothing', () => {
    const card = {
      approach: 'No language.',
      key_steps: [],
      code: { language: '```\n', source: 'print(1)' },
      complexity: { time: '', space: '' }
    }
    const markdown = buildSessionMarkdown(
      { answers: [{ text: JSON.stringify(card) }] },
      'T'
    )
    expect(markdown).toContain('```\nprint(1)\n```')
  })

  it('falls back to the exportedAt default when endedAt is missing', () => {
    const markdown = buildSessionMarkdown({}, 'FIXED-TIMESTAMP')
    expect(markdown).toBe(
      ['# Session', '', '---', 'Exported from Parakeet Clone — FIXED-TIMESTAMP', ''].join('\n')
    )
  })

  it('uses "Session" for a missing or blank title', () => {
    expect(buildSessionMarkdown({ title: '   ' }, 'T').startsWith('# Session\n')).toBe(true)
    expect(buildSessionMarkdown({}, 'T').startsWith('# Session\n')).toBe(true)
  })

  it('prefers endedAt over the exportedAt fallback', () => {
    const markdown = buildSessionMarkdown({ endedAt: 'ENDED' }, 'FALLBACK')
    expect(markdown).toContain('Exported from Parakeet Clone — ENDED')
    expect(markdown).not.toContain('FALLBACK')
  })

  it('renders any non-"You" speaker as Them', () => {
    const markdown = buildSessionMarkdown(
      {
        segments: [
          { id: 'a', speaker: 'You', text: 'y' },
          { id: 'b', speaker: 'Them', text: 't' },
          { id: 'c', speaker: 'System', text: 's' },
          { id: 'd', text: 'none' }
        ]
      },
      'T'
    )
    expect(markdown).toContain('**You:** y')
    expect(markdown).toContain('**Them:** t')
    expect(markdown).toContain('**Them:** s')
    expect(markdown).toContain('**Them:** none')
  })

  it('renders a multiline error as a blockquote without structured parsing', () => {
    const markdown = buildSessionMarkdown(
      {
        answers: [{ error: 'LLM error 500:\nretry later' }]
      },
      'T'
    )
    expect(markdown).toContain('> LLM error 500:\n> retry later')
  })

  it('skips answers whose text and error are empty', () => {
    const markdown = buildSessionMarkdown(
      {
        answers: [{ text: '' }, { error: '' }, { text: '   ' }, { text: 'kept' }]
      },
      'T'
    )
    expect(markdown).toContain('> kept')
    expect(markdown.match(/^>/gm) ?? []).toHaveLength(1)
  })

  it('emits orphan answers in insertion order, then loose answers', () => {
    const markdown = buildSessionMarkdown(
      {
        segments: [],
        answers: [
          { text: 'orphan-one', anchorId: 'x' },
          { text: 'orphan-two', anchorId: 'y' },
          { text: 'loose' }
        ]
      },
      'T'
    )
    const one = markdown.indexOf('> orphan-one')
    const two = markdown.indexOf('> orphan-two')
    const loose = markdown.indexOf('> loose')
    expect(one).toBeGreaterThan(-1)
    expect(one).toBeLessThan(two)
    expect(two).toBeLessThan(loose)
  })
})
