Parakeet Clone v1.4.1 — the update lifecycle is now visible.

## Fixes
- Clicking Check now no longer goes silent: download progress (Downloading… N%) is shown in Settings, download failures surface as an error banner instead of dying quietly, and a ready banner (app-wide, inside the protected overlay) appears with an Install button when the update is downloaded. Installing is blocked during a live session (End first) with a matching backend guard.
- Note: v1.4.0 may have already downloaded silently in the background — this release makes that state visible and installable.

## Assets
- parakeet-clone-setup-1.4.1.exe — per-user installer (no admin needed)
- parakeet-clone-setup-1.4.1.exe.blockmap — for future delta updates
- parakeet-clone-setup-1.4.1.zip — portable build

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings. Scripts ship inside the installer at resources\app.asar.unpacked\scripts; start-parakeet.ps1 starts whisper-server before the app.
