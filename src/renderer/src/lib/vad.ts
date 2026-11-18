// Pure VAD / segmentation state machine extracted from AudioEngine. The engine
// keeps WebAudio plumbing, WAV encoding and callbacks; this module owns every
// per-batch decision (adaptive floor, preroll, speech onset, partials, silence
// and max-chunk flushes, gap injection, level EMA).

export const VAD_DEFAULTS = {
  silenceMs: 900,
  maxChunkMs: 12_000,
  prerollMs: 900,
  minSpeechMs: 500,
  partialIntervalMs: 800,
  minPartialSpeechMs: 900,
  sampleRate: 16_000,
  // Effective threshold floor: max(noiseFloorMin, noiseFloor * multiplier).
  noiseFloorMin: 0.008,
  noiseFloorInitial: 0.004,
  noiseFloorMultiplier: 2.5,
  // 300 ms of 16 kHz audio: tolerate callback jitter, bridge longer stalls.
  gapToleranceSamples: 4800,
  // Never synthesize more than 2 s in one burst; resync instead.
  maxInjectedGapSamples: 32_000,
  // Worklet frames are accumulated back to the legacy 4096-sample cadence.
  batchSamples: 4096,
  minChunkRms: 0.01,
  levelIntervalMs: 250
} as const

// Fixed algorithm constants (not operator settings).
const LEVEL_EMA_ALPHA = 0.3
const NOISE_FLOOR_ALPHA = 0.02
const VOICED_STREAK_THRESHOLD = 2

export interface VadParams {
  silenceMs?: number
  maxChunkMs?: number
  prerollMs?: number
  minSpeechMs?: number
  partialIntervalMs?: number
  minPartialSpeechMs?: number
  sampleRate?: number
  noiseFloorMin?: number
  noiseFloorInitial?: number
  noiseFloorMultiplier?: number
  gapToleranceSamples?: number
  maxInjectedGapSamples?: number
  /** 0 disables frame accumulation (every feed is processed immediately). */
  batchSamples?: number
  minChunkRms?: number
  levelIntervalMs?: number
  /** Defaults to Date.now; the engine injects performance.now. */
  now?: () => number
}

type ResolvedVadParams = Required<Omit<VadParams, 'now'>>

export type VadDecision =
  | { type: 'level'; rms: number }
  | { type: 'speech-start'; uid: number }
  | { type: 'partial'; samples: Float32Array; uid: number }
  | { type: 'final'; samples: Float32Array; uid: number; durationMs: number }

interface VadState {
  frames: Float32Array[]
  preBuffer: Float32Array[]
  preBufferSamples: number
  voicedStreak: number
  speechMs: number
  lastVoiceAt: number
  speaking: boolean
  noiseFloor: number
  utteranceId: number
  lastPartialAt: number
  clockStart: number
  expectedSamples: number
  receivedSamples: number
  levelAvg: number
  lastLevelAt: number
  batches: number
  pendingFrames: Float32Array[]
  pendingSamples: number
}

