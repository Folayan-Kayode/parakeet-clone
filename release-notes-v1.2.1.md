Parakeet Clone v1.2.1 — patch release.

## Fixes
- Capture self-test and system-audio ("Them") capture could fail with Permission denied — the tightened permission handler now also grants the `display-capture` permission type that renderer `getDisplayMedia` requires (regression introduced by the v1.2.0 security hardening).

## Assets
- parakeet-clone-setup-1.2.1.exe — per-user installer (no admin needed)
- parakeet-clone-setup-1.2.1.exe.blockmap — for future delta updates
- parakeet-clone-setup-1.2.1.zip — portable build

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings. Scripts ship inside the installer at resources\app.asar.unpacked\scripts; start-parakeet.ps1 starts whisper-server before the app.
