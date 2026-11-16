export type Speaker = 'You' | 'Them'

const TARGET_SAMPLE_RATE = 16000
const SILENCE_MS = 900
const MIN_SPEECH_MS = 500
const MAX_CHUNK_MS = 12000
const MAX_PREROLL_MS = 900
const PARTIAL_INTERVAL_MS = 800
const MIN_PARTIAL_SPEECH_MS = 900
// 300 ms at 16 kHz: tolerate normal callback jitter, bridge longer stalls.
const GAP_TOLERANCE_SAMPLES = 4800
// Never synthesize more than 2 s in one burst; resync instead (see process()).
const MAX_INJECTED_GAP_SAMPLES = 32000
// Capture frames: 160 samples = 10 ms at the 16 kHz context.
const WORKLET_FRAME_SAMPLES = 160
const WORKLET_PROCESSOR_NAME = 'parakeet-vad-framer'
// Samples per callback on the legacy path. Worklet frames are accumulated back
// up to this size so the VAD cadence stays identical to the ScriptProcessor era.
const SCRIPT_PROCESSOR_FRAME = 4096

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The worklet is a static asset, not bundled: electron-vite copies
// renderer/public/* to the renderer output root. Resolving it against
// location.href yields http://localhost:5173/vad-worklet.js in dev (vite serves
// public/ at the dev server root) and file://.../out/renderer/vad-worklet.js
// when packaged (main loads index.html from that same directory via loadFile,
// and Electron's file loader reads inside the asar).
function workletModuleUrl(): string {
  return new URL('vad-worklet.js', window.location.href).href
}

/**
 * Worklet preference from config.json through the existing renderer -> main
 * channel. Tolerant: only an explicit `false` disables the worklet, so a
 * missing key, a hand-edited non-boolean or a failed IPC read keeps the modern
 * path (and the automatic fallback still guards a real load failure).
 */
async function workletEnabled(): Promise<boolean> {
  try {
    const { config } = await window.api.getConfig()
    return config.audio?.useWorklet !== false
  } catch (err) {
    console.warn('[audio] worklet config read failed; assuming enabled:', err)
    return true
  }
}

/** Loads the framer module into one context. Logs the outcome either way. */
async function loadWorkletModule(ctx: BaseAudioContext): Promise<boolean> {
  if (!(await workletEnabled())) {
    console.log(
      '[audio] worklet module unavailable — falling back to ScriptProcessor: disabled by config'
    )
    return false
  }
  try {
    await ctx.audioWorklet.addModule(workletModuleUrl())
    console.log('[audio] worklet module loaded')
    return true
  } catch (err) {
    console.log(
      `[audio] worklet module unavailable — falling back to ScriptProcessor: ${errorText(err)}`
    )
    return false
  }
}

// The engine is only built after getUserMedia succeeds, so without this probe a
// device-less boot would never report the worklet outcome. One suspended
// context is opened and closed immediately; nothing is connected or played.
async function probeWorkletAtBoot(): Promise<void> {
  try {
    const probe = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    try {
      await loadWorkletModule(probe)
    } finally {
      void probe.close()
    }
  } catch (err) {
    console.log(
      `[audio] worklet module unavailable — falling back to ScriptProcessor: ${errorText(err)}`
    )
  }
}

