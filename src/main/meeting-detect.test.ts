import { describe, expect, it } from 'vitest'
import {
  isAlwaysOnApp,
  isAlwaysOnTitle,
  meetingTitleHit,
  MEETING_TITLE_RE
} from './meeting-detect'

describe('meetingTitleHit', () => {
  const matched: Array<{ title: string; strong: boolean }> = [
    // Generic Zoom titles notify only.
    { title: 'Zoom Meeting', strong: false },
    { title: 'Zoom Meeting - Google Chrome', strong: false },
    { title: 'Zoom Meeting — Microsoft Edge', strong: false },
    { title: 'Meeting - Zoom', strong: false },
    // Browser-suffixed Meet titles are strong.
    { title: 'Meet - user@x@gmail.com', strong: false },
    { title: 'meet.google.com - Google Chrome', strong: true },
    { title: 'meet.google.com — Microsoft Edge', strong: true },
    // Teams and Zoom Workplace are strong.
    { title: 'Microsoft Teams', strong: true },
    { title: 'Microsoft Teams Meeting', strong: true },
    { title: 'Zoom Workplace', strong: true },
    // " - discord$" pattern.
    { title: 'Team chat - Discord', strong: false },
    { title: 'Team chat - DISCORD', strong: false },
    { title: 'FaceTime', strong: false }
  ]

  for (const testCase of matched) {
    it(`matches "${testCase.title}" (strong=${testCase.strong})`, () => {
      expect(meetingTitleHit([testCase.title])).toEqual(testCase)
    })
  }

  const unmatched = [
    'How to join a Zoom Meeting - support',
    'meeting-notes.md - VS Code',
    'Meet the Press - NBC News - Google Chrome',
    'Webex Meeting',
    'Slack | general - Google Chrome',
    ''
  ]

  it.each(unmatched)('does not match %s', (title) => {
    expect(meetingTitleHit([title])).toBeNull()
  })

  it('returns null for an empty title list', () => {
    expect(meetingTitleHit([])).toBeNull()
  })

  it('keeps the first matched title and upgrades strong when a later title is strong', () => {
    expect(meetingTitleHit(['Meet - abc', 'Microsoft Teams'])).toEqual({
      title: 'Meet - abc',
      strong: true
    })
  })

  it('keeps the first matched title when no later match is strong', () => {
    expect(meetingTitleHit(['Zoom Meeting', 'Meeting - Zoom'])).toEqual({
      title: 'Zoom Meeting',
      strong: false
    })
  })

  it('exposes the strong flag per pattern', () => {
    expect(MEETING_TITLE_RE.filter((pattern) => pattern.strong)).toHaveLength(3)
  })
})

describe('isAlwaysOnTitle', () => {
  const cases: Array<[string, boolean]> = [
    ['Slack | general - Google Chrome', true],
    ['Discord', true],
    ['WhatsApp Web', true],
    ['sLaCk', true],
    ['Zoom Meeting', false],
    ['Microsoft Teams', false],
    ['meeting-notes.md - VS Code', false]
  ]

  it.each(cases)('%s -> %s', (title, expected) => {
    expect(isAlwaysOnTitle(title)).toBe(expected)
  })
})

describe('isAlwaysOnApp', () => {
  const cases: Array<[string, boolean]> = [
    ['discord.exe', true],
    ['slack.exe', true],
    ['whatsapp.exe', true],
    ['zoom.exe', false],
    ['teams.exe', false],
    ['ms-teams.exe', false]
  ]

  it.each(cases)('%s -> %s', (name, expected) => {
    expect(isAlwaysOnApp(name)).toBe(expected)
  })

  it('expects lowercase names (listProcessNames lowercases tasklist output)', () => {
    expect(isAlwaysOnApp('DISCORD.EXE')).toBe(false)
  })
})
