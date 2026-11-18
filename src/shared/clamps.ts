// Numeric bounds shared by main config normalization and the renderer's
// settings inputs. Kept dependency-free so both processes import the same data.
export const INTERACTION_BOUNDS = {
  answerCooldownMs: { min: 1000, max: 30000, fallback: 5000 },
  mergeFollowUpsMs: { min: 0, max: 5000, fallback: 2000 },
  silenceSplitMs: { min: 600, max: 1500, fallback: 900 }
} as const

// Model-profile bounds. `temperature` is continuous; `maxTokens` is rounded.
export const LLM_BOUNDS = {
  temperature: { min: 0, max: 1, fallback: 0.2 },
  maxTokens: { min: 128, max: 8192, fallback: 4096 }
} as const

export function clampInteractionValue(
  key: keyof typeof INTERACTION_BOUNDS,
  value: number
): number {
  const bounds = INTERACTION_BOUNDS[key]
  if (!Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

export function clampTemperatureValue(value: number): number {
  const { min, max, fallback } = LLM_BOUNDS.temperature
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export function clampMaxTokensValue(value: number): number {
  const { min, max, fallback } = LLM_BOUNDS.maxTokens
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}