function encodeWav(chunks: Float32Array[]): ArrayBuffer {
  let length = 0
  for (const c of chunks) length += c.length
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, length * 2, true)

  let offset = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private worklet: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private stream: MediaStream | null = null
  private frames: Float32Array[] = []
  // Worklet frames awaiting a full legacy-sized batch (see handleWorkletFrame).
  private pendingFrames: Float32Array[] = []
  private pendingSamples = 0
  private preBuffer: Float32Array[] = []
  private preBufferSamples = 0
  private voicedStreak = 0
  private speechMs = 0
  private lastVoiceAt = 0
  private speaking = false
  private noiseFloor = 0.004

  private utteranceId = 0
  private lastPartialAt = 0

  // Wall-clock sample accounting. Any lossy delivery path (ScriptProcessor
  // callbacks paused under main-thread jank, or a jammed worklet port) can drop
  // samples; bounded silence (the SilencePacer idea) keeps VAD and silence
  // timing true to elapsed time instead of stretching an utterance. With the
  // AudioWorklet path this is a safety net that should almost never trigger.
  private clockStart = 0
  private expectedSamples = 0
  private receivedSamples = 0

  constructor(
    private readonly speaker: Speaker,
    private readonly onSegment: (speaker: Speaker, wav: ArrayBuffer, utteranceId: number) => void,
    private readonly onLevel: (level: number) => void,
    private readonly onPartial: (speaker: Speaker, wav: ArrayBuffer, utteranceId: number) => void,
    private readonly silenceMs: number = SILENCE_MS
  ) {}

  async startWithStream(stream: MediaStream): Promise<void> {
    this.stop()
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error(`${this.speaker}: no audio track available`)
    this.stream = stream

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
    // Context first, then the module: a load failure only downgrades this
    // stream, and the compile finishes before the first buffer arrives.
    const workletReady = await loadWorkletModule(ctx)
    await ctx.resume()
    const source = ctx.createMediaStreamSource(new MediaStream([track]))
    const sink = ctx.createGain()
    sink.gain.value = 0

    let worklet: AudioWorkletNode | null = null
    if (workletReady) {
      try {
        const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { frameSize: WORKLET_FRAME_SAMPLES }
        })
        node.port.onmessage = (event: MessageEvent): void => {
          this.handleWorkletFrame(event.data as Float32Array)
        }
        source.connect(node)
        node.connect(sink)
        worklet = node
      } catch (err) {
        console.log(
          `[audio] worklet module unavailable — falling back to ScriptProcessor: ${errorText(err)}`
        )
        worklet = null
      }
    }

    if (!worklet) {
      // Legacy safety hatch: untouched behaviour, just reachable only when the
      // module could not be loaded (or config.audio.useWorklet === false).
      const processor = ctx.createScriptProcessor(SCRIPT_PROCESSOR_FRAME, 1, 1)

      processor.onaudioprocess = (event): void => {
        this.process(event.inputBuffer.getChannelData(0))
      }

      source.connect(processor)
      processor.connect(sink)
      this.processor = processor
    }

    // Silent tail on both paths: the destination pulls the graph, the worklet
    // writes no output samples and the sink gain is 0.
    sink.connect(ctx.destination)

    this.ctx = ctx
    this.source = source
    this.worklet = worklet
    this.sink = sink
  }

  /**
   * Worklet frames arrive as 10 ms transferables. Batching back up to the
   * legacy 4096-sample callbacks keeps VAD cadence, partial timing and gap
   * accounting bit-for-bit identical to the ScriptProcessor path (process()
   * itself is size-agnostic, but batching avoids 25x more VAD updates).
   */
  private handleWorkletFrame(frame: Float32Array): void {
    if (frame.length === 0) return
    this.pendingFrames.push(frame)
    this.pendingSamples += frame.length
    if (this.pendingSamples < SCRIPT_PROCESSOR_FRAME) return

    const batch = new Float32Array(this.pendingSamples)
    let offset = 0
    for (const part of this.pendingFrames) {
      batch.set(part, offset)
      offset += part.length
    }
    this.pendingFrames = []
    this.pendingSamples = 0
    this.process(batch)
  }

  private push(data: Float32Array): void {
    this.frames.push(new Float32Array(data))
    this.speechMs += (data.length / TARGET_SAMPLE_RATE) * 1000
  }

  private process(data: Float32Array): void {
    const now = performance.now()
    if (!this.clockStart) {
      // Anchor to the start of the first buffer so its samples are not a gap.
      this.clockStart = now - (data.length / TARGET_SAMPLE_RATE) * 1000
    }
    this.expectedSamples = Math.round(
      ((now - this.clockStart) / 1000) * TARGET_SAMPLE_RATE
    )
    this.receivedSamples += data.length
    const gap = this.expectedSamples - this.receivedSamples
    if (gap > GAP_TOLERANCE_SAMPLES) {
      this.receivedSamples = this.expectedSamples
      // Zero samples only matter inside an utterance (silence/VAD timing).
      // When idle, or after a multi-second stall, just resync the baseline.
      if (this.speaking && gap <= MAX_INJECTED_GAP_SAMPLES) {
        this.feed(new Float32Array(gap), now)
      }
    }
    this.feed(data, now)
  }

  private feed(data: Float32Array, now: number): void {
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    this.onLevel(rms)

    const threshold = Math.max(0.008, this.noiseFloor * 2.5)
    const voiced = rms > threshold

    if (!this.speaking) {
      this.preBuffer.push(new Float32Array(data))
      this.preBufferSamples += data.length
      while (
        this.preBufferSamples / TARGET_SAMPLE_RATE > MAX_PREROLL_MS / 1000 &&
        this.preBuffer.length > 0
      ) {
        const dropped = this.preBuffer.shift()
        this.preBufferSamples -= dropped?.length ?? 0
      }
      if (voiced) {
        this.voicedStreak += 1
        if (this.voicedStreak >= 2) {
          this.speaking = true
          this.utteranceId += 1
          this.lastPartialAt = now
          this.frames = this.preBuffer
          this.speechMs = (this.preBufferSamples / TARGET_SAMPLE_RATE) * 1000
          this.preBuffer = []
          this.preBufferSamples = 0
          this.lastVoiceAt = now
        }
      } else {
        this.voicedStreak = 0
        this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02
      }
      return
    }

    this.push(data)
    if (voiced) this.lastVoiceAt = now

    if (
      this.speechMs >= MIN_PARTIAL_SPEECH_MS &&
      now - this.lastPartialAt >= PARTIAL_INTERVAL_MS
    ) {
      this.lastPartialAt = now
      if (this.frames.length > 0) {
        this.onPartial(this.speaker, encodeWav(this.frames), this.utteranceId)
      }
    }

    if (this.speechMs >= MAX_CHUNK_MS) {
      this.flush(true)
    } else if (now - this.lastVoiceAt > this.silenceMs) {
      this.flush(false)
    }
  }

  private flush(keepSpeaking: boolean): void {
    const frames = this.frames
    const speechMs = this.speechMs
    this.frames = []
    this.speechMs = 0
    this.speaking = keepSpeaking
    this.voicedStreak = 0
    if (!keepSpeaking) this.lastVoiceAt = 0
    if (speechMs < MIN_SPEECH_MS || frames.length === 0) return

    let sum = 0
    let count = 0
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        sum += frame[i] * frame[i]
        count++
      }
    }
    const chunkRms = count > 0 ? Math.sqrt(sum / count) : 0
    if (chunkRms < 0.01) return

    const wav = encodeWav(frames)
    const uid = this.utteranceId
    this.onSegment(this.speaker, wav, uid)
    if (keepSpeaking) {
      this.utteranceId += 1
      this.lastPartialAt = performance.now()
    }
  }

  stop(): void {
    try {
      if (this.worklet) {
        // Clear the audio-thread buffer, mute further posts, then detach.
        this.worklet.port.postMessage('reset')
        this.worklet.port.postMessage('stop')
        this.worklet.port.onmessage = null
        this.worklet.disconnect()
      }
      this.processor?.disconnect()
      this.source?.disconnect()
      this.sink?.disconnect()
      this.stream?.getTracks().forEach((t) => t.stop())
      void this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.ctx = null
    this.source = null
    this.processor = null
    this.worklet = null
    this.sink = null
    this.stream = null
    this.frames = []
    this.pendingFrames = []
    this.pendingSamples = 0
    this.preBuffer = []
    this.preBufferSamples = 0
    this.speechMs = 0
    this.voicedStreak = 0
    this.speaking = false
    this.clockStart = 0
    this.expectedSamples = 0
    this.receivedSamples = 0
  }
}

export async function startMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    }
  })
}

export async function startSystemStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'Windows loopback audio was not provided. Make sure an output device is active, then try again.'
    )
  }
  const audioOnly = new MediaStream(audioTracks)
  stream.getVideoTracks().forEach((t) => t.stop())
  return audioOnly
}

// Runs when the renderer bundle loads (App imports this module at startup), so
// the module outcome is logged even if no microphone or loopback device exists.
void probeWorkletAtBoot()
