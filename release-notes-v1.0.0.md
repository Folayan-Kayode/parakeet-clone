Parakeet Clone v1.0.0 — local-first interview copilot overlay for Windows (independent implementation).

## Highlights
- Stealth overlay: screen-capture protection (WDA_EXCLUDEFROMCAPTURE), click-through, always-on-top, tray
- Windows system-audio loopback + optional mic capture; streaming partials; Whisper prompt carry-over
- Local whisper.cpp + Ollama stack, or any OpenAI-compatible chat/transcription endpoints
- Early Auto Answer (Beta), chat-style Q/A thread, Regenerate, follow-up context
- Resume/job context and answer style controls (length, format, tone, STAR, filler)
- Session history with paired Q/A and delete (single / all)
- Multi-monitor handling, global hotkeys, meeting detection, optional auto-update
- Electron fuses hardened; NSIS installer + portable zip

## Assets
- Parakeet Clone Setup 1.0.0.exe — per-user installer (no admin needed)
- Parakeet Clone-1.0.0-win.zip — portable build
- .blockmap — for future delta updates

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings.
