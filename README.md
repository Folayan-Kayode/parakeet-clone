# Parakeet Clone

Local-first interview copilot overlay for Windows. Independent reimplementation built from a
static analysis of a similar Electron app's *techniques* — no code, assets, prompts, or backends
are copied. Runs your own speech-to-text and your own LLM (local or API).

## First run (new machine / colleague)

1. **Install** — run `parakeet-clone-setup-<version>.exe` (per-user, no admin), or for development
   run `npm install` then `npm run dev`.
2. **Models** — *Settings → Models → Add model*, pick a catalog entry and paste **your own** key for
   that vendor (Google / OpenAI / Anthropic). Anthropic 5.x rejects temperature and ignores
   reasoning effort; the app omits both automatically.
3. **Transcription** — the installer ships the helper scripts inside the install directory at
   `<install dir>\resources\app.asar.unpacked\scripts` (e.g.
   `%LOCALAPPDATA%\Programs\Parakeet Clone\resources\app.asar.unpacked\scripts`); from a cloned
   repo, use its `scripts\` folder. Run `setup-local.ps1` once (downloads whisper.cpp + the model),
   then `start-parakeet.ps1` daily; it starts whisper-server only if port 8080 is closed. Add
   `-CreateShortcut` once for a desktop shortcut. Optional: run `register-whisper-autostart.ps1` to
   start whisper at logon (the launcher already covers it per run).
4. **Context** — fill Company, résumé (Import PDF), job link (Paste job link) and Names & jargon.
5. **Self-test** — *Settings → Capture self-test*; confirm capture exclusion, loopback audio and mic.
6. **Hotkeys** — see the Hotkeys table below (Ctrl+Shift+Enter answer, Ctrl+Alt+Enter screenshot,
   Ctrl+Shift+Space chat, Ctrl+Shift+H hide).

## What it does

- Transparent, always-on-top, resizable overlay (screen-capture protected by default, click-through
  toggle)
- Transcribes the remote side from Windows system-audio loopback ("Them"). Microphone
  transcription ("You") is optional in Settings (off by default to avoid echo and Whisper
  hallucinations from room noise).
- Live partial transcripts: text updates while the person is still speaking (~800 ms cadence),
  then a final polished segment replaces it on end-of-utterance.
- Sticky-bottom auto-scroll (toggle in Settings): follows new transcript and answers while you
  stay at the bottom, and never yanks you down after you scroll up.
- Follow-up questions that arrive while an answer is streaming are queued (the two most recent
  are kept) and answered once the current answer finishes.
- Pause-tolerant auto-answer: final-triggered questions wait a configurable grace window, merge
  follow-up speech, and re-transcribe the combined utterance audio so one paused question gets one
  answer
- Segments speech with a lightweight VAD and transcribes each chunk
- Streams answers from any OpenAI-compatible chat endpoint (Ollama, LM Studio, OpenRouter, OpenAI…)
- Saved model profiles (each with its own endpoint, key and sampling) and a live-view switcher;
  switching applies to the next question without a restart
- Screenshot attachment for vision-capable models
- Saved region screenshots (Ctrl+Alt+R): drag a rectangle on an in-overlay, capture-protected preview
- Résumé / job-description / background context (pasted, loaded from `.txt`, or imported from a
  PDF/job link), used as the factual source for answers — the model is instructed never to invent
  metrics
- Vocabulary/company terms prepended to the Whisper prompt so names and acronyms transcribe
  consistently
- Answer style controls: length (concise/balanced/detailed), format (bullets/balanced/paragraph),
  tone (formal/casual/simple), STAR structure, optional filler words, plus a static answer preview
  that updates as you change them
- Question-type chip in the composer (Auto / Behavioral / Coding / System design / Experience /
  Technical / Other); Auto guesses from the question and Coding forces escalation and a structured
  JSON answer for screenshot asks
- Single-instance lock (launching a second copy focuses the existing overlay)
- Follow-up aware answers (last two answers are kept in context) and a Regenerate button
- Stop a streaming answer with the ✕ button on its row; the partial text is kept and no error
  banner appears
- Chat-style thread: every answer appears directly beneath the question it answers, including
  answers started early while the question is still being spoken
- Session history browser (read-only transcripts and answers, paired Q/A, with saved screenshots)
  with per-session and delete-all actions (two-click confirm), plus Markdown export per session
- Transcript accuracy: Whisper prompt carry-over between chunks (names/wording stay consistent),
  0.9 s end-of-utterance splitting (configurable as *Silence split* in Settings), and
  hallucination/echo filtering
- Meeting auto-detection (Zoom/Teams/Webex/Discord/Slack/Chime/Lark/WhatsApp) with tray
  notification and optional auto-start
- System tray menu: show/hide, answer, screenshot, settings, move to cursor screen, quit
- Multi-monitor: start on primary or cursor screen, remembered position, Ctrl+Shift+M to move,
  screenshots capture the monitor the overlay is on
- Settings self-tests for the LLM and speech endpoints
- Capture self-test that verifies the overlay is undetectable: OS-level capture exclusion,
  hidden from window-picker enumeration, the screenshot path, silent loopback audio and mic access
- Optional auto-update from a generic feed (electron-updater)
- Session saving (JSON) to `%APPDATA%\parakeet-clone\sessions\`

## Quick start

```powershell
cd $HOME\Desktop\parakeet-clone
npm install
npm run dev
```

If Electron's binary is missing (npm 11 blocks install scripts by default), run:

```powershell
node node_modules\electron\install.js
```

Tests: `npm test` runs the suite once, `npm test:watch` watches; `npm run typecheck` checks strict TS.

## Session context

The home screen stores the company, job description, extra instructions, background, résumé and a
**Names & jargon** vocabulary list (comma or newline separated). Context caps sent to the model are
20k characters for background, 30k for the résumé, 10k for the job description and 20k for extra
instructions.

- **Import PDF** next to the résumé opens a file picker, extracts text with `pdfjs-dist` in the
  main process (no worker), and clips it to 30k characters. Encrypted or invalid PDFs fail with a
  toast; the current text is only replaced after confirmation.
- **Paste job link** under the job description fetches the page with browser-ish headers, strips
  scripts/styles/tags and clips the result to 10k characters. The title fills the company field
  when it is empty. LinkedIn and other login-walled pages usually refuse the fetch — the app then
  says *Couldn't fetch — paste it manually*.
- The company and vocabulary are prepended to the Whisper prompt; the recent transcript carry-over
  fills the remainder of the 700-character budget.

Sessions save transcripts, answers and the 10 most recent screenshots (thumbnails appear under
their answers in History). Each saved image is captured at 1600x900 JPEG q85 (typically well under
1 MB). Answers whose question segment was not captured get a `(question not captured)` placeholder
at save time so Q→A pairing survives.

While listening, the live transcript is snapshotted to `autosave.json` every 2 minutes (offered for
recovery in History). Closing the window or quitting mid-session saves the transcript first. End is
idempotent — pressing it twice, or End then Alt+F4, writes one session file and clears the live
transcript for the next session.

## Models

Answers come from **model profiles**. Each profile is a complete endpoint identity — label, speed
badge, base URL, API key, model id, temperature, max-token cap, reasoning effort and
auto-escalation. Add as many as you like in *Settings → Models*, from the built-in catalog or as a
custom OpenAI-compatible entry. Profiles can be edited, renamed and deleted (the last one cannot be
deleted); API keys are stored per profile.

The live-view header shows the active profile and its badge. Click the chip to switch. A switch
applies to your **next question** only — the current stream keeps running and no restart is needed.

### Catalog

| Profile | Vendor | Model ID | Badge | Effort | Temperature |
|---|---|---|---|---|---|
| Gemini 3.8 Flash | Google | `gemini-3.8-flash` | Recommended | medium | on |
| GPT-6.1 Terra | OpenAI | `gpt-6.1-terra` | Fast | low | on |
| Claude Haiku 5.5 | Anthropic | `claude-haiku-5-5` | Fast | omitted | omitted |
| Claude Sonnet 5.5 | Anthropic | `claude-sonnet-5-5` | Fast | omitted | omitted |
| Gemini 3.5 Flash-Lite | Google | `gemini-3.5-flash-lite` | Fast | low | on |
| GPT-6.1 Sol | OpenAI | `gpt-6.1-sol` | Slow | high | on |
| Claude Fable 5.2 | Anthropic | `claude-fable-5-2` | Very slow | omitted | omitted |

Badges are a rough latency guide. "Recommended" is the default general-purpose choice; "slow" and
"very slow" models are best reserved for hard algorithmic or coding questions.

### Per-vendor keys

- **Google** — key from AI Studio, base URL
  `https://generativelanguage.googleapis.com/v1beta/openai/`
