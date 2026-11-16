Parakeet Clone v1.2.0 — multi-vendor model profiles, structured coding answers and session-first hardening for the local-first interview overlay (independent implementation).

## Highlights
- Multi-vendor model profiles with a live switcher: Gemini, OpenAI GPT-6.x and Claude 5.x in one catalog with speed badges; per-profile base URL/keys; Anthropic quirks handled automatically (temperature/effort omitted)
- Question-Type chip (Auto-detect or manual: Behavioral/Coding/System design/…) that picks the profile and answer style per question
- JSON answer contract for coding screenshots: structured answer cards (approach, key steps, code with Copy, complexity) with raw-text fallback
- Sticky region capture (Ctrl+Alt+R) — crop a remembered screen region, fully silent
- Save-before-quit: closing/Alt+F4 mid-session saves the transcript first; 2-minute autosave recoverable from History
- Session persistence: screenshots and uncaptured questions now saved; Markdown export includes structured answers
- Transcription vocabulary injection (company + jargon terms into the whisper prompt)
- PDF import (local extraction, documents never leave the machine) and paste-job-link import
- AudioWorklet capture pipeline (jank-proof sample flow, ScriptProcessor fallback); audio gap accounting
- Interview presets (Behavioral/Coding) with a zero-network Answer Preview
- Stop button for streaming answers; reasoning-effort folded into model profiles
- Meeting detection via window titles (catches browser meetings) + opt-in notification (off by default; visible during shares)
- Self-test, self-healing hardening: ASR timeout + recovery banner, corrupt-config backup, raised context caps, audio-worklet self-test hooks

## Assets
- parakeet-clone-setup-1.2.0.exe — per-user installer (no admin needed)
- parakeet-clone-setup-1.2.0.exe.blockmap — for future delta updates
- parakeet-clone-setup-1.2.0.zip — portable build

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings. Scripts now ship inside the installer at resources\app.asar.unpacked\scripts; start-parakeet.ps1 starts whisper-server before the app.
