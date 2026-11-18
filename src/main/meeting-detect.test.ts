import { describe, expect, it } from 'vitest'
import {
  isAlwaysOnApp,
  isAlwaysOnTitle,
  meetingTitleHit,
  MEETING_TITLE_RE
} from './meeting-detect'

describe('meetingTitleHit', () => {
  const matched: Array<{ title: string; strong: boolean; label: string }> = [
    // Generic Zoom titles notify only.
    { title: 'Zoom Meeting', strong: false, label: 'zoom-meeting' },
    { title: 'Zoom Meeting - Google Chrome', strong: false, label: 'zoom-meeting' },
    { title: 'Zoom Meeting — Microsoft Edge', strong: false, label: 'zoom-meeting' },
    { title: 'Meeting - Zoom', strong: false, label: 'zoom' },
    // Browser-suffixed Meet titles are strong.
    { title: 'Meet - user@x@gmail.com', strong: false, label: 'meet' },
    { title: 'meet.google.com - Google Chrome', strong: true, label: 'meet-browser' },
    { title: 'meet.google.com — Microsoft Edge', strong: true, label: 'meet-browser' },
    // Teams and Zoom Workplace are strong.
    { title: 'Microsoft Teams', strong: true, label: 'teams-meeting' },
    { title: 'Microsoft Teams Meeting', strong: true, label: 'teams-meeting' },
    { title: 'Zoom Workplace', strong: true, label: 'zoom-workplace' },
    // " - discord$" pattern.
    { title: 'Team chat - Discord', strong: false, label: 'discord' },
    { title: 'Team chat - DISCORD', strong: false, label: 'discord' },
    { title: 'FaceTime', strong: false, label: 'facetime' }
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
      strong: true,
      label: 'teams-meeting'
    })
  })

  it('keeps the first matched title when no later match is strong', () => {
    expect(meetingTitleHit(['Zoom Meeting', 'Meeting - Zoom'])).toEqual({
      title: 'Zoom Meeting',
      strong: false,
      label: 'zoom-meeting'
    })
  })

  it('exposes the strong flag and a redacted label per pattern', () => {
    expect(MEETING_TITLE_RE.filter((pattern) => pattern.strong)).toHaveLength(3)
    const labels = MEETING_TITLE_RE.map((pattern) => pattern.label)
    expect(labels.every((label) => label.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(MEETING_TITLE_RE.length)
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