function concatFrames(frames: Float32Array[], length?: number): Float32Array {
  const total = length ?? frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

export class VadMachine {
  private readonly params: ResolvedVadParams
  private readonly now: () => number
  private state: VadState

  constructor(params: VadParams = {}) {
    this.params = {
      silenceMs: params.silenceMs ?? VAD_DEFAULTS.silenceMs,
      maxChunkMs: params.maxChunkMs ?? VAD_DEFAULTS.maxChunkMs,
      prerollMs: params.prerollMs ?? VAD_DEFAULTS.prerollMs,
      minSpeechMs: params.minSpeechMs ?? VAD_DEFAULTS.minSpeechMs,
      partialIntervalMs: params.partialIntervalMs ?? VAD_DEFAULTS.partialIntervalMs,
      minPartialSpeechMs: params.minPartialSpeechMs ?? VAD_DEFAULTS.minPartialSpeechMs,
      sampleRate: params.sampleRate ?? VAD_DEFAULTS.sampleRate,
      noiseFloorMin: params.noiseFloorMin ?? VAD_DEFAULTS.noiseFloorMin,
      noiseFloorInitial: params.noiseFloorInitial ?? VAD_DEFAULTS.noiseFloorInitial,
      noiseFloorMultiplier: params.noiseFloorMultiplier ?? VAD_DEFAULTS.noiseFloorMultiplier,
      gapToleranceSamples: params.gapToleranceSamples ?? VAD_DEFAULTS.gapToleranceSamples,
      maxInjectedGapSamples:
        params.maxInjectedGapSamples ?? VAD_DEFAULTS.maxInjectedGapSamples,
      batchSamples: params.batchSamples ?? VAD_DEFAULTS.batchSamples,
      minChunkRms: params.minChunkRms ?? VAD_DEFAULTS.minChunkRms,
      levelIntervalMs: params.levelIntervalMs ?? VAD_DEFAULTS.levelIntervalMs
    }
    this.now = params.now ?? Date.now
    this.state = this.initialState()
  }

  /** Adaptive noise floor (not clamped; the effective threshold is). */
  get adaptiveNoiseFloor(): number {
    return this.state.noiseFloor
  }

  /** Current voiced/unvoiced decision threshold. */
  get voicedThreshold(): number {
    return Math.max(
      this.params.noiseFloorMin,
      this.state.noiseFloor * this.params.noiseFloorMultiplier
    )
  }

  /**
   * Feed captured samples. Worklet frames are accumulated to `batchSamples`
   * before processing, matching the legacy ScriptProcessor cadence. `now` is
   * the arrival timestamp of the triggering batch (performance.now in the
   * engine).
   */
  feed(batch: Float32Array, now: number = this.now()): VadDecision[] {
    const decisions: VadDecision[] = []
    if (batch.length === 0) return decisions

    if (this.params.batchSamples > 0) {
      this.state.pendingFrames.push(batch)
      this.state.pendingSamples += batch.length
      if (this.state.pendingSamples < this.params.batchSamples) return decisions
      const combined = concatFrames(this.state.pendingFrames, this.state.pendingSamples)
      this.state.pendingFrames = []
      this.state.pendingSamples = 0
      this.processBatch(combined, now, decisions)
      return decisions
    }

    this.processBatch(batch, now, decisions)
    return decisions
  }

  /**
   * Clear conversational state for the next capture session. Mirrors the old
   * engine stop(): the uid counter and adaptive noise floor survive so uids
   * stay monotonic and the learned floor is reused.
   */
  reset(): void {
    this.state = this.initialState(this.state.utteranceId, this.state.noiseFloor)
  }

  /** Samples/batches since start, for lifecycle diagnostics. */
  getStats(): { batches: number; samples: number; durationMs: number } {
    return {
      batches: this.state.batches,
      samples: this.state.receivedSamples,
      durationMs: Math.round((this.state.receivedSamples / this.params.sampleRate) * 1000)
    }
  }

  private initialState(
    utteranceId = 0,
    noiseFloor = this.params.noiseFloorInitial
  ): VadState {
    return {
      frames: [],
      preBuffer: [],
      preBufferSamples: 0,
      voicedStreak: 0,
      speechMs: 0,
      lastVoiceAt: 0,
      speaking: false,
      noiseFloor,
      utteranceId,
      lastPartialAt: 0,
      clockStart: 0,
      expectedSamples: 0,
      receivedSamples: 0,
      levelAvg: 0,
      lastLevelAt: 0,
      batches: 0,
      pendingFrames: [],
      pendingSamples: 0
    }
  }

  private processBatch(data: Float32Array, now: number, decisions: VadDecision[]): void {
    this.state.batches += 1
    if (!this.state.clockStart) {
      // Anchor to the start of the first processed buffer so its samples are
      // not a gap.
      this.state.clockStart = now - (data.length / this.params.sampleRate) * 1000
    }
    this.state.expectedSamples = Math.round(
      ((now - this.state.clockStart) / 1000) * this.params.sampleRate
    )
    this.state.receivedSamples += data.length
    const gap = this.state.expectedSamples - this.state.receivedSamples
    if (gap > this.params.gapToleranceSamples) {
      this.state.receivedSamples = this.state.expectedSamples
      // Zero samples only matter inside an utterance (silence/VAD timing).
      // When idle, or after a multi-second stall, just resync the baseline.
      if (this.state.speaking && gap <= this.params.maxInjectedGapSamples) {
        this.processSamples(new Float32Array(gap), now, decisions)
      }
    }
    this.processSamples(data, now, decisions)
  }

  private processSamples(data: Float32Array, now: number, decisions: VadDecision[]): void {
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    this.state.levelAvg = this.state.levelAvg * (1 - LEVEL_EMA_ALPHA) + rms * LEVEL_EMA_ALPHA
    // ~4 updates/sec, matching the 4096-sample batch cadence; the UI adds
    // peak-hold so a silent Them channel is visible immediately.
    if (now - this.state.lastLevelAt >= this.params.levelIntervalMs) {
      this.state.lastLevelAt = now
      decisions.push({ type: 'level', rms: this.state.levelAvg })
    }

    const voiced = rms > this.voicedThreshold

    if (!this.state.speaking) {
      this.state.preBuffer.push(new Float32Array(data))
      this.state.preBufferSamples += data.length
      while (
        this.state.preBufferSamples / this.params.sampleRate > this.params.prerollMs / 1000 &&
        this.state.preBuffer.length > 0
      ) {
        const dropped = this.state.preBuffer.shift()
        this.state.preBufferSamples -= dropped?.length ?? 0
      }
      if (voiced) {
        this.state.voicedStreak += 1
        if (this.state.voicedStreak >= VOICED_STREAK_THRESHOLD) {
          this.state.speaking = true
          this.state.utteranceId += 1
          this.state.lastPartialAt = now
          this.state.frames = this.state.preBuffer
          this.state.speechMs = (this.state.preBufferSamples / this.params.sampleRate) * 1000
          this.state.preBuffer = []
          this.state.preBufferSamples = 0
          this.state.lastVoiceAt = now
          decisions.push({ type: 'speech-start', uid: this.state.utteranceId })
        }
      } else {
        this.state.voicedStreak = 0
        this.state.noiseFloor =
          this.state.noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA
      }
      return
    }

    this.push(data)
    if (voiced) this.state.lastVoiceAt = now

    if (
      this.state.speechMs >= this.params.minPartialSpeechMs &&
      now - this.state.lastPartialAt >= this.params.partialIntervalMs
    ) {
      this.state.lastPartialAt = now
      if (this.state.frames.length > 0) {
        decisions.push({
          type: 'partial',
          samples: concatFrames(this.state.frames),
          uid: this.state.utteranceId
        })
      }
    }

    if (this.state.speechMs >= this.params.maxChunkMs) {
      this.flush(true, now, decisions)
    } else if (now - this.state.lastVoiceAt > this.params.silenceMs) {
      this.flush(false, now, decisions)
    }
  }

  private push(data: Float32Array): void {
    this.state.frames.push(new Float32Array(data))
    this.state.speechMs += (data.length / this.params.sampleRate) * 1000
  }

  private flush(keepSpeaking: boolean, now: number, decisions: VadDecision[]): void {
    const frames = this.state.frames
    const speechMs = this.state.speechMs
    this.state.frames = []
    this.state.speechMs = 0
    this.state.speaking = keepSpeaking
    this.state.voicedStreak = 0
    if (!keepSpeaking) this.state.lastVoiceAt = 0
    if (speechMs < this.params.minSpeechMs || frames.length === 0) return

    let sum = 0
    let count = 0
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        sum += frame[i] * frame[i]
        count++
      }
    }
    const chunkRms = count > 0 ? Math.sqrt(sum / count) : 0
    if (chunkRms < this.params.minChunkRms) return

    const uid = this.state.utteranceId
    decisions.push({
      type: 'final',
      samples: concatFrames(frames),
      uid,
      durationMs: speechMs
    })
    if (keepSpeaking) {
      this.state.utteranceId += 1
      this.state.lastPartialAt = now
    }
  }
}
