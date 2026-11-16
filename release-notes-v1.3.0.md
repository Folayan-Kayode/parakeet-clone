Parakeet Clone v1.3.0 — smarter question capture.

## New
- Follow-up merging — a pause mid-question no longer splits it into two answers: qualifying questions are held briefly (Merge follow-ups wait, default 2 s) and any follow-up speech is merged in; merged questions are re-transcribed from the combined audio, so both the truncation and the mis-transcription disappear. Set the wait to 0 for the old behavior.
- Silence split is now a setting (Silence split, 600–1500 ms, default 900 — applies on next Start).
- Very short trailing fragments (e.g. a stray "how do") no longer trigger auto-answers.

## Assets
- parakeet-clone-setup-1.3.0.exe — per-user installer (no admin needed)
- parakeet-clone-setup-1.3.0.exe.blockmap — for future delta updates
- parakeet-clone-setup-1.3.0.zip — portable build

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings. Scripts ship inside the installer at resources\app.asar.unpacked\scripts; start-parakeet.ps1 starts whisper-server before the app.
