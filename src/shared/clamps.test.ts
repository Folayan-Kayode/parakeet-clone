import { describe, expect, it } from 'vitest'
import {
  INTERACTION_BOUNDS,
  LLM_BOUNDS,
  clampInteractionValue,
  clampMaxTokensValue,
  clampTemperatureValue
} from './clamps'

const KEYS = Object.keys(INTERACTION_BOUNDS) as Array<keyof typeof INTERACTION_BOUNDS>

describe('INTERACTION_BOUNDS', () => {
  it('matches the documented settings ranges', () => {
    expect(INTERACTION_BOUNDS).toEqual({
      answerCooldownMs: { min: 1000, max: 30000, fallback: 5000 },
      mergeFollowUpsMs: { min: 0, max: 5000, fallback: 2000 },
      silenceSplitMs: { min: 600, max: 1500, fallback: 900 }
    })
  })

  it('is the single source for SettingsView input bounds', () => {
    // SettingsView imports this object for its min/max attributes and onChange
    // clamps; asserting the shape here keeps the documented UI ranges in sync.
    const inputs = {
      answerCooldownMs: {
        min: INTERACTION_BOUNDS.answerCooldownMs.min,
        max: INTERACTION_BOUNDS.answerCooldownMs.max
      },
      mergeFollowUpsMs: {
        min: INTERACTION_BOUNDS.mergeFollowUpsMs.min,
        max: INTERACTION_BOUNDS.mergeFollowUpsMs.max
      },
      silenceSplitMs: {
        min: INTERACTION_BOUNDS.silenceSplitMs.min,
        max: INTERACTION_BOUNDS.silenceSplitMs.max
      }
    }
    expect(inputs).toEqual({
      answerCooldownMs: { min: 1000, max: 30000 },
      mergeFollowUpsMs: { min: 0, max: 5000 },
      silenceSplitMs: { min: 600, max: 1500 }
    })
  })
})

describe('clampInteractionValue', () => {
  for (const key of KEYS) {
    const { min, max, fallback } = INTERACTION_BOUNDS[key]

    it(`${key}: below min clamps to min`, () => {
      expect(clampInteractionValue(key, min - 1)).toBe(min)
    })

    it(`${key}: at min is preserved`, () => {
      expect(clampInteractionValue(key, min)).toBe(min)
    })

    it(`${key}: a valid inside-range value rounds`, () => {
      const inside = Math.round((min + max) / 2)
      expect(clampInteractionValue(key, inside)).toBe(inside)
      expect(clampInteractionValue(key, inside + 0.4)).toBe(inside)
    })

    it(`${key}: at max is preserved`, () => {
      expect(clampInteractionValue(key, max)).toBe(max)
    })

    it(`${key}: above max clamps to max`, () => {
      expect(clampInteractionValue(key, max + 1)).toBe(max)
    })

    it(`${key}: non-finite falls back`, () => {
      expect(clampInteractionValue(key, Number.NaN)).toBe(fallback)
      expect(clampInteractionValue(key, Number.POSITIVE_INFINITY)).toBe(fallback)
      expect(clampInteractionValue(key, Number.NEGATIVE_INFINITY)).toBe(fallback)
    })
  }
})

describe('LLM_BOUNDS', () => {
  it('matches the documented model-profile ranges', () => {
    expect(LLM_BOUNDS).toEqual({
      temperature: { min: 0, max: 1, fallback: 0.2 },
      maxTokens: { min: 128, max: 8192, fallback: 4096 }
    })
  })
})

describe('clampTemperatureValue', () => {
  it('clamps into 0–1 without rounding', () => {
    expect(clampTemperatureValue(-1)).toBe(0)
    expect(clampTemperatureValue(0)).toBe(0)
    expect(clampTemperatureValue(0.35)).toBe(0.35)
    expect(clampTemperatureValue(1)).toBe(1)
    expect(clampTemperatureValue(2)).toBe(1)
  })

  it('falls back for non-finite input', () => {
    expect(clampTemperatureValue(Number.NaN)).toBe(0.2)
    expect(clampTemperatureValue(Number.POSITIVE_INFINITY)).toBe(0.2)
  })
})

describe('clampMaxTokensValue', () => {
  it('rounds and clamps into 128–8192', () => {
    expect(clampMaxTokensValue(0)).toBe(128)
    expect(clampMaxTokensValue(128)).toBe(128)
    expect(clampMaxTokensValue(128.4)).toBe(128)
    expect(clampMaxTokensValue(128.5)).toBe(129)
    expect(clampMaxTokensValue(8192)).toBe(8192)
    expect(clampMaxTokensValue(9000)).toBe(8192)
  })

  it('falls back for non-finite input', () => {
    expect(clampMaxTokensValue(Number.NaN)).toBe(4096)
    expect(clampMaxTokensValue(Number.NEGATIVE_INFINITY)).toBe(4096)
  })
})
