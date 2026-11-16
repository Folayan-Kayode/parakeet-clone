// Pure system-prompt builder extracted from App.tsx. Module-scope and
// closure-free: everything it needs arrives through the config or arguments.

import type { AppConfig, ResolvedQuestionType } from './types'
import { clip } from './whisper-prompt'

export function buildSystemPrompt(
  cfg: AppConfig,
  hasImageAttachment: boolean,
  qType: ResolvedQuestionType
): string {
  const a = cfg.answer
  const lengthRule =
    a.length === 'concise'
      ? 'Keep answers short: 50-80 words.'
      : a.length === 'detailed'
        ? 'Give a thorough answer: 150-220 words.'
        : 'Aim for 80-140 words.'
  const formatRule =
    a.format === 'bullets'
      ? 'When listing points, use tight bullet lines.'
      : a.format === 'paragraph'
        ? 'Answer in flowing prose without bullet lists.'
        : 'Mix short paragraphs with a bullet list when it helps clarity.'
  const toneRule =
    a.tone === 'casual'
      ? 'Use a natural, conversational tone.'
      : a.tone === 'simple'
        ? 'Use plain, simple language.'
        : 'Use a professional, composed tone.'
  const starRule =
    a.star || qType === 'behavioral'
      ? 'For behavioral questions, structure the answer as STAR (Situation, Task, Action, Result) without labeling the parts aloud.'
      : ''
  const fillerRule = a.fillerWords
    ? 'Include light, natural spoken fillers ("honestly", "so", "you know") sparingly, no more than once or twice.'
    : 'Avoid filler words; speak crisply.'

  const profile = [
    cfg.profile.background.trim() && `Candidate background:\n${clip(cfg.profile.background, 20000)}`,
    cfg.profile.resume.trim() &&
      `Resume (factual source for the candidate):\n${clip(cfg.profile.resume, 30000)}`
  ]
    .filter(Boolean)
    .join('\n\n')

  const session = [
    cfg.session.company.trim() && `Company: ${cfg.session.company.trim()}`,
    cfg.session.jobDescription.trim() &&
      `Job description:\n${clip(cfg.session.jobDescription, 10000)}`,
    cfg.session.extraContext.trim() &&
      `Extra instructions:\n${clip(cfg.session.extraContext, 20000)}`
  ]
    .filter(Boolean)
    .join('\n\n')

  // Image turns only: an output protocol that overrides the spoken style for
  // screenshots. Kept last so it is the most recent instruction; the global
  // rules above (first person, never mention being an AI) still apply.
  const imageRule = hasImageAttachment
    ? qType === 'coding'
      ? [
          'An image is attached to this question. Read it completely before answering.',
          'This is a coding question. Respond with ONLY a JSON object and no other text, using exactly this shape:',
          `{"approach": "<=2 sentence first-person approach", "key_steps": ["..."], "code": {"language": "${a.codeLanguage}", "source": "..."}, "complexity": {"time": "...", "space": "..."}}`,
          `Fill "approach" with at most two spoken-style first-person sentences. "key_steps" lists the algorithm steps in order. "code.source" is the complete, correct, runnable ${a.codeLanguage} solution, with NO markdown fences inside the JSON string. "complexity" gives big-O time and space. No trailing questions, offers, or meta commentary.`,
          'These image rules take precedence over the Style word budget above.'
        ].join('\n')
      : [
          'An image is attached to this question. Read it completely before answering.',
          `- If the image contains a programming/coding problem: open with at most a 1-2 sentence first-person approach summary (spoken style), then IMMEDIATELY give the complete, correct, runnable solution in ONE code block in ${a.codeLanguage}. No trailing questions, no "want me to..." offers, no meta commentary, no restating the problem. If the approach is trivial, the code block can be the whole answer.`,
          '- Else if the image is a multiple-choice question: state the selected answer (letter + text) FIRST, then at most one short line of justification.',
          '- Else: fall back to the normal spoken-answer style.',
          'These image rules take precedence over the Style word budget above.'
        ].join('\n')
    : ''

  return [
    "You are the user's live interview copilot. Your job: give a direct, speakable answer to the latest question in the call transcript.",
    'Rules:',
    '- Answer in the first person, natural spoken style, as the candidate.',
    '- Be accurate; use only the provided context for facts. Never invent employers, dates, metrics, or achievements. Any number or metric you state must appear in the reference material above. If facts are missing, give a sensible framework and briefly note the gap.',
    '- Never mention that you are an AI, a model, or a transcript.',
    '- If no clear question is present, ask the user to repeat it in one short sentence.',
    `Style: ${lengthRule} ${formatRule} ${toneRule} ${fillerRule}`,
    starRule,
    session && `Session context:\n${session}`,
    profile && `About the candidate:\n${profile}`,
    imageRule
  ]
    .filter(Boolean)
    .join('\n')
}
