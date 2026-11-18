import { useEffect, useRef, useState } from 'react'
import { MODEL_CATALOG } from '../../shared/types'
import type {
  AppConfig,
  CaptureTestCheck,
  CaptureTestReport,
  EffortSetting,
  HotkeyInfo,
  ModelCatalogEntry,
  ModelProfile,
  SpeedBadge
} from '../../shared/types'
import { buildAnswerPreview } from '../../shared/answer-preview'
import { INTERACTION_BOUNDS, LLM_BOUNDS, clampInteractionValue } from '../../shared/clamps'

function formatAccelerator(accelerator: string): string {
  return accelerator.replace(/CommandOrControl/g, 'Ctrl')
}

// Presets apply effort to the active profile; the legacy field is mirrored so
// configs migrated later keep the same intent.
function presetLlm(cfg: AppConfig, effort: 'low' | 'high'): AppConfig['llm'] {
  return {
    ...cfg.llm,
    reasoningEffort: effort,
    profiles: cfg.llm.profiles.map((profile) =>
      profile.id === cfg.llm.activeProfileId ? { ...profile, effort } : profile
    )
  }
}

// Settings presets only patch the draft: the user still reviews and saves.
// The model is intentionally never changed here.
function applyPreset(cfg: AppConfig, preset: 'behavioral' | 'coding'): AppConfig {
  if (preset === 'behavioral') {
    return {
      ...cfg,
      llm: presetLlm(cfg, 'low'),
      answer: {
        ...cfg.answer,
        length: 'balanced',
        format: 'paragraph',
        tone: 'casual',
        star: true,
        fillerWords: true
      }
    }
  }
  return {
    ...cfg,
    llm: presetLlm(cfg, 'high'),
    answer: {
      ...cfg.answer,
      length: 'concise',
      format: 'bullets',
      tone: 'simple',
      star: false,
      fillerWords: false
    }
  }
}

export interface SettingsViewProps {
  config: AppConfig
  /** Speed-badge label map shared with the live-view model chip. */
  badgeLabel: (badge: SpeedBadge) => string
  /** New profile id; the app-level id generator is passed in. */
  newId: () => string
  /** App-level error normalizer for the capture test details. */
  errorMessage: (err: unknown) => string
  /** Renderer-side capture checks, run from the existing app scope. */
  runCaptureChecks: () => Promise<CaptureTestCheck[]>
  onToast: (message: string) => void
  onSave: (draft: AppConfig) => Promise<void>
  onBack: () => void
  onClear: () => void
}

