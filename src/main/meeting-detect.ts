// Pure title/process matching rules extracted from main/index.ts. The process
// and desktopCapturer probes themselves stay in main because they spawn work /
// need Electron; this module only holds the matching data and helpers.

// Browser meetings have no process signature, so match app-shaped window titles.
// `strong` titles are meeting-specific enough to auto-start capture; generic
// titles ("Meet - abc", "FaceTime") only notify, since a browser tab or the
// FaceTime app can sit open all day.
export const MEETING_TITLE_RE: Array<{ re: RegExp; strong: boolean }> = [
  { re: / - zoom( meeting)?$/i, strong: false }, // "... - Zoom" / "... - Zoom Meeting"
  {
    re: /(^| - )zoom meeting( - (google chrome|microsoft edge)| — (google chrome|microsoft edge))?$/i,
    strong: false
  }, // "Zoom Meeting" / "Zoom Meeting - Google Chrome" / "Zoom Meeting — Microsoft Edge"
  // The em-dash in Edge window separators is intentional (TS source is UTF-8;
  // only the .ps1 scripts must stay ASCII).
  // Browser-suffixed Meet titles only; non-browser "Meet - <name>" titles rely
  // on the generic pattern below and are notify-only.
  {
    re: /^meet(\.google\.com)?(?: - \S+| — \S+)?(?: - google chrome| — microsoft edge)$/i,
    strong: true
  }, // "Meet - abc - Google Chrome" / "meet.google.com — Microsoft Edge"
  { re: /^meet - .+$/i, strong: false }, // "Meet - abc-def"
  { re: /( - |^)microsoft teams( meeting.*)?$/i, strong: true }, // "Microsoft Teams Meeting" / "... - Microsoft Teams"
  { re: / - webex meeting( \|.*)?$/i, strong: false }, // "... - Webex Meeting | ..."
  { re: /facetime$/i, strong: false }, // "FaceTime"
  { re: / - discord$/i, strong: false }, // "... - Discord"
  { re: /zoom workplace/i, strong: true } // "Zoom Workplace"
]

// Apps that are commonly always running: notify, but never auto-start capture.
export const ALWAYS_ON_APPS = ['discord.exe', 'slack.exe', 'whatsapp.exe']

// Window titles for always-running chat apps are suppressed the same way.
const ALWAYS_ON_TITLE_RE = /\b(discord|slack|whatsapp)\b/i

export function isAlwaysOnApp(name: string): boolean {
  return ALWAYS_ON_APPS.includes(name)
}

export function isAlwaysOnTitle(title: string): boolean {
  return ALWAYS_ON_TITLE_RE.test(title)
}

export function meetingTitleHit(titles: string[]): { title: string; strong: boolean } | null {
  let hit: { title: string; strong: boolean } | null = null
  for (const title of titles) {
    for (const pattern of MEETING_TITLE_RE) {
      if (!pattern.re.test(title)) continue
      if (!hit) hit = { title, strong: pattern.strong }
      else if (pattern.strong) hit.strong = true
    }
  }
  return hit
}