- **OpenAI** — key from the OpenAI platform, base URL `https://api.openai.com/v1`
- **Anthropic** — key from the Anthropic console, base URL `https://api.anthropic.com/v1/`
- **Custom / OpenRouter…** — any OpenAI-compatible `/chat/completions` endpoint; enter base URL,
  key and model id manually (e.g. `https://openrouter.ai/api/v1`)

### Anthropic quirks

Claude 5.x **rejects `temperature`** and **ignores `reasoning_effort`**. The catalog marks those
entries as unsupported and the main process omits both fields for any Anthropic model — and for any
custom profile pointed at an Anthropic base URL — even if the profile still carries values. The
request body is built from the catalog's `supportsTemperature` / `supportsEffort` flags, so unknown
custom models stay permissive.

Everyone uses their own keys in their own profiles; nothing is shared or sent anywhere except the
endpoint you configure. Profile export/import is planned for a later release.

### Local Ollama profile

```powershell
winget install Ollama.Ollama        # system install
ollama pull qwen2.5vl:7b            # vision-capable: reads screenshots
```

Default settings already point at `http://127.0.0.1:11434/v1`, model `qwen2.5vl:7b`.
For a lighter/faster option: `qwen2.5:3b-instruct`.

*Settings → Models → Advanced* exposes **Temperature** (0–1; uncheck "omit temperature") and
**Max tokens** (128–8192, default 4096); interview answers usually work best at temperature 0.1–0.3.

