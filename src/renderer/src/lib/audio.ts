import { VAD_DEFAULTS, VadMachine, type VadDecision } from './vad'

export type Speaker = 'You' | 'Them'

const TARGET_SAMPLE_RATE = 16000
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
  private readonly machine: VadMachine

  constructor(
    private readonly speaker: Speaker,
    private readonly onSegment: (speaker: Speaker, wav: ArrayBuffer, utteranceId: number) => void,
    private readonly onLevel: (speaker: Speaker, rms: number) => void,
    private readonly onPartial: (speaker: Speaker, wav: ArrayBuffer, utteranceId: number) => void,
    private readonly silenceMs: number = VAD_DEFAULTS.silenceMs,
    private readonly onWarning?: (message: string) => void
  ) {
    this.machine = new VadMachine({
      silenceMs: this.silenceMs,
      maxChunkMs: VAD_DEFAULTS.maxChunkMs,
      prerollMs: VAD_DEFAULTS.prerollMs,
      minSpeechMs: VAD_DEFAULTS.minSpeechMs,
      partialIntervalMs: VAD_DEFAULTS.partialIntervalMs,
      minPartialSpeechMs: VAD_DEFAULTS.minPartialSpeechMs,
      sampleRate: TARGET_SAMPLE_RATE,
      noiseFloorMin: VAD_DEFAULTS.noiseFloorMin,
      noiseFloorInitial: VAD_DEFAULTS.noiseFloorInitial,
      gapToleranceSamples: VAD_DEFAULTS.gapToleranceSamples,
      maxInjectedGapSamples: VAD_DEFAULTS.maxInjectedGapSamples,
      batchSamples: SCRIPT_PROCESSOR_FRAME,
      minChunkRms: VAD_DEFAULTS.minChunkRms,
      now: () => performance.now()
    })
  }

  async startWithStream(stream: MediaStream): Promise<void> {
    this.stop()
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error(`${this.speaker}: no audio track available`)
    this.stream = stream

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
    // Assign immediately: any later await/throw must be closable via stop(),
    // which only knows about this.ctx.
    this.ctx = ctx
    // Context first, then the module: a load failure only downgrades this
    // stream, and the compile finishes before the first buffer arrives.
    const workletReady = await loadWorkletModule(ctx)
    if (!workletReady) {
      this.onWarning?.('Audio worklet unavailable — using legacy capture (still works)')
    }
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
        this.onWarning?.('Audio worklet unavailable — using legacy capture (still works)')
        worklet = null
      }
    }

    if (!worklet) {
      // Legacy safety hatch: untouched behaviour, just reachable only when the
      // module could not be loaded (or config.audio.useWorklet === false).
      const processor = ctx.createScriptProcessor(SCRIPT_PROCESSOR_FRAME, 1, 1)

      processor.onaudioprocess = (event): void => {
        this.consume(this.machine.feed(event.inputBuffer.getChannelData(0)))
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
   * Worklet frames arrive as 10 ms transferables. The VAD machine accumulates
   * them back to the legacy 4096-sample cadence, so VAD decisions, partial
   * timing and gap accounting match the ScriptProcessor path.
   */
  private handleWorkletFrame(frame: Float32Array): void {
    this.consume(this.machine.feed(frame))
  }

  /** Encode and deliver machine decisions in the order they were produced. */
  private consume(decisions: VadDecision[]): void {
    for (const decision of decisions) {
      if (decision.type === 'level') {
        this.onLevel(this.speaker, decision.rms)
      } else if (decision.type === 'partial') {
        this.onPartial(this.speaker, encodeWav([decision.samples]), decision.uid)
      } else if (decision.type === 'final') {
        this.onSegment(this.speaker, encodeWav([decision.samples]), decision.uid)
      }
      // speech-start has no engine callback.
    }
  }

  /** Samples/batches since start, for lifecycle diagnostics. */
  getStats(): { batches: number; samples: number; durationMs: number } {
    return this.machine.getStats()
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
    this.machine.reset()
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
