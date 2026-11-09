# Parakeet Clone

Local-first interview copilot overlay for Windows. Independent reimplementation built from a
static analysis of a similar Electron app's *techniques* — no code, assets, prompts, or backends
are copied. Runs your own speech-to-text and your own LLM (local or API).

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
- Segments speech with a lightweight VAD and transcribes each chunk
- Streams answers from any OpenAI-compatible chat endpoint (Ollama, LM Studio, OpenRouter, OpenAI…)
- Screenshot attachment for vision-capable models
- Saved region screenshots (Ctrl+Alt+R): drag a rectangle on an in-overlay, capture-protected preview
- Résumé / job-description / background context (pasted or loaded from `.txt`), used as the
  factual source for answers — the model is instructed never to invent metrics
- Answer style controls: length (concise/balanced/detailed), format (bullets/balanced/paragraph),
  tone (formal/casual/simple), STAR structure, optional filler words
- Single-instance lock (launching a second copy focuses the existing overlay)
- Follow-up aware answers (last two answers are kept in context) and a Regenerate button
- Chat-style thread: every answer appears directly beneath the question it answers, including
  answers started early while the question is still being spoken
- Session history browser (read-only transcripts and answers, paired Q/A) with per-session and
  delete-all actions (two-click confirm), plus Markdown export per session
- Transcript accuracy: Whisper prompt carry-over between chunks (names/wording stay consistent),
  0.9 s end-of-utterance splitting, and hallucination/echo filtering
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

## Providers

### Answers — Ollama (recommended local)

```powershell
winget install Ollama.Ollama        # system install
ollama pull qwen2.5vl:7b            # vision-capable: reads screenshots
```

Default settings already point at `http://127.0.0.1:11434/v1`, model `qwen2.5vl:7b`.
For a lighter/faster option: `qwen2.5:3b-instruct`.

Settings → Answer engine also exposes **Temperature** (0–1, default 0.2) and **Max tokens**
(128–8192, default 4096); interview answers usually work best at temperature 0.1–0.3.

**Reasoning effort** (Low/Medium/High, default Low): Low is conversational and fast for live
interviews, Medium is balanced, and High suits hard algorithmic questions — it is slower to first
token, so use generous max tokens (≥ 4096) because thinking tokens count against that budget.
**Auto-escalate** raises Low to High for screenshot/coding questions when enabled, and the
Behavioral/Coding presets in Settings patch effort and answer style only — never the model.

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
line of justification. Other images fall back to the normal spoken-answer style. On Gemini,
**Max tokens** defaults to 4096 because thinking tokens count against the same budget (1024
truncates at high reasoning effort).

### Answers — paid API

Settings → Answer engine: set Base URL (e.g. `https://api.openai.com/v1`), API key, and model
(e.g. `gpt-4.1-mini`). Any OpenAI-compatible `/chat/completions` endpoint works.

### Speech-to-text — local (whisper.cpp)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-whisper.ps1
```

The setup script downloads a whisper.cpp Windows build plus the `large-v3-turbo` q5 model into
`tools\`, then the start script serves it at `http://127.0.0.1:8080/inference` (the app default).

VRAM notes (RTX 3070 8 GB): `large-v3-turbo` (~1 GB) + `qwen2.5vl:7b` (~5 GB) fit together.
If you hit VRAM pressure, switch the model to `ggml-medium-q5_0.bin` or start whisper with
`-NoGpu` (CPU).

### Speech-to-text — paid API

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
| Ctrl+H | Hide |
| Ctrl+Shift+F9 | Toggle click-through |
| Ctrl+Shift+M | Move overlay to the cursor's monitor |

Shortcuts are system-wide: they fire while any application is focused. If a shortcut seems to do
nothing, another app probably owns it — *Settings → Hotkeys* marks those with
**⚠️ in use by another app**.

## How it works (short)

```
mic ──────► getUserMedia ──► AudioWorklet/VAD ─┐
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

- `Parakeet Clone Setup <version>.exe` — NSIS installer (per-user, no admin required)
- `Parakeet Clone-<version>-win.zip` — portable build (unzip and run the exe)

The installer is unsigned, so Windows SmartScreen may warn on first run. The build enables
Electron fuses: cookie encryption and "only load app from asar". Embedded asar integrity is left
off because electron-builder does not embed the required integrity metadata.

`tools\` is excluded from packaging; engines are installed per machine (or use a paid API).

## Meeting detection & tray

Enable *Settings → Meetings → Detect meeting apps*. Every 5 seconds the app checks running
process names against known meeting clients and shows a tray notification when one starts.
Optionally enable auto-start to begin listening automatically. Detection is process-based (no
window-title inspection), so browser-only meetings (e.g., Google Meet in Chrome) are not detected.

## Updates (optional)

Host electron-builder artifacts (installer + `latest.yml`) on any static HTTPS location, then set
*Settings → Updates → Feed URL*. The app checks on launch and every 6 hours, downloads in the
background, and shows a "Restart & install" banner when ready.


## Known v1 limitations

- Partials are produced by re-decoding the growing utterance on the whisper server every ~800 ms
  (toggle in Settings). With Auto Answer + "early trigger" (on by default), an answer starts as
  soon as a partial reads as a complete question; otherwise it fires at end-of-utterance.
- Speaker labels come from the audio channel (You/Them), not diarization.
- Questions that arrive mid-answer are queued (max 2, newest kept); older overflow is dropped.
- Attachments are consumed and cleared after sending, so regenerating an old answer cannot include
  the original screenshots.
- Question detection is a heuristic (question mark / interrogative start / known interview
  phrases); Auto Answer is off by default.
- Screenshot answers require a vision-capable model (enable "Model supports images" in Settings).
- Windows only.

## Legal / use

This is an independent implementation. Don't copy another product's code, prompts, or assets.
Recording/transcribing calls and using an assistant may violate the rules of the platform, school,
or employer involved — you are responsible for how you use it.
