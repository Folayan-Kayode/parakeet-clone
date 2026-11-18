import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CoalesceController, type CoalesceDeps } from './coalesce'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHarness(overrides: Partial<CoalesceDeps> = {}): {
  controller: CoalesceController
  asks: Array<[string, number]>
  queued: Array<[string, number]>
  transcribe: Mock<(uids: number[]) => Promise<string | null>>
} {
  const asks: Array<[string, number]> = []
  const queued: Array<[string, number]> = []
  const transcribe = vi.fn<(uids: number[]) => Promise<string | null>>(async () => null)
  // Stable numeric ids around the (fake) platform timers, mirroring the
  // renderer's window.setTimeout contract.
  let nextTimer = 1
  const timeouts = new Map<number, ReturnType<typeof setTimeout>>()
  const deps: CoalesceDeps = {
    mergeMs: () => 2000,
    onAsk: (question, anchorUid) => asks.push([question, anchorUid]),
    onQueue: (question, anchorUid) => queued.push([question, anchorUid]),
    isStreaming: () => false,
    isAutoAnswer: () => true,
    isListening: () => true,
    cooldownMs: () => 0,
    lastAnswerAt: () => 0,
    timers: {
      set: (fn, ms) => {
        const id = nextTimer++
        timeouts.set(
          id,
          setTimeout(() => {
            timeouts.delete(id)
            fn()
          }, ms)
        )
        return id
      },
      clear: (id) => {
        const handle = timeouts.get(id)
        if (handle === undefined) return
        clearTimeout(handle)
        timeouts.delete(id)
      }
    },
    now: () => Date.now(),
    transcribe,
    ...overrides
  }
  return { controller: new CoalesceController(deps), asks, queued, transcribe }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CoalesceController fire window', () => {
  it('does not ask before mergeMs and asks once at mergeMs', async () => {
    const h = makeHarness()
    h.controller.hold('What is your strength?', 7)
    expect(h.controller.hasPending()).toBe(true)

    await vi.advanceTimersByTimeAsync(1999)
    expect(h.asks).toHaveLength(0)
    expect(h.queued).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(h.asks).toEqual([['What is your strength?', 7]])
    expect(h.controller.hasPending()).toBe(false)
  })

  it('does not re-transcribe a single-uid hold', async () => {
    const h = makeHarness()
    h.controller.hold('q', 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.asks).toEqual([['q', 1]])
  })

  it('merges a continuation into the text and restarts at 60% of mergeMs', async () => {
    const h = makeHarness()
    h.controller.hold('first', 1)
    await vi.advanceTimersByTimeAsync(1000)

    h.controller.addContinuation(2, 'second')
    // 2000 * 0.6 = 1200ms from the continuation, not the original 2000ms.
    await vi.advanceTimersByTimeAsync(1199)
    expect(h.asks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(h.asks).toEqual([['first second', 1]])
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(h.transcribe).toHaveBeenLastCalledWith([1, 2])
  })

  it('clamps the continuation restart to a 600ms minimum', async () => {
    const h = makeHarness({ mergeMs: () => 900 })
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    // max(600, round(900 * 0.6)) = 600
    await vi.advanceTimersByTimeAsync(599)
    expect(h.asks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.asks).toEqual([['q b', 1]])
  })

  it('does not duplicate a repeated uid but still appends its text', async () => {
    const h = makeHarness()
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    h.controller.addContinuation(2, 'b again')
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.transcribe).toHaveBeenLastCalledWith([1, 2])
    expect(h.asks).toEqual([['q b b again', 1]])
  })
})

