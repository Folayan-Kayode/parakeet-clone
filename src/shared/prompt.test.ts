import { describe, expect, it } from 'vitest'
import type {
  AnswerStyle,
  AppConfig,
  ProfileContext,
  SessionContext
} from './types'
import { buildSystemPrompt } from './prompt'

function makeConfig(
  overrides: {
    answer?: Partial<AnswerStyle>
    profile?: Partial<ProfileContext>
    session?: Partial<SessionContext>
  } = {}
): AppConfig {
  return {
    privateMode: true,
    clickThrough: false,
    panelOpacity: 0.92,
    llm: {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.2,
      maxTokens: 4096,
      reasoningEffort: 'low',
      autoEscalate: false,
      vision: true,
      profiles: [],
      activeProfileId: ''
    },
    asr: { mode: 'whispercpp', url: '', apiKey: '', model: '' },
    interaction: {
      autoAnswer: false,
      answerCooldownMs: 5000,
      mergeFollowUpsMs: 2000,
      silenceSplitMs: 900,
      transcribeMic: false,
      streamingPartials: false,
      earlyAnswer: false,
      autoScroll: true
    },
    answer: {
      length: overrides.answer?.length ?? 'balanced',
      format: overrides.answer?.format ?? 'balanced',
      tone: overrides.answer?.tone ?? 'formal',
      star: overrides.answer?.star ?? false,
      fillerWords: overrides.answer?.fillerWords ?? false,
      codeLanguage: overrides.answer?.codeLanguage ?? 'python',
      questionType: overrides.answer?.questionType ?? 'auto'
    },
    profile: {
      resume: overrides.profile?.resume ?? '',
      background: overrides.profile?.background ?? '',
      vocabulary: overrides.profile?.vocabulary ?? ''
    },
    session: {
      title: overrides.session?.title ?? '',
      company: overrides.session?.company ?? '',
      jobDescription: overrides.session?.jobDescription ?? '',
      extraContext: overrides.session?.extraContext ?? ''
    },
    window: { screenMode: 'primary', x: null, y: null, width: null, height: null },
    updates: { enabled: false, feedUrl: '' },
    meetings: { detect: false, autoStart: false, balloon: false },
    capture: { region: null },
    audio: { useWorklet: true }
  }
}

const NO_IMAGE_PROMPT = [
  "You are the user's live interview copilot. Your job: give a direct, speakable answer to the latest question in the call transcript.",
  'Rules:',
  '- Answer in the first person, natural spoken style, as the candidate.',
  '- Be accurate; use only the provided context for facts. Never invent employers, dates, metrics, or achievements. Any number or metric you state must appear in the reference material above. If facts are missing, give a sensible framework and briefly note the gap.',
  '- Never mention that you are an AI, a model, or a transcript.',
  '- If no clear question is present, ask the user to repeat it in one short sentence.',
  'Style: Aim for 80-140 words. Mix short paragraphs with a bullet list when it helps clarity. Use a professional, composed tone. Avoid filler words; speak crisply.'
].join('\n')

