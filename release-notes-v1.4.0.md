Parakeet Clone v1.4.0 — smarter question capture, tested core, release polish.

## New
- Follow-up merging — a pause mid-question no longer splits it into two answers: qualifying questions are held briefly (Merge follow-ups wait, default 2 s) and follow-up speech is merged in; merged questions are re-transcribed from the combined audio, fixing both truncation and mis-transcription. Set the wait to 0 for the old behavior.
- Silence split is now a setting (Silence split, 600–1500 ms, default 900 — applies on next Start).
- Short trailing fragments (e.g. a stray "how do") no longer trigger auto-answers.
- Live audio-level meters for the You and Them channels — silence during a call is visible in real time, with a one-time "No system audio detected" hint and loud capture-failure toasts.
- Session integrity: a failed session save now keeps the transcript on screen for retry; transcription stragglers can no longer leak across sessions; saved sessions are complete (answers no longer capped, parsed answer cards persisted).
- Payload-aware response deadline — no response within 60 s + 5 s per attached image (max 120 s) aborts with an actionable message instead of a fixed 15 s cut; multi-image asks on slow models survive.
- Update feeds must use https:// — plain-http feed URLs are rejected before the updater is configured.
- Dev-mode privacy — interview content no longer reaches stdout (résumé, answers, transcripts); set PC_VERBOSE=1 to restore debug logging.
- Regenerate on a coded answer keeps the structured JSON contract.
- Dark chip menus for model and question-type switching, now keyboard-navigable.

## Internal
- Test suite — 347 automated tests over the pure core (SSRF guards, prompt builder, profile migration, answer parsing, meeting detection, session export, coalescing state machine, VAD segmentation, clamps), wired into CI.
- Pure logic extracted into tested modules; Settings and History split into their own components. Internal refactor — no UI redesign.

## Assets
- parakeet-clone-setup-1.4.0.exe — per-user installer (no admin needed)
- parakeet-clone-setup-1.4.0.exe.blockmap — for future delta updates
- parakeet-clone-setup-1.4.0.zip — portable build

## Local engines
Engines are installed per machine: run scripts/setup-local.ps1 and install Ollama, or configure a paid API in Settings. Scripts ship inside the installer at resources\app.asar.unpacked\scripts; start-parakeet.ps1 starts whisper-server before the app.
