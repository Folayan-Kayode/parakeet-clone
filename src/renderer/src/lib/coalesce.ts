// Coalescing grace-window state machine, extracted from App so its concurrency
// rules can be tested with injected timers. App owns the PCM store, the WAV
// encoding, the streaming lock and the queued-ask store; this module owns the
// hold, its timer restarts and the single fire path.

export interface CoalesceTimers {
  set: (fn: () => void, ms: number) => number
  clear: (id: number) => void
}

export interface CoalesceDeps {
  /** Grace window in ms; 0 answers immediately with no hold. */
  mergeMs: () => number
  onAsk: (question: string, anchorUid: number) => void
  onQueue: (question: string, anchorUid: number) => void
  isStreaming: () => boolean
  isAutoAnswer: () => boolean
  isListening: () => boolean
  /** Minimum gap between asks; only used to choose ask vs queue. */
  cooldownMs: () => number
  lastAnswerAt: () => number
  timers: CoalesceTimers
  now?: () => number
  /** Re-transcribe every held uid; null falls back to the collected text. */
  transcribe: (uids: number[]) => Promise<string | null>
}

interface Hold {
  question: string
  anchorUid: number
  uids: number[]
  timer: number
  firing: boolean
}

const MIN_RESTART_MS = 600
const CONTINUATION_FACTOR = 0.6

export class CoalesceController {
  private pendingHold: Hold | null = null
  private readonly deps: CoalesceDeps
  private readonly now: () => number

  constructor(deps: CoalesceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** True while a merged question is still waiting for its grace window. */
  hasPending(): boolean {
    return this.pendingHold !== null
  }

  /**
   * Start a hold for a detected question. mergeMs = 0 keeps the legacy
   * immediate path: ask now, or queue if the lock/cooldown blocks it.
   */
  hold(question: string, anchorUid: number): void {
    // Defensive: a second hold must not orphan the previous timer.
    this.cancel()
    const mergeMs = this.deps.mergeMs()
    if (mergeMs <= 0) {
      this.dispatch(question, anchorUid)
      return
    }
    const timer = this.deps.timers.set(() => void this.fire(), mergeMs)
    this.pendingHold = { question, anchorUid, uids: [anchorUid], timer, firing: false }
  }

  /**
   * Merge a later remote final into the pending question. While a
   * re-transcription is in flight, the fire path re-checks the uid count and
   * restarts the timer itself.
   */
  addContinuation(uid: number, text: string): void {
    const hold = this.pendingHold
    if (!hold) return
    if (!hold.uids.includes(uid)) hold.uids.push(uid)
    hold.question = `${hold.question} ${text}`.trim()
    if (!hold.firing) this.restart(this.continuationDelay())
  }

  /**
   * A partial means the final chunk is still coming; restart at the minimum so
   * a long hold cannot be pushed forward indefinitely.
   */
  extend(): void {
    const hold = this.pendingHold
    if (!hold || hold.firing) return
    this.restart(MIN_RESTART_MS)
  }

  /**
   * Take the pending hold for a manual Answer press. The hold (and its timer)
   * is removed synchronously before the re-transcription, so a concurrent fire
   * cannot ask the same question twice.
   */
  async consumeManual(): Promise<{ question: string; anchorUid: number } | null> {
    const hold = this.pendingHold
    if (!hold) return null
    this.cancel()
    let question = hold.question
    if (hold.uids.length >= 2) {
      const audioText = await this.deps.transcribe([...hold.uids]).catch(() => null)
      if (audioText) question = audioText
    }
    return { question, anchorUid: hold.anchorUid }
  }

  cancel(): void {
    const hold = this.pendingHold
    if (!hold) return
    this.deps.timers.clear(hold.timer)
    this.pendingHold = null
  }

  /** Cancel pending work. The controller stays reusable (StrictMode remount). */
  dispose(): void {
    this.cancel()
  }

  private continuationDelay(): number {
    return Math.max(MIN_RESTART_MS, Math.round(this.deps.mergeMs() * CONTINUATION_FACTOR))
  }

  private restart(delayMs: number): void {
    const hold = this.pendingHold
    if (!hold) return
    this.deps.timers.clear(hold.timer)
    hold.timer = this.deps.timers.set(() => void this.fire(), delayMs)
  }

  private async fire(): Promise<void> {
    const hold = this.pendingHold
    if (!hold) return
    // Take ownership: kill any restarted timer and freeze restarts while the
    // re-transcription is in flight.
    this.deps.timers.clear(hold.timer)
    hold.firing = true
    const uidCount = hold.uids.length
    let question = hold.question
    if (uidCount >= 2) {
      const audioText = await this.deps.transcribe([...hold.uids]).catch(() => null)
      // Cancel/dispose/consumeManual may have taken the hold while we awaited.
      if (this.pendingHold !== hold) return
      if (hold.uids.length !== uidCount) {
        // A continuation landed mid-transcription. Keep the hold and re-run the
        // timer so the extended set is re-transcribed with all of its audio.
        hold.firing = false
        this.restart(this.continuationDelay())
        return
      }
      question = audioText ?? hold.question
    }
    if (this.pendingHold !== hold) return
    this.pendingHold = null
    if (!this.deps.isAutoAnswer() || !this.deps.isListening()) return
    this.dispatch(question, hold.anchorUid)
  }

  private dispatch(question: string, anchorUid: number): void {
    const cooldownLeft = this.deps.cooldownMs() - (this.now() - this.deps.lastAnswerAt())
    if (this.deps.isStreaming() || cooldownLeft > 0) {
      this.deps.onQueue(question, anchorUid)
    } else {
      this.deps.onAsk(question, anchorUid)
    }
  }
}
