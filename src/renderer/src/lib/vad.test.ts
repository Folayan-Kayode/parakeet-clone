import { describe, expect, it } from 'vitest'
import { VadMachine, type VadDecision, type VadParams } from './vad'

const SR = 16000
// Legacy ScriptProcessor cadence: 4096 samples = 256 ms at 16 kHz.
const BATCH = 4096
const BATCH_MS = 256

function samples(amplitude: number, length = BATCH): Float32Array {
  return new Float32Array(length).fill(amplitude)
}

function makeMachine(params: VadParams = {}): VadMachine {
  // Direct processing keeps the state-machine tests independent of the
  // worklet accumulator; the engine passes batchSamples = 4096.
  return new VadMachine({ sampleRate: SR, batchSamples: 0, ...params })
}

function feed(m: VadMachine, amplitude: number, now: number, length = BATCH): VadDecision[] {
  return m.feed(samples(amplitude, length), now)
}

type Final = Extract<VadDecision, { type: 'final' }>
type Partial = Extract<VadDecision, { type: 'partial' }>

function finals(decisions: VadDecision[]): Final[] {
  return decisions.filter((d): d is Final => d.type === 'final')
}

function partials(decisions: VadDecision[]): Partial[] {
  return decisions.filter((d): d is Partial => d.type === 'partial')
}

function speechStarts(decisions: VadDecision[]): Array<Extract<VadDecision, { type: 'speech-start' }>> {
  return decisions.filter(
    (d): d is Extract<VadDecision, { type: 'speech-start' }> => d.type === 'speech-start'
  )
}

/** Feed two voiced batches so the machine is speaking on utterance 1. */
function startUtterance(m: VadMachine, start: number): { now: number; decisions: VadDecision[] } {
  const decisions = [...feed(m, 0.1, start)]
  const now = start + BATCH_MS
  decisions.push(...feed(m, 0.1, now))
  return { now: now + BATCH_MS, decisions }
}

/** Read the final out of a stream, or undefined. */
function finalOf(decisions: VadDecision[]): Final | undefined {
  return finals(decisions)[0]
}

describe('VadMachine onset and preroll', () => {
  it('includes pre-roll audio in the first utterance', () => {
    const m = makeMachine()
    const decisions: VadDecision[] = []
    let now = 1000
    // 3 quiet batches = 768 ms of pre-roll.
    for (let i = 0; i < 3; i++) {
      decisions.push(...feed(m, 0.001, now))
      now += BATCH_MS
    }
    // Two voiced batches: onset on the second one.
    decisions.push(...feed(m, 0.1, now))
    now += BATCH_MS
    decisions.push(...feed(m, 0.1, now))
    now += BATCH_MS

    expect(speechStarts(decisions)).toHaveLength(1)
    expect(speechStarts(decisions)[0].uid).toBe(1)

    // Feed silence until the silence flush closes the utterance.
    let final: Final | undefined
    for (let i = 0; i < 6 && !final; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      decisions.push(...part)
      final = finalOf(part)
    }
    expect(final).toBeDefined()
    expect(final?.uid).toBe(1)
    // Pre-roll was trimmed to 900 ms and the onset batch is included: three
    // pre-roll batches survive, so the final is longer than the two onset
    // batches alone.
    expect(final?.samples.length).toBe(7 * BATCH)
    expect(final?.durationMs).toBeCloseTo(7 * BATCH_MS, 4)
    expect(final?.samples.length).toBe(Math.round((final!.durationMs / 1000) * SR))
  })

  it('requires two voiced batches before entering speech', () => {
    const m = makeMachine()
    const first = feed(m, 0.1, 1000)
    expect(speechStarts(first)).toHaveLength(0)
    const second = feed(m, 0.1, 1256)
    expect(speechStarts(second)).toHaveLength(1)
  })

  it('reads the threshold from the noise floor on an unspoken batch', () => {
    const m = makeMachine()
    expect(m.voicedThreshold).toBe(0.01)
    feed(m, 0.001, 1000)
    expect(m.adaptiveNoiseFloor).toBeLessThan(0.004)
    expect(m.voicedThreshold).toBeGreaterThanOrEqual(0.008)
  })
})

