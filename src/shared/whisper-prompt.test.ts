import { describe, expect, it } from 'vitest'
import { buildWhisperPrompt, clip, WHISPER_PROMPT_BUDGET } from './whisper-prompt'

describe('buildWhisperPrompt', () => {
  it('returns empty when everything is empty', () => {
    expect(buildWhisperPrompt({})).toBe('')
    expect(buildWhisperPrompt({ company: '', vocabulary: '', carry: '' })).toBe('')
  })

  it('returns the carry-over untouched when there is no prefix', () => {
    expect(buildWhisperPrompt({ carry: 'so the API returns a promise' })).toBe(
      'so the API returns a promise'
    )
  })

  it('does not apply the 700-char budget when the prefix is empty (pinned behavior)', () => {
    const carry = 'x'.repeat(1200)
    const prompt = buildWhisperPrompt({ carry })
    expect(prompt).toBe(carry)
    expect(prompt).toHaveLength(1200)
  })

  it('builds a company-only prefix', () => {
    expect(buildWhisperPrompt({ company: 'Acme' })).toBe('Company: Acme.')
  })

  it('builds a vocabulary-only prefix', () => {
    expect(buildWhisperPrompt({ vocabulary: 'Kubernetes, gRPC' })).toBe(
      'Terms: Kubernetes, gRPC.'
    )
  })

  it('orders company before vocabulary', () => {
    expect(buildWhisperPrompt({ company: 'Acme', vocabulary: 'Kubernetes, gRPC' })).toBe(
      'Company: Acme. Terms: Kubernetes, gRPC.'
    )
  })

  it('appends the carry-over after the prefix', () => {
    expect(
      buildWhisperPrompt({
        company: 'Acme',
        vocabulary: 'Kubernetes, gRPC',
        carry: 'So we discussed deploys'
      })
    ).toBe('Company: Acme. Terms: Kubernetes, gRPC. So we discussed deploys')
  })

  it('collapses whitespace in company and vocabulary', () => {
    expect(
      buildWhisperPrompt({ company: '  Acme\n  Corp ', vocabulary: 'gRPC\n\tKubernetes' })
    ).toBe('Company: Acme Corp. Terms: gRPC Kubernetes.')
  })

  it('treats null/undefined fields as empty', () => {
    expect(buildWhisperPrompt({ company: null, vocabulary: undefined, carry: 'hi' })).toBe('hi')
  })

  it('clips an over-long prefix to exactly 700 chars and drops the carry-over', () => {
    const company = 'x'.repeat(1000)
    const prompt = buildWhisperPrompt({ company, carry: 'ignored' })
    expect(prompt).toHaveLength(WHISPER_PROMPT_BUDGET)
    expect(prompt.startsWith('Company: ')).toBe(true)
    expect(prompt).not.toContain('ignored')
  })

  it('keeps a prefix of exactly 700 chars with no room for carry-over', () => {
    const company = 'a'.repeat(690) // "Company: " (9) + 690 + "." = 700
    const prefix = `Company: ${company}.`
    expect(prefix).toHaveLength(700)
    const prompt = buildWhisperPrompt({ company, carry: 'ignored' })
    expect(prompt).toBe(prefix)
    expect(prompt).not.toContain('ignored')
  })

  it('fills the remainder with the tail of a long carry-over', () => {
    const carry = `${'a'.repeat(600)}${'b'.repeat(400)}`
    const prompt = buildWhisperPrompt({ company: 'Acme', carry })
    // prefix "Company: Acme." is 14 chars; room = 700 - 14 - 1 = 685.
    expect(prompt).toHaveLength(700)
    expect(prompt.startsWith('Company: Acme. ')).toBe(true)
    expect(prompt.endsWith('b'.repeat(400))).toBe(true)
    expect(prompt.slice('Company: Acme. '.length)).toHaveLength(685)
  })

  it('keeps exactly 700 chars when the carry-over fills the room exactly', () => {
    const prompt = buildWhisperPrompt({ company: 'Acme', carry: 'y'.repeat(685) })
    expect(prompt).toHaveLength(700)
    expect(prompt.endsWith('y'.repeat(685))).toBe(true)
  })

  const invariantInputs = [
    { company: 'Acme', vocabulary: '', carry: '' },
    { company: 'Acme', vocabulary: 'gRPC', carry: 'z'.repeat(2000) },
    { company: 'x'.repeat(5000), vocabulary: 'gRPC', carry: 'z'.repeat(2000) },
    { company: '', vocabulary: 'Kubernetes', carry: 'short carry' }
  ]

  for (const input of invariantInputs) {
    it(`never exceeds 700 chars when a prefix exists (${input.company.length}-char company)`, () => {
      expect(buildWhisperPrompt(input).length).toBeLessThanOrEqual(700)
    })
  }
})

describe('clip', () => {
  it('trims but keeps short text unchanged', () => {
    expect(clip('  hello  ', 10)).toBe('hello')
    expect(clip('abc', 3)).toBe('abc')
  })

  it('truncates with an ellipsis when over the limit', () => {
    expect(clip('abcdef', 3)).toBe('abc…')
    expect(clip('  abcdef  ', 4)).toBe('abcd…')
  })
})
