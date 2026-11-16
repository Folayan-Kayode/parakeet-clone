Parakeet Clone v1.3.1 — testing, hardening, and code organization (no behavior changes).

## New
- Test suite — 268 automated tests over the pure core (SSRF guards, prompt builder, profile migration, answer parsing, meeting detection, session export), wired into CI.
- Update feeds must use https:// — plain-http feed URLs are now rejected before the updater is configured.
- Dev-mode privacy — interview content no longer reaches stdout (résumé, answers, transcripts); set PC_VERBOSE=1 to restore debug logging.

## Internal
Pure logic extracted into tested modules (prompt builder, question heuristics, answer preview, session export, SSRF/LLM-body, meeting detection); Settings and History split into their own components. No UI or behavior changes.

## Assets
- parakeet-clone-setup-1.3.1.exe — per-user installer (no admin needed)
- parakeet-clone-setup-1.3.1.exe.blockmap — for future delta updates
- parakeet-clone-setup-1.3.1.zip — portable build

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings. Scripts ship inside the installer at resources\app.asar.unpacked\scripts; start-parakeet.ps1 starts whisper-server before the app.