describe('VadMachine flushes', () => {
  it('flushes on silence and starts the next utterance with a new uid', () => {
    const m = makeMachine()
    const { now: afterOnset } = startUtterance(m, 1000)
    let now = afterOnset
    let first: Final | undefined
    for (let i = 0; i < 6 && !first; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      first = finalOf(part)
    }
    expect(first?.uid).toBe(1)

    // After the flush the machine is idle: more silence must not produce finals.
    for (let i = 0; i < 5; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      expect(finals(part)).toHaveLength(0)
    }

    const nextOnset = [...feed(m, 0.1, now)]
    now += BATCH_MS
    nextOnset.push(...feed(m, 0.1, now))
    now += BATCH_MS
    expect(speechStarts(nextOnset)[0].uid).toBe(2)

    let second: Final | undefined
    for (let i = 0; i < 6 && !second; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      second = finalOf(part)
    }
    expect(second?.uid).toBe(2)
  })

  it('forces a final at maxChunkMs and keeps speaking with the next uid', () => {
    const m = makeMachine()
    let now = 1000
    const decisions: VadDecision[] = []
    decisions.push(...feed(m, 0.1, now))
    now += BATCH_MS
    decisions.push(...feed(m, 0.1, now))
    now += BATCH_MS

    let first: Final | undefined
    for (let i = 0; i < 60 && !first; i++) {
      const part = feed(m, 0.1, now)
      now += BATCH_MS
      decisions.push(...part)
      first = finalOf(part)
    }
    expect(first).toBeDefined()
    expect(first?.uid).toBe(1)
    expect(first?.durationMs).toBeGreaterThanOrEqual(12_000)
    expect(first?.samples.length).toBe(47 * BATCH)

    // Continuous speech continues as a fresh uid without a new onset.
    let nextUid = false
    for (let i = 0; i < 10 && !nextUid; i++) {
      const part = feed(m, 0.1, now)
      now += BATCH_MS
      nextUid = part.some(
        (d) => (d.type === 'partial' || d.type === 'final') && d.uid === 2
      )
    }
    expect(nextUid).toBe(true)
  })

  it('drops a final below the minimum speech gate but still resets state', () => {
    const m = makeMachine({ minSpeechMs: 2000 })
    let now = 1000
    // Onset with only two 256 ms batches: 512 ms < minSpeechMs.
    feed(m, 0.1, now)
    now += BATCH_MS
    const onset = feed(m, 0.1, now)
    now += BATCH_MS
    expect(speechStarts(onset)).toHaveLength(1)

    // A silence flush must not emit the short utterance.
    let emitted: Final | undefined
    for (let i = 0; i < 6 && !emitted; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      emitted = finalOf(part)
    }
    expect(emitted).toBeUndefined()
  })

  it('drops a final whose chunk RMS is below minChunkRms', () => {
    const m = makeMachine()
    let now = 1000
    // Just above the 0.01 onset threshold, then mostly silence.
    feed(m, 0.011, now)
    now += BATCH_MS
    const onset = feed(m, 0.011, now)
    now += BATCH_MS
    expect(speechStarts(onset)).toHaveLength(1)

    let emitted: Final | undefined
    for (let i = 0; i < 6 && !emitted; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      emitted = finalOf(part)
    }
    expect(emitted).toBeUndefined()
  })
})