describe('CoalesceController re-transcription', () => {
  it('uses the transcribed audio text when the hold has at least two uids', async () => {
    const h = makeHarness()
    h.transcribe.mockResolvedValueOnce('merged from audio')
    h.controller.hold('first', 1)
    h.controller.addContinuation(2, 'second')
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.transcribe).toHaveBeenCalledWith([1, 2])
    expect(h.asks).toEqual([['merged from audio', 1]])
  })

  it('falls back to collected text when transcribe returns null', async () => {
    const h = makeHarness()
    h.transcribe.mockResolvedValueOnce(null)
    h.controller.hold('first', 1)
    h.controller.addContinuation(2, 'second')
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.asks).toEqual([['first second', 1]])
  })

  it('falls back to collected text when transcribe rejects', async () => {
    const h = makeHarness()
    h.transcribe.mockRejectedValueOnce(new Error('asr down'))
    h.controller.hold('first', 1)
    h.controller.addContinuation(2, 'second')
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.asks).toEqual([['first second', 1]])
  })

  it('re-fires with the full uid set when a continuation lands during transcription', async () => {
    const h = makeHarness()
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    h.transcribe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(h.transcribe).toHaveBeenLastCalledWith([1, 2])

    // Late continuation while the first re-transcription is in flight.
    h.controller.addContinuation(3, 'c')
    expect(h.asks).toHaveLength(0)

    first.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    // The count changed, so the hold re-armed instead of asking stale audio.
    expect(h.asks).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1200)
    expect(h.transcribe).toHaveBeenCalledTimes(2)
    expect(h.transcribe).toHaveBeenLastCalledWith([1, 2, 3])

    second.resolve('full')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asks).toEqual([['full', 1]])
  })

  it('handles two count changes across successive fires without double-asking', async () => {
    const h = makeHarness()
    const t1 = deferred<string | null>()
    const t2 = deferred<string | null>()
    const t3 = deferred<string | null>()
    h.transcribe
      .mockReturnValueOnce(t1.promise)
      .mockReturnValueOnce(t2.promise)
      .mockReturnValueOnce(t3.promise)

    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await vi.advanceTimersByTimeAsync(1200) // t1 in flight

    h.controller.addContinuation(3, 'c')
    t1.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1200) // t2 in flight

    h.controller.addContinuation(4, 'd')
    t2.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1200) // t3 in flight

    expect(h.transcribe).toHaveBeenLastCalledWith([1, 2, 3, 4])
    t3.resolve('all')
    await vi.advanceTimersByTimeAsync(0)

    expect(h.asks).toEqual([['all', 1]])
    expect(h.queued).toHaveLength(0)
  })
})

describe('CoalesceController manual consume', () => {
  it('returns null and does not transcribe when no hold is pending', async () => {
    const h = makeHarness()
    await expect(h.controller.consumeManual()).resolves.toBeNull()
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('returns the collected text for a single-uid hold', async () => {
    const h = makeHarness()
    h.controller.hold('q', 1)
    await expect(h.controller.consumeManual()).resolves.toEqual({ question: 'q', anchorUid: 1 })
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.controller.hasPending()).toBe(false)
  })

  it('re-transcribes a multi-uid hold', async () => {
    const h = makeHarness()
    h.transcribe.mockResolvedValueOnce('manual audio')
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await expect(h.controller.consumeManual()).resolves.toEqual({
      question: 'manual audio',
      anchorUid: 1
    })
    expect(h.transcribe).toHaveBeenCalledWith([1, 2])
  })

  it('falls back to collected text when the manual transcribe fails', async () => {
    const h = makeHarness()
    h.transcribe.mockRejectedValueOnce(new Error('asr down'))
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await expect(h.controller.consumeManual()).resolves.toEqual({
      question: 'q b',
      anchorUid: 1
    })
  })

  it('takes the hold during a fire and suppresses the fire ask', async () => {
    const h = makeHarness()
    const fireText = deferred<string | null>()
    const manualText = deferred<string | null>()
    h.transcribe.mockReturnValueOnce(fireText.promise).mockReturnValueOnce(manualText.promise)

    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await vi.advanceTimersByTimeAsync(1200) // fire starts; transcribe #1 pending

    const consumed = h.controller.consumeManual()
    expect(h.controller.hasPending()).toBe(false)

    fireText.resolve('stale')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asks).toHaveLength(0)

    manualText.resolve('manual')
    await expect(consumed).resolves.toEqual({ question: 'manual', anchorUid: 1 })
    expect(h.transcribe).toHaveBeenCalledTimes(2)
    expect(h.asks).toHaveLength(0)
  })
})

