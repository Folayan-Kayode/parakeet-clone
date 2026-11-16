/**
 * VadFramer — fixed-size sample framer for the capture pipeline.
 *
 * Runs on the audio render thread instead of the main thread, so sample flow is
 * jank-proof: React renders, ASR responses and screenshot work can no longer
 * starve it the way they starved the old ScriptProcessorNode callbacks (which
 * delivered samples late and in bursts under main-thread load).
 *
 * Scope is deliberately tiny: buffer incoming samples, slice them into fixed
 * frames, hand each frame to the main thread as a transferable (zero-copy)
 * Float32Array. VAD, silence timing, utterance chunking and WAV encoding stay
 * in AudioEngine on the main thread — do not grow a second implementation of
 * them here.
 *
 * Mono: the node is created with channelCount: 1 / channelCountMode: 'explicit',
 * so WebAudio downmixes the source to a single channel before it reaches us;
 * inputs[0][0] is already the mono signal.
 *
 * Ships as a static asset (src/renderer/public -> out/renderer root), so it is
 * not bundled by vite: plain JS, no imports, top-level registerProcessor only.
 */

const DEFAULT_FRAME_SIZE = 160 // 10 ms at the 16 kHz capture context

class VadFramer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const processorOptions = (options && options.processorOptions) || {}
    const requested = processorOptions.frameSize
    this.frameSize =
      typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
        ? Math.floor(requested)
        : DEFAULT_FRAME_SIZE
    // Samples not yet formed into a full frame (max frameSize - 1 after a pass).
    this.buffer = new Float32Array(0)
    this.stopped = false

    this.port.onmessage = (event) => {
      if (event.data === 'reset') {
        this.buffer = new Float32Array(0)
        return
      }
      if (event.data === 'stop') {
        this.stopped = true
        this.buffer = new Float32Array(0)
      }
    }
  }

  process(inputs) {
    if (this.stopped) return true
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel || channel.length === 0) return true

    // The render quantum's channel is recycled after process() returns, so the
    // samples must be copied before they are buffered or emitted.
    if (this.buffer.length === 0) {
      this.buffer = channel.slice(0)
    } else {
      const merged = new Float32Array(this.buffer.length + channel.length)
      merged.set(this.buffer)
      merged.set(channel, this.buffer.length)
      this.buffer = merged
    }

    let offset = 0
    while (this.buffer.length - offset >= this.frameSize) {
      const frame = this.buffer.slice(offset, offset + this.frameSize)
      // Transfer: ownership moves to the main thread without copying.
      this.port.postMessage(frame, [frame.buffer])
      offset += this.frameSize
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset)

    return true
  }
}

registerProcessor('parakeet-vad-framer', VadFramer)