export default function SettingsView({
  config,
  badgeLabel,
  newId,
  errorMessage,
  runCaptureChecks,
  onToast,
  onSave,
  onBack,
  onClear
}: SettingsViewProps) {
  const [draft, setDraft] = useState<AppConfig>(config)
  const [captureTest, setCaptureTest] = useState<CaptureTestReport | null>(null)
  const [captureTesting, setCaptureTesting] = useState(false)
  const [hotkeys, setHotkeys] = useState<HotkeyInfo[]>([])

  // Background config writes (hotkeys, click-through, meeting toggles) must not
  // clobber edits in progress: only re-sync when the draft is clean.
  const draftRef = useRef(draft)
  const syncedConfigRef = useRef(config)
  draftRef.current = draft

  useEffect(() => {
    if (JSON.stringify(draftRef.current) !== JSON.stringify(syncedConfigRef.current)) return
    syncedConfigRef.current = config
    setDraft(config)
  }, [config])

  useEffect(() => {
    void window.api
      .getHotkeys()
      .then(setHotkeys)
      .catch(() => undefined)
  }, [])

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  const setLlm = <K extends keyof AppConfig['llm']>(key: K, value: AppConfig['llm'][K]): void => {
    setDraft((prev) => ({ ...prev, llm: { ...prev.llm, [key]: value } }))
  }
  const setAsr = <K extends keyof AppConfig['asr']>(key: K, value: AppConfig['asr'][K]): void => {
    setDraft((prev) => ({ ...prev, asr: { ...prev.asr, [key]: value } }))
  }
  const setInteraction = <K extends keyof AppConfig['interaction']>(
    key: K,
    value: AppConfig['interaction'][K]
  ): void => {
    setDraft((prev) => ({ ...prev, interaction: { ...prev.interaction, [key]: value } }))
  }
  const setAnswer = <K extends keyof AppConfig['answer']>(
    key: K,
    value: AppConfig['answer'][K]
  ): void => {
    setDraft((prev) => ({ ...prev, answer: { ...prev.answer, [key]: value } }))
  }
  const setMeetings = (key: keyof AppConfig['meetings'], value: boolean): void => {
    setDraft((prev) => ({ ...prev, meetings: { ...prev.meetings, [key]: value } }))
  }

  // --- Model profile editing (saved with the rest of the draft) ------------
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({})
  const [pickingModel, setPickingModel] = useState(false)
  // Remember the last numeric value while a field is omitted, so toggling Omit
  // restores it instead of a hard-coded default.
  const [lastNumbers, setLastNumbers] = useState<
    Record<string, { temperature?: number; maxTokens?: number }>
  >({})

  const updateProfile = (id: string, patch: Partial<ModelProfile>): void => {
    setDraft((prev) => ({
      ...prev,
      llm: {
        ...prev.llm,
        profiles: prev.llm.profiles.map((profile) =>
          profile.id === id ? { ...profile, ...patch } : profile
        )
      }
    }))
  }

  const rememberNumber = (
    id: string,
    key: 'temperature' | 'maxTokens',
    value: number
  ): void => {
    setLastNumbers((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        ...(key === 'temperature' ? { temperature: value } : { maxTokens: value })
      }
    }))
  }

  const setProfileNumber = (
    id: string,
    key: 'temperature' | 'maxTokens',
    value: number | null
  ): void => {
    if (value != null) rememberNumber(id, key, value)
    if (key === 'temperature') updateProfile(id, { temperature: value })
    else updateProfile(id, { maxTokens: value })
  }

  const toggleOmit = (
    profile: ModelProfile,
    key: 'temperature' | 'maxTokens',
    omit: boolean
  ): void => {
    if (!omit) {
      const fallback =
        key === 'temperature' ? LLM_BOUNDS.temperature.fallback : LLM_BOUNDS.maxTokens.fallback
      setProfileNumber(profile.id, key, lastNumbers[profile.id]?.[key] ?? fallback)
      return
    }
    const current = key === 'temperature' ? profile.temperature : profile.maxTokens
    if (current != null) rememberNumber(profile.id, key, current)
    updateProfile(
      profile.id,
      key === 'temperature' ? { temperature: null } : { maxTokens: null }
    )
  }

  const addProfile = (profile: ModelProfile): void => {
    setDraft((prev) => ({
      ...prev,
      llm: { ...prev.llm, profiles: [...prev.llm.profiles, profile] }
    }))
    setPickingModel(false)
  }

  const addCatalogProfile = (entry: ModelCatalogEntry): void => {
    addProfile({
      id: newId(),
      label: entry.label,
      badge: entry.badge,
      baseUrl: entry.baseUrl,
      apiKey: '',
      model: entry.model,
      // Anthropic 5.x rejects temperature: the catalog flag decides.
      temperature: entry.supportsTemperature ? 0.2 : null,
      maxTokens: 4096,
      effort: entry.effort,
      escalateOnCode: false
    })
  }

  const addCustomProfile = (): void => {
    addProfile({
      id: newId(),
      label: 'Custom / OpenRouter',
      badge: 'recommended',
      baseUrl: '',
      apiKey: '',
      model: '',
      // Blank fields stay omitted until the user chooses values.
      temperature: null,
      maxTokens: null,
      effort: 'default',
      escalateOnCode: false
    })
  }

  const removeProfile = (id: string): void => {
    setDraft((prev) => {
      if (prev.llm.profiles.length <= 1) return prev
      const profiles = prev.llm.profiles.filter((profile) => profile.id !== id)
      return {
        ...prev,
        llm: {
          ...prev.llm,
          profiles,
          activeProfileId:
            prev.llm.activeProfileId === id ? profiles[0].id : prev.llm.activeProfileId
        }
      }
    })
  }

  const activateProfile = (id: string): void => {
    setDraft((prev) => ({ ...prev, llm: { ...prev.llm, activeProfileId: id } }))
  }

  const runCaptureTest = async (): Promise<void> => {
    setCaptureTesting(true)
    try {
      const rendererChecks = await runCaptureChecks()
      let mainChecks: CaptureTestCheck[] = []
      let ranAt = Date.now()
      try {
        const report = await window.api.testCapture()
        mainChecks = report.checks
        ranAt = report.ranAt
      } catch (err) {
        mainChecks = [
          {
            id: 'main-test',
            label: 'Main-process checks',
            pass: false,
            detail: errorMessage(err)
          }
        ]
      }
      setCaptureTest({ checks: [...mainChecks, ...rendererChecks], ranAt })
    } catch (err) {
      setCaptureTest({
        checks: [
          {
            id: 'capture-test',
            label: 'Capture self-test',
            pass: false,
            detail: errorMessage(err)
          }
        ],
        ranAt: Date.now()
      })
    } finally {
      setCaptureTesting(false)
    }
  }

  const preview = buildAnswerPreview(draft.answer)

  return (
    <div className="settings">
      <div className="settings-scroll">
        <h3>Interview presets</h3>
        <div className="row gap">
          <button
            className="btn"
            onClick={() => setDraft((prev) => applyPreset(prev, 'behavioral'))}
          >
            Behavioral
          </button>
          <button
            className="btn"
            onClick={() => setDraft((prev) => applyPreset(prev, 'coding'))}
          >
            Coding
          </button>
        </div>
        <p className="hint small">Presets change effort and answer style only — the model is not changed.</p>

        <h3>Models</h3>
        <p className="hint small">
          Each profile is a full endpoint identity (base URL, key, model, sampling). The active
          profile is used for new questions; switch it from the live-view header — no restart, and
          it never interrupts a streaming answer.
        </p>
        {draft.llm.profiles.map((profile) => {
          const isActive = profile.id === draft.llm.activeProfileId
          const showAdvanced = Boolean(advanced[profile.id])
          return (
            <div className={`profile-card${isActive ? ' active' : ''}`} key={profile.id}>
              <div className="profile-head">
                <input
                  className="profile-label"
                  value={profile.label}
                  aria-label="Profile label"
                  onChange={(e) => updateProfile(profile.id, { label: e.target.value })}
                />
                <span className={`badge ${profile.badge}`}>{badgeLabel(profile.badge)}</span>
                <button
                  className="btn tiny"
                  title={isActive ? 'This profile answers new questions' : 'Use this profile'}
                  disabled={isActive}
                  onClick={() => activateProfile(profile.id)}
                >
                  {isActive ? 'Active' : 'Use'}
                </button>
              </div>
              <span className="mono profile-model">{profile.model || '(no model id yet)'}</span>
              <label className="field">
                <span>Model ID</span>
                <input
                  value={profile.model}
                  onChange={(e) => updateProfile(profile.id, { model: e.target.value })}
                  placeholder="gemini-3.8-flash"
                />
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  value={profile.apiKey}
                  onChange={(e) => updateProfile(profile.id, { apiKey: e.target.value })}
                  placeholder="sk-…"
                />
              </label>
              <button
                className="btn tiny ghost"
                onClick={() => setAdvanced((prev) => ({ ...prev, [profile.id]: !showAdvanced }))}
              >
                {showAdvanced ? 'Advanced ▲' : 'Advanced ▼'}
              </button>
              {showAdvanced && (
                <div className="profile-advanced">
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      value={profile.baseUrl}
                      onChange={(e) => updateProfile(profile.id, { baseUrl: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <div className="grid2">
                    <label className="field">
                      <span>Temperature (0–1)</span>
                      <input
                        type="number"
                        step="0.05"
                        min={LLM_BOUNDS.temperature.min}
                        max={LLM_BOUNDS.temperature.max}
                        placeholder="omitted"
                        value={profile.temperature ?? ''}
                        onChange={(e) => {
                          if (e.target.value === '') {
                            toggleOmit(profile, 'temperature', true)
                            return
                          }
                          const parsed = Number(e.target.value)
                          if (Number.isFinite(parsed)) {
                            setProfileNumber(profile.id, 'temperature', parsed)
                          }
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Max tokens (128–8192)</span>
                      <input
                        type="number"
                        step="64"
                        min={LLM_BOUNDS.maxTokens.min}
                        max={LLM_BOUNDS.maxTokens.max}
                        placeholder="omitted"
                        value={profile.maxTokens ?? ''}
                        onChange={(e) => {
                          if (e.target.value === '') {
                            toggleOmit(profile, 'maxTokens', true)
                            return
                          }
                          const parsed = Number(e.target.value)
                          if (Number.isFinite(parsed)) {
                            setProfileNumber(profile.id, 'maxTokens', parsed)
                          }
                        }}
                      />
                    </label>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profile.temperature === null}
                      onChange={(e) => toggleOmit(profile, 'temperature', e.target.checked)}
                    />
                    <span>Omit temperature — let the vendor pick its default</span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profile.maxTokens === null}
                      onChange={(e) => toggleOmit(profile, 'maxTokens', e.target.checked)}
                    />
                    <span>Omit max tokens</span>
                  </label>
                  <label className="field">
                    <span>Reasoning effort</span>
                    <select
                      value={profile.effort}
                      onChange={(e) =>
                        updateProfile(profile.id, { effort: e.target.value as EffortSetting })
                      }
                    >
                      <option value="default">Default — omit (vendor decides)</option>
                      <option value="low">Low — fast</option>
                      <option value="medium">Medium — balanced</option>
                      <option value="high">High — hard questions (slower)</option>
                    </select>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profile.escalateOnCode}
                      onChange={(e) =>
                        updateProfile(profile.id, { escalateOnCode: e.target.checked })
                      }
                    />
                    <span>Escalate low → high for coding/screenshot questions</span>
                  </label>
                  <button
                    className="btn tiny danger"
                    disabled={draft.llm.profiles.length <= 1}
                    onClick={() => removeProfile(profile.id)}
                  >
                    Delete profile
                  </button>
                </div>
              )}
            </div>
          )
        })}
        <div className="row gap">
          <button className="btn" onClick={() => setPickingModel((open) => !open)}>
            {pickingModel ? 'Close catalog' : 'Add model'}
          </button>
          <span className="hint small">
            Badges show expected speed. Anthropic 5.x profiles omit temperature and effort.
          </span>
        </div>
        {pickingModel && (
          <div className="catalog">
            {MODEL_CATALOG.map((entry) => (
              <button
                key={entry.model}
                className="catalog-item"
                onClick={() => addCatalogProfile(entry)}
              >
                <span className={`badge ${entry.badge}`}>{badgeLabel(entry.badge)}</span>
                <span className="catalog-label">{entry.label}</span>
                <span className="catalog-vendor">{entry.vendor}</span>
                <span className="mono catalog-model">{entry.model}</span>
              </button>
            ))}
            <button className="catalog-item custom" onClick={addCustomProfile}>
              <span className="catalog-label">Custom / OpenRouter…</span>
              <span className="catalog-vendor">manual — blank fields</span>
            </button>
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.llm.vision}
            onChange={(e) => setLlm('vision', e.target.checked)}
          />
          <span>Active model supports images (needed for screenshots in answers)</span>
        </label>
        <p className="hint small">
          Vision models only, e.g. Gemini Flash, GPT-6.1, qwen2.5vl. Vision is app-wide, not
          per-profile.
        </p>
        <label className="field">
          <span>Code language</span>
          <select
            value={draft.answer.codeLanguage}
            onChange={(e) =>
              setAnswer('codeLanguage', e.target.value as AppConfig['answer']['codeLanguage'])
            }
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
            <option value="java">Java</option>
            <option value="cpp">C++</option>
          </select>
        </label>

        <h3>Answer style</h3>
        <div className="grid2">
          <label className="field">
            <span>Length</span>
            <select
              value={draft.answer.length}
              onChange={(e) => setAnswer('length', e.target.value as AppConfig['answer']['length'])}
            >
              <option value="concise">Concise</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
          <label className="field">
            <span>Format</span>
            <select
              value={draft.answer.format}
              onChange={(e) => setAnswer('format', e.target.value as AppConfig['answer']['format'])}
            >
              <option value="bullets">Bullets</option>
              <option value="balanced">Balanced</option>
              <option value="paragraph">Paragraph</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Tone</span>
          <select
            value={draft.answer.tone}
            onChange={(e) => setAnswer('tone', e.target.value as AppConfig['answer']['tone'])}
          >
            <option value="formal">Formal</option>
            <option value="casual">Casual</option>
            <option value="simple">Simple</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.answer.star}
            onChange={(e) => setAnswer('star', e.target.checked)}
          />
          <span>Use STAR structure for behavioral answers</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.answer.fillerWords}
            onChange={(e) => setAnswer('fillerWords', e.target.checked)}
          />
          <span>Allow natural filler words (sounds less scripted)</span>
        </label>

        <div className="answer-preview">
          <div className="answer-preview-head">
            <span className="label">Answer preview</span>
            <span className="hint small">Static sample — no model call</span>
          </div>
          <div className="answer-preview-sample">
            <span className="label">Behavioral</span>
            <pre className="answer-preview-body">{preview.behavioral}</pre>
          </div>
          <div className="answer-preview-sample">
            <span className="label">Coding · {draft.answer.codeLanguage}</span>
            <pre className="answer-preview-body code">{preview.coding}</pre>
          </div>
        </div>

        <h3>Speech-to-text</h3>
        <label className="field">
          <span>Backend</span>
          <select
            value={draft.asr.mode}
            onChange={(e) => setAsr('mode', e.target.value as AppConfig['asr']['mode'])}
          >
            <option value="whispercpp">whisper.cpp server (local)</option>
            <option value="openai">OpenAI-compatible transcription</option>
          </select>
        </label>
        <label className="field">
          <span>Endpoint</span>
          <input
            value={draft.asr.url}
            onChange={(e) => setAsr('url', e.target.value)}
            placeholder="http://127.0.0.1:8080/inference"
          />
        </label>
        <label className="field">
          <span>API key (optional)</span>
          <input
            type="password"
            value={draft.asr.apiKey}
            onChange={(e) => setAsr('apiKey', e.target.value)}
          />
        </label>
        <label className="field">
          <span>Model (OpenAI-compatible mode)</span>
          <input
            value={draft.asr.model}
            onChange={(e) => setAsr('model', e.target.value)}
            placeholder="whisper-1"
          />
        </label>

        <h3>Overlay</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.privateMode}
            onChange={(e) => set('privateMode', e.target.checked)}
          />
          <span>Screen-capture protection (window excluded from sharing/recording)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.clickThrough}
            onChange={(e) => set('clickThrough', e.target.checked)}
          />
          <span>Click-through (mouse passes to apps below; Ctrl+Shift+F9 toggles)</span>
        </label>
        <label className="field">
          <span>Panel opacity: {Math.round(draft.panelOpacity * 100)}%</span>
          <input
            type="range"
            min="0.3"
            max="1"
            step="0.02"
            value={draft.panelOpacity}
            onChange={(e) => set('panelOpacity', Number(e.target.value))}
          />
        </label>

        <h3>Display</h3>
        <label className="field">
          <span>Start on</span>
          <select
            value={draft.window.screenMode}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                window: { ...prev.window, screenMode: e.target.value as 'primary' | 'cursor' }
              }))
            }
          >
            <option value="primary">Primary monitor</option>
            <option value="cursor">Monitor under cursor</option>
          </select>
        </label>
        <div className="row gap">
          <button
            className="btn"
            onClick={async () => {
              await window.api.moveToCursorDisplay()
              onToast('Moved to the cursor screen')
            }}
          >
            Move to cursor screen
          </button>
          <span className="hint small">Hotkey: Ctrl+Shift+M</span>
        </div>

        <h3>Hotkeys</h3>
        <div className="hotkey-list">
          {hotkeys.map((hotkey) => (
            <div className="hotkey-row" key={hotkey.accelerator}>
              <span className="hotkey-keys">
                {formatAccelerator(hotkey.accelerator)
                  .split('+')
                  .map((part) => (
                    <kbd key={part}>{part}</kbd>
                  ))}
              </span>
              <span className="hotkey-desc">
                {hotkey.description}
                {!hotkey.registered && (
                  <span className="hotkey-warn"> ⚠️ in use by another app</span>
                )}
              </span>
            </div>
          ))}
        </div>

        <h3>Meetings</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.meetings.detect}
            onChange={(e) => setMeetings('detect', e.target.checked)}
          />
          <span>
            Detect meeting apps (Zoom, Teams, Webex, Discord, Slack, Chime, Lark, WhatsApp)
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.meetings.autoStart}
            onChange={(e) => setMeetings('autoStart', e.target.checked)}
          />
          <span>Start listening automatically when a meeting is detected</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.meetings.balloon}
            onChange={(e) => setMeetings('balloon', e.target.checked)}
          />
          <span>Show meeting-detection notification (visible during screen shares)</span>
        </label>

        <h3>Updates (optional)</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.updates.enabled}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                updates: { ...prev.updates, enabled: e.target.checked }
              }))
            }
          />
          <span>Check for updates from a published feed</span>
        </label>
        <label className="field">
          <span>Feed URL</span>
          <input
            value={draft.updates.feedUrl}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, updates: { ...prev.updates, feedUrl: e.target.value } }))
            }
            placeholder="https://example.com/updates/"
          />
        </label>
        <div className="row gap">
          <button
            className="btn"
            onClick={async () => {
              const result = await window.api.checkForUpdates()
              onToast(
                result.ok
                  ? `Update check: ${result.version ?? 'up to date'}`
                  : `Update check failed: ${result.error ?? 'unknown error'}`
              )
            }}
          >
            Check now
          </button>
          <span className="hint small">
            Feed must host electron-builder artifacts (latest.yml + installer).
          </span>
        </div>

        <h3>Connections</h3>
        <div className="row gap">
          <button
            className="btn"
            onClick={async () => {
              const result = await window.api.testLlm()
              onToast(
                result.ok ? `LLM OK: ${result.text}` : `LLM failed: ${result.error ?? 'unknown'}`
              )
            }}
          >
            Test LLM
          </button>
          <button
            className="btn"
            onClick={async () => {
              const result = await window.api.testAsr()
              onToast(result.ok ? 'Speech endpoint OK' : `Speech failed: ${result.error ?? 'unknown'}`)
            }}
          >
            Test speech
          </button>
        </div>

        <h3>Capture self-test</h3>
        <div className="row gap">
          <button className="btn" disabled={captureTesting} onClick={() => void runCaptureTest()}>
            {captureTesting ? 'Testing…' : 'Run capture self-test'}
          </button>
          <span className="hint small">Runs invisibly — no window, picker or prompt appears.</span>
        </div>
        {captureTest && (
          <div className="test-results">
            {captureTest.checks.map((check) => (
              <div className="test-check" key={check.id}>
                <span
                  className={`test-mark ${
                    check.pass === true ? 'pass' : check.pass === false ? 'fail' : 'skip'
                  }`}
                >
                  {check.pass === true ? '✓' : check.pass === false ? '✗' : '–'}
                </span>
                <span className="test-check-body">
                  <span className="test-check-label">{check.label}</span>
                  <span className="test-check-detail">{check.detail}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <h3>Behavior</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.earlyAnswer}
            onChange={(e) => setInteraction('earlyAnswer', e.target.checked)}
          />
          <span>Answer as soon as a question is recognized (early trigger; requires Auto Answer)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.streamingPartials}
            onChange={(e) => setInteraction('streamingPartials', e.target.checked)}
          />
          <span>Live partial transcripts (updates while the person is still speaking; extra GPU use)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.transcribeMic}
            onChange={(e) => setInteraction('transcribeMic', e.target.checked)}
          />
          <span>
            Transcribe microphone ("You") — off by default; the interviewer is captured from the
            system-audio loopback
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.autoScroll}
            onChange={(e) => setInteraction('autoScroll', e.target.checked)}
          />
          <span>Auto-scroll answers (follow new content; pauses while you scroll up)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.interaction.autoAnswer}
            onChange={(e) => setInteraction('autoAnswer', e.target.checked)}
          />
          <span>Auto Answer (beta) — answer detected questions automatically</span>
        </label>
        <label className="field">
          <span>Auto-answer cooldown (ms)</span>
          <input
            type="number"
            step="500"
            min={INTERACTION_BOUNDS.answerCooldownMs.min}
            max={INTERACTION_BOUNDS.answerCooldownMs.max}
            value={draft.interaction.answerCooldownMs}
            onChange={(e) => {
              // Clamp in the draft so the field never shows a value main will
              // silently clamp on save (shared bounds).
              setInteraction(
                'answerCooldownMs',
                clampInteractionValue('answerCooldownMs', Number(e.target.value))
              )
            }}
          />
        </label>
        <label className="field">
          <span>Merge follow-ups before auto-answer (ms)</span>
          <input
            type="number"
            step="100"
            min={INTERACTION_BOUNDS.mergeFollowUpsMs.min}
            max={INTERACTION_BOUNDS.mergeFollowUpsMs.max}
            value={draft.interaction.mergeFollowUpsMs}
            onChange={(e) => {
              setInteraction(
                'mergeFollowUpsMs',
                clampInteractionValue('mergeFollowUpsMs', Number(e.target.value))
              )
            }}
          />
        </label>
        <p className="hint small">
          Wait before auto-answering so follow-up speech merges into one question. 0 = answer
          immediately.
        </p>
        <label className="field">
          <span>Silence split (ms)</span>
          <input
            type="number"
            step="50"
            min={INTERACTION_BOUNDS.silenceSplitMs.min}
            max={INTERACTION_BOUNDS.silenceSplitMs.max}
            value={draft.interaction.silenceSplitMs}
            onChange={(e) => {
              setInteraction(
                'silenceSplitMs',
                clampInteractionValue('silenceSplitMs', Number(e.target.value))
              )
            }}
          />
        </label>
        <p className="hint small">
          How much silence splits an utterance (lower merges short pauses; applies the next time
          you press Start).
        </p>

        <div className="row gap">
          <button className="btn primary" onClick={() => void onSave(draft)}>
            Save
          </button>
          <button className="btn" onClick={onBack}>
            Back
          </button>
          <button className="btn ghost danger" onClick={onClear}>
            Clear transcript
          </button>
        </div>
      </div>
    </div>
  )
}