**Reasoning effort** (Low/Medium/High/Default): Low is conversational and fast for live interviews,
Medium is balanced, High suits hard algorithmic questions and is slower to first token, while
Default omits the field and lets the vendor decide. Use generous max tokens (≥ 4096) at high effort
because thinking tokens count against that budget. **Escalate low → high** raises Low to High for
screenshot/coding questions when enabled. The Behavioral/Coding presets in Settings patch the
active profile's effort and answer style only — never the model.

`num_ctx` cannot be set through the OpenAI-compatible endpoint, so `scripts\run-app.ps1` exports
`OLLAMA_CONTEXT_LENGTH=16384` before starting Ollama. Recommended context: **≥ 8–16k**. A smaller
window silently truncates the system prompt, résumé and screenshot image tokens from the front,
which degrades or breaks answers. If Ollama is already running, restart it (or set the variable
before launching it) for the change to apply.

### Screenshots and vision

When a screenshot is attached (vision enabled), the prompt switches to an image protocol: a coding
problem gets at most a 1–2 sentence spoken approach and then the complete, runnable solution in one
code block in the configured **Code language** (Python default; JavaScript, Java or C++), with no
follow-up questions; a multiple-choice image gets the selected letter + text first, then one short
line of justification. Other images fall back to the normal spoken-answer style. Vision is
app-wide ("Active model supports images" in *Settings → Models*), not per-profile. On Gemini,
keep that profile's **Max tokens** at 4096+ because thinking tokens count against the same budget
(1024 truncates at high reasoning effort).