describe('buildSystemPrompt', () => {
  it('is byte-stable for the default text-only prompt', () => {
    expect(buildSystemPrompt(makeConfig(), false, 'other')).toBe(NO_IMAGE_PROMPT)
  })

  it('omits the image protocol for a coding question without an image', () => {
    const prompt = buildSystemPrompt(makeConfig(), false, 'coding')
    expect(prompt).not.toContain('An image is attached')
    expect(prompt).not.toContain('multiple-choice')
  })

  it('appends session and profile context in order when set', () => {
    const prompt = buildSystemPrompt(
      makeConfig({
        session: {
          company: '  Acme Corp  ',
          jobDescription: 'Build backend services',
          extraContext: 'Keep it brief'
        },
        profile: { background: 'Six years of backend work', resume: 'CV text' }
      }),
      false,
      'other'
    )
    expect(prompt).toContain(
      'Session context:\nCompany: Acme Corp\n\nJob description:\nBuild backend services\n\nExtra instructions:\nKeep it brief'
    )
    expect(prompt).toContain(
      'About the candidate:\nCandidate background:\nSix years of backend work\n\nResume (factual source for the candidate):\nCV text'
    )
    expect(prompt.indexOf('Session context:')).toBeLessThan(prompt.indexOf('About the candidate:'))
  })

  describe('image protocol', () => {
    it('uses the strict JSON contract for image + coding, last in the prompt', () => {
      const prompt = buildSystemPrompt(
        makeConfig({ answer: { codeLanguage: 'javascript' } }),
        true,
        'coding'
      )
      expect(prompt).toContain('An image is attached to this question.')
      expect(prompt).toContain('Respond with ONLY a JSON object and no other text')
      expect(prompt).toContain(
        '{"approach": "<=2 sentence first-person approach", "key_steps": ["..."], "code": {"language": "javascript", "source": "..."}, "complexity": {"time": "...", "space": "..."}}'
      )
      expect(prompt).toContain(
        'Fill "approach" with at most two spoken-style first-person sentences.'
      )
      expect(prompt).not.toContain('multiple-choice')
      expect(prompt).not.toContain('Else: fall back')
      expect(prompt.endsWith('These image rules take precedence over the Style word budget above.')).toBe(
        true
      )
    })

    it('covers the coding-problem, multiple-choice and fallback branches for image + other', () => {
      const prompt = buildSystemPrompt(makeConfig(), true, 'other')
      expect(prompt).toContain('An image is attached to this question.')
      expect(prompt).toContain('- If the image contains a programming/coding problem:')
      expect(prompt).toContain(
        'Else if the image is a multiple-choice question: state the selected answer (letter + text) FIRST, then at most one short line of justification.'
      )
      expect(prompt).toContain('- Else: fall back to the normal spoken-answer style.')
      expect(prompt).not.toContain('ONLY a JSON object')
      expect(prompt.endsWith('These image rules take precedence over the Style word budget above.')).toBe(
        true
      )
    })

    it('always states the precedence over the style word budget', () => {
      expect(buildSystemPrompt(makeConfig(), true, 'coding')).toContain(
        'These image rules take precedence over the Style word budget above.'
      )
      expect(buildSystemPrompt(makeConfig(), true, 'behavioral')).toContain(
        'These image rules take precedence over the Style word budget above.'
      )
    })
  })

  describe('STAR rule', () => {
    const STAR =
      'For behavioral questions, structure the answer as STAR (Situation, Task, Action, Result) without labeling the parts aloud.'

    it('includes STAR when the style asks for it', () => {
      expect(buildSystemPrompt(makeConfig({ answer: { star: true } }), false, 'other')).toContain(
        STAR
      )
    })

    it('includes STAR when the question resolves to behavioral', () => {
      expect(
        buildSystemPrompt(makeConfig({ answer: { star: false } }), false, 'behavioral')
      ).toContain(STAR)
    })

    it('omits STAR when neither the style nor the question type asks for it', () => {
      const prompt = buildSystemPrompt(makeConfig({ answer: { star: false } }), false, 'other')
      expect(prompt).not.toContain('structure the answer as STAR')
    })
  })

  describe('style interpolation', () => {
    const lengths: Array<[AnswerStyle['length'], string]> = [
      ['concise', 'Keep answers short: 50-80 words.'],
      ['detailed', 'Give a thorough answer: 150-220 words.'],
      ['balanced', 'Aim for 80-140 words.']
    ]
    for (const [length, expected] of lengths) {
      it(`interpolates length: ${length}`, () => {
        expect(buildSystemPrompt(makeConfig({ answer: { length } }), false, 'other')).toContain(
          expected
        )
      })
    }

    const formats: Array<[AnswerStyle['format'], string]> = [
      ['bullets', 'When listing points, use tight bullet lines.'],
      ['paragraph', 'Answer in flowing prose without bullet lists.'],
      ['balanced', 'Mix short paragraphs with a bullet list when it helps clarity.']
    ]
    for (const [format, expected] of formats) {
      it(`interpolates format: ${format}`, () => {
        expect(buildSystemPrompt(makeConfig({ answer: { format } }), false, 'other')).toContain(
          expected
        )
      })
    }

    const tones: Array<[AnswerStyle['tone'], string]> = [
      ['casual', 'Use a natural, conversational tone.'],
      ['simple', 'Use plain, simple language.'],
      ['formal', 'Use a professional, composed tone.']
    ]
    for (const [tone, expected] of tones) {
      it(`interpolates tone: ${tone}`, () => {
        expect(buildSystemPrompt(makeConfig({ answer: { tone } }), false, 'other')).toContain(
          expected
        )
      })
    }

    it('interpolates filler words on', () => {
      expect(
        buildSystemPrompt(makeConfig({ answer: { fillerWords: true } }), false, 'other')
      ).toContain(
        'Include light, natural spoken fillers ("honestly", "so", "you know") sparingly, no more than once or twice.'
      )
    })

    it('interpolates filler words off', () => {
      expect(
        buildSystemPrompt(makeConfig({ answer: { fillerWords: false } }), false, 'other')
      ).toContain('Avoid filler words; speak crisply.')
    })

    it('renders all four style rules on the single Style line', () => {
      const prompt = buildSystemPrompt(
        makeConfig({
          answer: {
            length: 'concise',
            format: 'bullets',
            tone: 'casual',
            fillerWords: true
          }
        }),
        false,
        'other'
      )
      expect(prompt).toContain(
        'Style: Keep answers short: 50-80 words. When listing points, use tight bullet lines. Use a natural, conversational tone. Include light, natural spoken fillers ("honestly", "so", "you know") sparingly, no more than once or twice.'
      )
    })
  })
})