describe('VadMachine gap accounting', () => {
  it('does not inject zeros for a gap within tolerance', () => {
    const m = makeMachine()
    const { now: afterOnset } = startUtterance(m, 1000)
    // One normal voiced batch, then a batch 100 ms late (< 300 ms tolerance).
    let now = afterOnset
    feed(m, 0.1, now)
    now += BATCH_MS
    const late = now + 100
    feed(m, 0.1, late)
    now = late + BATCH_MS

    let final: Final | undefined
    for (let i = 0; i < 6 && !final; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      final = finalOf(part)
    }
    expect(final).toBeDefined()
    // 8 real batches and no synthesized samples.
    expect(final?.samples.length).toBe(8 * BATCH)
  })

  it('injects zero samples for a gap between tolerance and 2 s', () => {
    const m = makeMachine()
    const { now: afterOnset } = startUtterance(m, 1000)
    // One normal batch, then a 500 ms stall while speaking.
    let now = afterOnset
    feed(m, 0.1, now)
    now += BATCH_MS
    const late = now + 500
    const injected = feed(m, 0.1, late)
    now = late + BATCH_MS

    // The injection is 500 ms = 8000 samples.
    const earlyPartial = partials(injected)[0]
    expect(earlyPartial).toBeDefined()
    expect(earlyPartial?.samples.length).toBe(3 * BATCH + 8000)

    let final: Final | undefined
    for (let i = 0; i < 6 && !final; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      final = finalOf(part)
    }
    expect(final).toBeDefined()
    // 8 real batches plus the 8000 synthesized samples.
    expect(final?.samples.length).toBe(8 * BATCH + 8000)
  })

  it('resyncs instead of flooding after a multi-second stall', () => {
    const m = makeMachine()
    const { now: afterOnset } = startUtterance(m, 1000)
    let now = afterOnset
    feed(m, 0.1, now)
    now += BATCH_MS
    const stalled = now + 3000
    feed(m, 0.1, stalled)
    now = stalled + BATCH_MS

    let final: Final | undefined
    for (let i = 0; i < 6 && !final; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      final = finalOf(part)
    }
    expect(final).toBeDefined()
    // No zero flood: only the real batches.
    expect(final?.samples.length).toBe(8 * BATCH)
  })
})

describe('VadMachine adaptive noise floor', () => {
  it('lowers quiet batches toward the floor and clamps the threshold at noiseFloorMin', () => {
    const m = makeMachine()
    let now = 1000
    for (let i = 0; i < 200; i++) {
      feed(m, 0.001, now)
      now += BATCH_MS
    }
    expect(m.adaptiveNoiseFloor).toBeLessThan(0.004)
    expect(m.adaptiveNoiseFloor).toBeGreaterThan(0.001)
    // 0.001 * 2.5 is below the 0.008 threshold floor.
    expect(m.voicedThreshold).toBe(0.008)

    // 0.009 was unvoiced at the initial floor, but is voiced after adaptation.
    const first = feed(m, 0.009, now)
    now += BATCH_MS
    const second = feed(m, 0.009, now)
    expect(speechStarts([...first, ...second])).toHaveLength(1)
  })

  it('raises the floor from louder unvoiced batches (threshold = floor * 2.5)', () => {
    const m = makeMachine()
    let now = 1000
    // Adapt the floor down so the quiet batches below are unvoiced.
    for (let i = 0; i < 200; i++) {
      feed(m, 0.001, now)
      now += BATCH_MS
    }
    const lowered = m.adaptiveNoiseFloor
    expect(m.voicedThreshold).toBe(0.008)

    // 0.007 < 0.008: unvoiced, so it pulls the floor up.
    for (let i = 0; i < 300; i++) {
      feed(m, 0.007, now)
      now += BATCH_MS
    }
    expect(m.adaptiveNoiseFloor).toBeGreaterThan(lowered)
    expect(m.voicedThreshold).toBeGreaterThan(0.017)
    expect(m.voicedThreshold).toBeLessThan(0.018)

    // 0.01 used to be voiced at threshold 0.008; now it is below the raised one.
    const first = feed(m, 0.01, now)
    now += BATCH_MS
    const second = feed(m, 0.01, now)
    expect(speechStarts([...first, ...second])).toHaveLength(0)
  })
})