When the composer's question-type chip resolves to **Coding** (explicitly or via Auto) and an image
is attached, the image prompt asks for a JSON object instead of prose. A clean parse renders a
structured card — approach, numbered steps, the code block with its own Copy button, and time/space
complexity chips. If the model ignores the contract or the JSON is malformed, the raw answer text is
shown unchanged.

### Question types and answer preview

The composer chip defaults to **Auto**, which guesses Coding from algorithm/data-structure phrasing
and Behavioral from story-style phrasing; anything else resolves to Other. An explicit choice skips
the guess. The resolved type drives three things:

- **Coding** escalates effort for that ask (the same low → high path as *Escalate on code*, without
  changing the saved profile) and selects the JSON screenshot contract above.
- **Behavioral** forces the STAR rule for that ask even when the saved style has STAR off.
- Everything else keeps the saved answer style.

*Settings → Answer style → Answer preview* renders static Behavioral and Coding samples shaped by
length, format, tone, STAR and filler settings. It is assembled locally — no model call, no tokens,
no network. The Behavioral/Coding preset buttons also refresh the preview because they patch the
same draft.

## Speech-to-text

Microphone capture ("You") is optional and off by default. When it is enabled, Windows shows the
mic-in-use indicator while microphone capture is on — this is the OS privacy indicator, not a leak
from the app.

### Local (whisper.cpp)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-whisper.ps1
```

The setup script downloads a whisper.cpp Windows build plus the `large-v3-turbo` q5 model into
`tools\`, then the start script serves it at `http://127.0.0.1:8080/inference` (the app default).

VRAM notes (RTX 3070 8 GB): `large-v3-turbo` (~1 GB) + `qwen2.5vl:7b` (~5 GB) fit together.
If you hit VRAM pressure, switch the model to `ggml-medium-q5_0.bin` or start whisper with
`-NoGpu` (CPU).

### Paid API

Settings → Speech-to-text → backend `OpenAI-compatible`, endpoint
`https://api.openai.com/v1/audio/transcriptions`, API key, model `whisper-1`.

## Verify the engines

```powershell
# Start the local stack + app (starts whisper-server if needed)
powershell -ExecutionPolicy Bypass -File .\scripts\run-app.ps1

# Or test each endpoint independently
powershell -ExecutionPolicy Bypass -File .\scripts\test-engines.ps1
```

### Capture self-test

*Settings → Capture self-test* checks OS-level capture exclusion
(`WDA_EXCLUDEFROMCAPTURE`), that the overlay is absent from window-picker enumeration (matched by
its own native window handle rather than by title), that the screenshot path still returns an
image, that loopback audio is captured with no picker, and that the microphone opens (optional).
The overlay is also hidden from pickers and Alt-Tab via the toolbar (`WS_EX_TOOLWINDOW`) window
style. The self-test runs fully invisibly: no window is shown or moved, no picker or prompt
appears, and the PowerShell affinity probe is hidden and times out after 5 seconds.

> Windows 10 may briefly show the capture border during the screen-capture check.

## Hotkeys

| Combo | Action |
|---|---|
| Ctrl+Shift+↑ | Move overlay up |
| Ctrl+Shift+↓ | Move overlay down |
| Ctrl+Shift+← | Move overlay left |
| Ctrl+Shift+→ | Move overlay right |
| Ctrl+Shift+Enter | Answer |
| Ctrl+Alt+Enter | Screenshot |
| Ctrl+Alt+R | Region screenshot |
| Ctrl+Shift+Space | Focus chat |
| Ctrl+Shift+H | Hide |
| Ctrl+Shift+F9 | Toggle click-through |
| Ctrl+Shift+M | Move overlay to the cursor's monitor |

