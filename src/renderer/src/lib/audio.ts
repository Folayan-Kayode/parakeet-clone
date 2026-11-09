export type Speaker = 'You' | 'Them'

const TARGET_SAMPLE_RATE = 16000
const SILENCE_MS = 900
const MIN_SPEECH_MS = 500
const MAX_CHUNK_MS = 12000
const MAX_PREROLL_MS = 900
const PARTIAL_INTERVAL_MS = 800
const MIN_PARTIAL_SPEECH_MS = 900

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
  private sink: GainNode | null = null
  private stream: MediaStream | null = null
  private frames: Float32Array[] = []
  private preBuffer: Float32Array[] = []
  private preBufferSamples = 0
  private voicedStreak = 0
  private speechMs = 0
  private lastVoiceAt = 0
  private speaking = false
  private noiseFloor = 0.004

  private utteranceId = 0
  private lastPartialAt = 0

  constructor(
    private readonly speaker: Speaker,
    private readonly onSegment: (speaker: Speaker, wav: ArrayBuffer, utteranceId: number) => void,
    private readonly onLevel: (level: number) => void,
    private readonly onPartial: (speaker: Speaker, wav: ArrayBuffer, utteranceId: number) => void
  ) {}

  async startWithStream(stream: MediaStream): Promise<void> {
    this.stop()
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error(`${this.speaker}: no audio track available`)
    this.stream = stream

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
    await ctx.resume()
    const source = ctx.createMediaStreamSource(new MediaStream([track]))
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const sink = ctx.createGain()
    sink.gain.value = 0

    processor.onaudioprocess = (event): void => {
      this.process(event.inputBuffer.getChannelData(0))
    }

    source.connect(processor)
    processor.connect(sink)
    sink.connect(ctx.destination)

    this.ctx = ctx
    this.source = source
    this.processor = processor
    this.sink = sink
  }

  private push(data: Float32Array): void {
    this.frames.push(new Float32Array(data))
    this.speechMs += (data.length / TARGET_SAMPLE_RATE) * 1000
  }

  private process(data: Float32Array): void {
    const now = performance.now()
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
    } else if (now - this.lastVoiceAt > SILENCE_MS) {
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
    this.sink = null
    this.stream = null
    this.frames = []
    this.preBuffer = []
    this.preBufferSamples = 0
    this.speechMs = 0
    this.voicedStreak = 0
    this.speaking = false
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