describe('VadMachine partial cadence and level', () => {
  it('emits a partial at the interval during speech and none after the flush', () => {
    const m = makeMachine()
    let now = 1000
    const all: VadDecision[] = []
    all.push(...feed(m, 0.1, now))
    now += BATCH_MS
    all.push(...feed(m, 0.1, now)) // onset at 1256
    now += BATCH_MS
    for (let i = 0; i < 5; i++) {
      all.push(...feed(m, 0.1, now))
      now += BATCH_MS
    }

    const first = partials(all)
    expect(first).toHaveLength(1)
    expect(first[0].uid).toBe(1)
    // The first partial lands after ~800 ms of speech: batches 1-6.
    expect(first[0].samples.length).toBe(6 * BATCH)

    let final: Final | undefined
    for (let i = 0; i < 8 && !final; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      final = finalOf(part)
    }
    expect(final).toBeDefined()

    // Once the silence flush closed the utterance, no more partials.
    for (let i = 0; i < 5; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      expect(partials(part)).toHaveLength(0)
    }
  })

  it('updates the level on an EMA with a 250 ms throttle', () => {
    const m = makeMachine()
    let now = 1000
    const all: VadDecision[] = []
    for (let i = 0; i < 4; i++) {
      all.push(...feed(m, 0.1, now, 1600))
      now += 100
    }
    const levels = all.filter(
      (d): d is Extract<VadDecision, { type: 'level' }> => d.type === 'level'
    )
    expect(levels).toHaveLength(2)
    expect(levels[0].rms).toBeCloseTo(0.03, 6)
    expect(levels[1].rms).toBeCloseTo(0.07599, 6)
  })
})

describe('VadMachine uid and worklet batching', () => {
  it('keeps uids monotonic across reset and clears stats', () => {
    const m = makeMachine()
    let now = 1000
    const first = startUtterance(m, now)
    now = first.now
    let final1: Final | undefined
    for (let i = 0; i < 6 && !final1; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      final1 = finalOf(part)
    }
    expect(final1?.uid).toBe(1)
    expect(m.getStats().batches).toBeGreaterThan(0)
    expect(m.getStats().samples).toBeGreaterThan(0)

    m.reset()
    expect(m.getStats()).toEqual({ batches: 0, samples: 0, durationMs: 0 })

    const second = startUtterance(m, now)
    now = second.now
    let final2: Final | undefined
    for (let i = 0; i < 6 && !final2; i++) {
      const part = feed(m, 0.001, now)
      now += BATCH_MS
      final2 = finalOf(part)
    }
    expect(final2?.uid).toBe(2)
  })

  function summarize(decisions: VadDecision[]): unknown[] {
    return decisions.map((d) => {
      if (d.type === 'level') return { type: d.type, rms: Number(d.rms.toFixed(6)) }
      if (d.type === 'speech-start') return { type: d.type, uid: d.uid }
      return { type: d.type, uid: d.uid, length: d.samples.length }
    })
  }

  function runDirect(amplitudes: number[], start: number): VadDecision[] {
    const m = makeMachine({ batchSamples: 0 })
    const out: VadDecision[] = []
    amplitudes.forEach((amplitude, index) => {
      out.push(...m.feed(samples(amplitude, 4160), start + index * 260))
    })
    return out
  }

  function runBatched(amplitudes: number[], start: number): VadDecision[] {
    const m = makeMachine({ batchSamples: 4096 })
    const out: VadDecision[] = []
    amplitudes.forEach((amplitude, index) => {
      // 26 x 160 = 4160 samples; the last frame completes at `start + i * 260`.
      const batchStart = start + index * 260 - 250
      for (let frame = 0; frame < 26; frame++) {
        out.push(...m.feed(samples(amplitude, 160), batchStart + frame * 10))
      }
    })
    return out
  }

  it('produces the same decisions for 160-sample frames and 4160-sample batches', () => {
    const amplitudes = [0.1, 0.1, 0.1, 0.001, 0.001, 0.001, 0.001]
    const direct = runDirect(amplitudes, 1000)
    const batched = runBatched(amplitudes, 1000)
    expect(summarize(batched)).toEqual(summarize(direct))
    expect(speechStarts(direct)).toHaveLength(1)
    expect(finals(direct)).toHaveLength(1)
  })
})
