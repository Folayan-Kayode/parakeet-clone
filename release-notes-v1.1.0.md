Parakeet Clone v1.1.0 — capture, reasoning and export upgrades for the local-first interview overlay (independent implementation).

## Highlights
- Capture self-test with five checks: screen capture, OS capture exclusion, window-picker hiding, loopback audio and microphone access
- Follow-up question queue: questions that arrive mid-answer are queued (max 2, 60 s TTL) and asked once the current answer finishes
- Sticky-bottom auto-scroll toggle
- Resizable overlay window with persisted size
- Vision coding protocol plus code language setting (Python, JavaScript, Java, C++)
- Reasoning effort setting with automatic coding-question escalation and Behavioral/Coding presets
- Region capture: drag a rectangle on a protected preview, then capture it with Ctrl+Alt+R
- Data-driven hotkey guide with runtime registration status
- 429/5xx retry/backoff before the first token
- Session export to Markdown

## Assets
- Parakeet Clone Setup 1.1.0.exe — per-user installer (no admin needed)
- Parakeet Clone-1.1.0-win.zip — portable build
- .blockmap — for future delta updates

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings.