Shortcuts are system-wide: they fire while any application is focused. If a shortcut seems to do
nothing, another app probably owns it — *Settings → Hotkeys* marks those with
**⚠️ in use by another app**.

## How it works (short)

```
mic ──────► getUserMedia ──► AudioWorklet framer / VAD (ScriptProcessor fallback if the worklet module fails to load) ─┐
system ───► getDisplayMedia (loopback) ───────┤─► 16 kHz WAV chunks ─► ASR endpoint
                                              │
transcript ──► question heuristic / hotkey ───┴─► chat endpoint (streaming) ─► overlay
```

The overlay is hidden from screen sharing/recording with Electron's
`setContentProtection(true)` (Windows: `WDA_EXCLUDEFROMCAPTURE`), skips the taskbar, floats at
`screen-saver` level, and uses `disable-features=CalculateNativeWinOcclusion` so Chromium keeps
painting when occluded.

## Build an installer

```powershell
npm run dist
```

Outputs in `dist\`:

- `parakeet-clone-setup-<version>.exe` — NSIS installer (per-user, no admin required)
- `parakeet-clone-setup-<version>.zip` — portable build (unzip and run the exe)

The installer is unsigned, so Windows SmartScreen may warn on first run. There is no code signing
by design for private distribution. The build enables
Electron fuses: cookie encryption, "only load app from asar" and no Node CLI inspect arguments.
Embedded asar integrity is left off because electron-builder does not embed the required
integrity metadata.

`tools\` is excluded from packaging; engines are installed per machine (or use a paid API).

## Meeting detection & tray

Enable *Settings → Meetings → Detect meeting apps*. Every 15 seconds the app checks running
process names and window titles (Zoom, Google Meet, Microsoft Teams, Webex, FaceTime, Discord) and
shows a tray notification when either signal matches; browser meetings are found by title. The log
prints which signal fired.

Auto-start is deliberately conservative: it fires only when a meeting app process is running or
when the window title is a meeting-specific browser/Teams/Zoom title (for example
*Meet - abc - Google Chrome*, *Zoom Workplace*, *Microsoft Teams Meeting*). Generic title matches
such as a bare *Meet - abc* or *FaceTime* only notify — a tab or app can sit open all day. The
notification balloon is behind *Settings → Meetings → Show meeting-detection notification* and is
visible (on the shared screen) only while that setting is enabled.

## Updates (optional)

Host electron-builder artifacts (installer + `latest.yml`) on any static HTTPS location, then set
*Settings → Updates → Feed URL*. The app checks on launch and every 6 hours, downloads in the
background, and shows a "Restart & install" banner when ready. Only point the feed at HTTPS
endpoints you control — updates are not signature-verified.


## Known v1 limitations

- Partials are produced by re-decoding the growing utterance on the whisper server every ~800 ms
  (toggle in Settings). With Auto Answer + "early trigger" (on by default), an answer starts as
  soon as a partial reads as a complete question; otherwise it fires at end-of-utterance. The merge
  grace window applies to final-triggered auto-answers only — early-trigger asks stay immediate by
  design.
- Speaker labels come from the audio channel (You/Them), not diarization.
- Questions that arrive mid-answer are queued (max 2, newest kept); older overflow is dropped.
- PDF import extracts embedded text only; scanned/image-only PDFs need OCR outside the app.
- Job-link fetching is best-effort: LinkedIn and other login-walled pages usually refuse it — paste
  the description manually.
- Attachments are consumed and cleared after sending, so regenerating an old answer cannot include
  the original screenshots.
- Question detection is a heuristic (question mark / interrogative start / known interview
  phrases); Auto Answer is off by default.
- Screenshot answers require a vision-capable model (enable "Active model supports images" in
  Settings → Models).
- Windows only.

## Legal / use

This is an independent implementation. Don't copy another product's code, prompts, or assets.
Recording/transcribing calls and using an assistant may violate the rules of the platform, school,
or employer involved — you are responsible for how you use it.
