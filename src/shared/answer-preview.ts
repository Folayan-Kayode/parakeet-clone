// Static answer preview extracted from App.tsx. Shaped by the live style
// draft, never sent anywhere and never calls a model.
// Rough word targets: concise ~45, balanced ~85, detailed ~140.

import type { AnswerStyle } from './types'

export function sampleBehavioral(a: AnswerStyle): string {
  const story = [
    'At my last company our checkout p95 doubled a week before launch',
    'I owned the rollout and had to recover latency without moving the date',
    'I profiled the hot path, split a blocking write, and paired with the on-call engineer on a bounded cache',
    'As a result, p95 fell under 200 ms and we shipped on time with no rollbacks',
    'The lesson was to measure first and keep the fix small'
  ]
  let beats: string[]
  if (a.star) {
    beats =
      a.length === 'concise'
        ? [story[0], story[2], story[3]]
        : a.length === 'detailed'
          ? story
          : story.slice(0, 4)
  } else {
    beats =
      a.length === 'concise'
        ? [story[0], story[2]]
        : a.length === 'detailed'
          ? [...story.slice(0, 3), story[4]]
          : story.slice(0, 3)
  }
  if (a.tone === 'simple') {
    beats = beats.map((beat) => beat.replace('profiled the hot path', 'checked where the time went'))
  }
  const lines = beats.map((beat) => `${beat}.`)
  if (a.tone === 'casual') {
    lines[0] = `So, ${lines[0].charAt(0).toLowerCase()}${lines[0].slice(1)} you know?`
  }
  if (a.fillerWords && a.tone !== 'casual') {
    lines.splice(1, 0, 'Honestly, that week was intense.')
  }
  if (a.format === 'bullets') return lines.map((line) => `• ${line}`).join('\n')
  if (a.format === 'balanced') {
    const split = Math.max(1, Math.ceil(lines.length / 2))
    return `${lines.slice(0, split).join(' ')}\n\n${lines.slice(split).join(' ')}`
  }
  return lines.join(' ')
}

export function sampleCoding(a: AnswerStyle): string {
  const code: Record<AnswerStyle['codeLanguage'], string> = {
    python:
      'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n    return []',
    javascript:
      'function twoSum(nums, target) {\n  const seen = new Map()\n  for (let i = 0; i < nums.length; i++) {\n    const need = target - nums[i]\n    if (seen.has(need)) return [seen.get(need), i]\n    seen.set(nums[i], i)\n  }\n  return []\n}',
    java:
      'int[] twoSum(int[] nums, int target) {\n    Map<Integer, Integer> seen = new HashMap<>();\n    for (int i = 0; i < nums.length; i++) {\n        int need = target - nums[i];\n        if (seen.containsKey(need)) return new int[]{seen.get(need), i};\n        seen.put(nums[i], i);\n    }\n    return new int[]{};\n}',
    cpp:
      'vector<int> twoSum(vector<int>& nums, int target) {\n    unordered_map<int, int> seen;\n    for (int i = 0; i < nums.size(); i++) {\n        int need = target - nums[i];\n        if (seen.count(need)) return {seen[need], i};\n        seen[nums[i]] = i;\n    }\n    return {};\n}'
  }
  const approach =
    a.tone === 'casual'
      ? "So, I'd scan the array once, stash each value's index, and look for the complement — you know, the classic one-pass hash map."
      : 'I would scan the array once, store each value and index in a hash map, and check for the complement at every step.'
  const steps = [
    'Create a map from value to index.',
    'For each element, check whether target - value is already in the map.',
    'If it is, return both indices; otherwise store the current index.',
    'Return an empty result when no pair exists.'
  ]
  const stepText =
    a.format === 'paragraph'
      ? steps.map((step, i) => `${i + 1}. ${step}`).join(' ')
      : steps.map((step, i) => `${i + 1}. ${step}`).join('\n')
  const filler = a.fillerWords && a.tone !== 'formal' ? ' Honestly, that keeps it linear.' : ''
  return `${approach}${filler}\n\n${stepText}\n\n${code[a.codeLanguage]}\n\nTime complexity: O(n). Space complexity: O(n).`
}

export interface AnswerPreview {
  behavioral: string
  coding: string
}

// Both preview samples for one style draft; the Settings preview renders these
// two strings side by side.
export function buildAnswerPreview(a: AnswerStyle): AnswerPreview {
  return {
    behavioral: sampleBehavioral(a),
    coding: sampleCoding(a)
  }
}