describe('CoalesceController cancel and dispose', () => {
  it('cancel clears a pending grace timer', async () => {
    const h = makeHarness()
    h.controller.hold('q', 1)
    h.controller.cancel()
    expect(h.controller.hasPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.asks).toHaveLength(0)
    expect(h.queued).toHaveLength(0)
  })

  it('cancel during a fire drops the resolved transcription', async () => {
    const h = makeHarness()
    const t = deferred<string | null>()
    h.transcribe.mockReturnValueOnce(t.promise)
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await vi.advanceTimersByTimeAsync(1200)

    h.controller.cancel()
    t.resolve('late')
    await vi.advanceTimersByTimeAsync(0)

    expect(h.asks).toHaveLength(0)
    expect(h.queued).toHaveLength(0)
  })

  it('dispose during a fire drops the resolved transcription', async () => {
    const h = makeHarness()
    const t = deferred<string | null>()
    h.transcribe.mockReturnValueOnce(t.promise)
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await vi.advanceTimersByTimeAsync(1200)

    h.controller.dispose()
    t.resolve('late')
    await vi.advanceTimersByTimeAsync(0)

    expect(h.asks).toHaveLength(0)
  })

  it('dispose clears the scheduled timer and the controller stays reusable', async () => {
    const h = makeHarness()
    h.controller.hold('q', 1)
    h.controller.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.asks).toHaveLength(0)

    h.controller.hold('again', 2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.asks).toEqual([['again', 2]])
  })
})

describe('CoalesceController immediate path', () => {
  it('mergeMs = 0 asks immediately without a hold', () => {
    const h = makeHarness({ mergeMs: () => 0 })
    h.controller.hold('q', 1)
    expect(h.asks).toEqual([['q', 1]])
    expect(h.queued).toHaveLength(0)
    expect(h.controller.hasPending()).toBe(false)
  })

  it('mergeMs = 0 queues while an answer is streaming', () => {
    const h = makeHarness({ mergeMs: () => 0, isStreaming: () => true })
    h.controller.hold('q', 1)
    expect(h.asks).toHaveLength(0)
    expect(h.queued).toEqual([['q', 1]])
  })

  it('mergeMs = 0 queues while the cooldown is still active', () => {
    const h = makeHarness({
      mergeMs: () => 0,
      cooldownMs: () => 5000,
      lastAnswerAt: () => 0,
      now: () => 0
    })
    h.controller.hold('q', 1)
    expect(h.asks).toHaveLength(0)
    expect(h.queued).toEqual([['q', 1]])
  })

  it('asks at fire time once the cooldown has elapsed', async () => {
    const h = makeHarness({
      cooldownMs: () => 5000,
      lastAnswerAt: () => 0,
      now: () => 6000
    })
    h.controller.hold('q', 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.queued).toHaveLength(0)
    expect(h.asks).toEqual([['q', 1]])
  })
})

describe('CoalesceController gates and no-ops', () => {
  it('does not ask when auto-answer was turned off during the hold', async () => {
    let auto = true
    const h = makeHarness({ isAutoAnswer: () => auto })
    h.controller.hold('q', 1)
    auto = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.asks).toHaveLength(0)
    expect(h.queued).toHaveLength(0)
    expect(h.controller.hasPending()).toBe(false)
  })

  it('does not ask when listening stopped during the hold', async () => {
    let listening = true
    const h = makeHarness({ isListening: () => listening })
    h.controller.hold('q', 1)
    listening = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.asks).toHaveLength(0)
    expect(h.queued).toHaveLength(0)
  })

  it('addContinuation with no hold is a no-op', () => {
    const h = makeHarness()
    h.controller.addContinuation(1, 'stray')
    expect(h.asks).toHaveLength(0)
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('extend restarts the grace window at the 600ms minimum', async () => {
    const h = makeHarness()
    h.controller.hold('q', 1)
    await vi.advanceTimersByTimeAsync(1500)
    h.controller.extend()
    await vi.advanceTimersByTimeAsync(599)
    expect(h.asks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.asks).toEqual([['q', 1]])
  })

  it('extend does not restart a timer while a fire is in flight', async () => {
    const h = makeHarness()
    const t = deferred<string | null>()
    h.transcribe.mockReturnValueOnce(t.promise)
    h.controller.hold('q', 1)
    h.controller.addContinuation(2, 'b')
    await vi.advanceTimersByTimeAsync(1200)

    expect(vi.getTimerCount()).toBe(0)
    h.controller.extend()
    expect(vi.getTimerCount()).toBe(0)

    t.resolve('merged')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asks).toEqual([['merged', 1]])
  })

  it('a second hold replaces the first without leaving a timer behind', async () => {
    const h = makeHarness()
    h.controller.hold('first', 1)
    h.controller.hold('second', 2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.asks).toEqual([['second', 2]])
  })
})
