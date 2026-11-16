import { describe, expect, it } from 'vitest'
import type { QuestionType, ResolvedQuestionType } from './types'
import {
  guessQuestionType,
  isQuestion,
  looksCompleteQuestion,
  resolveQuestionType,
  similarity
} from './question-heuristics'

describe('guessQuestionType', () => {
  const cases: Array<[string, ResolvedQuestionType]> = [
    // Story-style openers win even when the sentence mentions a coding verb.
    ['Tell me about a time you had to implement a hash map', 'behavioral'],
    ['Tell me about yourself', 'behavioral'],
    ['Describe a time you disagreed with a teammate about the algorithm', 'behavioral'],
    ['Describe a situation where we had a conflict about the algorithm', 'behavioral'],
    // Coding keywords win over behavioral keywords when there is no opener.
    ['Can you optimize this algorithm?', 'coding'],
    ['What is a linked list?', 'coding'],
    ['How would you implement a rate limiter?', 'coding'],
    ['We had a conflict about the algorithm', 'coding'],
    // Behavioral keywords without an opener.
    ['What is your greatest strength?', 'behavioral'],
    ['Tell me about a deadline you missed', 'behavioral'],
    // Neither list matches.
    ['Why do you want this role?', 'other'],
    ['How would you design a URL shortener?', 'other'],
    ['', 'other'],
    ['   ', 'other']
  ]

  for (const [text, expected] of cases) {
    it(`classifies ${JSON.stringify(text)} as ${expected}`, () => {
      expect(guessQuestionType(text)).toBe(expected)
    })
  }

  it('is case-insensitive', () => {
    expect(guessQuestionType('TELL ME ABOUT A TIME you shipped late')).toBe('behavioral')
    expect(guessQuestionType('What is a HASH MAP?')).toBe('coding')
  })
})

describe('resolveQuestionType', () => {
  it('guesses only when the setting is auto', () => {
    expect(resolveQuestionType('auto', 'What is a binary tree?')).toBe('coding')
    expect(resolveQuestionType('auto', 'Tell me about a time you failed')).toBe('behavioral')
    expect(resolveQuestionType('auto', 'I enjoy distributed systems')).toBe('other')
  })

  it('returns every explicit setting untouched, regardless of the text', () => {
    const settings: ResolvedQuestionType[] = [
      'behavioral',
      'coding',
      'system-design',
      'experience',
      'technical',
      'other'
    ]
    for (const setting of settings) {
      expect(resolveQuestionType(setting as QuestionType, 'What is a binary tree?')).toBe(setting)
      expect(resolveQuestionType(setting as QuestionType, '')).toBe(setting)
    }
  })
})

describe('similarity', () => {
  it('returns 1 for identical token sets, ignoring case and trailing punctuation', () => {
    expect(similarity('The quick brown fox', 'the quick brown fox')).toBe(1)
    expect(similarity('Hello world.', 'hello world')).toBe(1)
    expect(similarity('Same text?!', 'same text')).toBe(1)
  })

  it('returns 0 for disjoint or empty token sets', () => {
    expect(similarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0)
    expect(similarity('', '')).toBe(0)
    expect(similarity('a an of', 'a an of')).toBe(0)
    expect(similarity('', 'some real words')).toBe(0)
  })

  it('computes Jaccard over tokens longer than two characters', () => {
    // {the, quick, brown, fox} vs {the, quick, blue, fox}: 3 shared / 5 union.
    expect(similarity('the quick brown fox', 'the quick blue fox')).toBe(0.6)
  })

  it('scores a near-duplicate above the 0.6 echo threshold', () => {
    const score = similarity(
      'we should discuss the deployment timeline next week',
      'we should discuss the deployment timeline next month'
    )
    expect(score).toBeGreaterThan(0.6)
  })

  it('leaves a pair at exactly 0.6 unfiltered (the ECHO filter uses strict > 0.6)', () => {
    // The two call sites in App.tsx compare `similarity(...) > 0.6`; this pair
    // documents the boundary those imports rely on.
    const score = similarity(
      'I worked on the payment service',
      'I worked on the payment system'
    )
    expect(score).toBe(0.6)
    expect(score > 0.6).toBe(false)
  })
})

describe('isQuestion', () => {
  const trueCases = [
    'What is a monad?',
    'Okay?',
    'Tell me about your experience with Kafka',
    'Walk me through your last project',
    'What is a monad',
    'Could you explain closures',
    'Did you use TypeScript',
    'a time when we shipped late',
    '  How do you test?  '
  ]
  for (const text of trueCases) {
    it(`treats ${JSON.stringify(text)} as a question`, () => {
      expect(isQuestion(text)).toBe(true)
    })
  }

  const falseCases = [
    '',
    '   ',
    'I worked at Acme for five years',
    'You',
    'The water is very clean.',
    'Thanks for watching',
    // A question word after the two-token prefix window does not match.
    'In your last role what did you do'
  ]
  for (const text of falseCases) {
    it(`does not treat ${JSON.stringify(text)} as a question`, () => {
      expect(isQuestion(text)).toBe(false)
    })
  }
})

describe('looksCompleteQuestion', () => {
  it('requires a trailing question mark and at least five word tokens', () => {
    expect(looksCompleteQuestion('Do you know the answer?')).toBe(true)
    expect(looksCompleteQuestion('What is the time complexity of binary search?')).toBe(true)
    expect(looksCompleteQuestion('Do you know why?')).toBe(false)
    expect(looksCompleteQuestion('Do you know the answer')).toBe(false)
    expect(looksCompleteQuestion('?')).toBe(false)
  })

  it('ignores punctuation-only tokens when counting words', () => {
    expect(looksCompleteQuestion('Wait — what?')).toBe(false)
    expect(looksCompleteQuestion('Can you explain — that please?')).toBe(true)
  })

  it('trims surrounding whitespace before checking the trailing mark', () => {
    expect(looksCompleteQuestion('  Do you know the answer?   ')).toBe(true)
    expect(looksCompleteQuestion('')).toBe(false)
  })
})
