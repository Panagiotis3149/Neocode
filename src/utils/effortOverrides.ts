import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'

export type ReasoningEffortOverride = {
  /** Exact model id, or a prefix ending with '*' (e.g. 'novita/*', 'nvidia/*'). */
  match: string
  /** Wire param name to send, e.g. 'reasoning_effort' | 'reasoning' | 'thinking'. */
  param: string
  /** Whether this override is currently active. */
  enabled: boolean
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

function matchOverride(
  override: ReasoningEffortOverride,
  model: string,
): boolean {
  const normalizedMatch = override.match.trim().toLowerCase()
  if (!normalizedMatch) return false
  const normalizedModel = normalizeModel(model)
  if (normalizedMatch.endsWith('*')) {
    const prefix = normalizedMatch.slice(0, -1)
    if (!prefix) return false
    return normalizedModel.startsWith(prefix)
  }
  return normalizedModel === normalizedMatch
}

/**
 * Returns the enabled override that matches the given model, if any. Exact-id
 * matches take precedence over prefix matches; later entries (user-last order)
 * win ties. Memoization is unnecessary: the lookup is cheap and settings are
 * read once per call via the cached settings accessor.
 */
export function getReasoningEffortOverride(
  model: string,
): ReasoningEffortOverride | undefined {
  const overrides =
    getSettingsForSource('userSettings')?.reasoningEffortOverrides
  if (!overrides || overrides.length === 0) {
    return undefined
  }

  let exactMatch: ReasoningEffortOverride | undefined
  let prefixMatch: ReasoningEffortOverride | undefined

  for (const override of overrides) {
    if (!override?.enabled) continue
    if (!matchOverride(override, model)) continue
    if (override.match.trim().toLowerCase().endsWith('*')) {
      prefixMatch = override
    } else {
      exactMatch = override
    }
  }

  return exactMatch ?? prefixMatch
}

export function modelSupportsUserEffortOverride(model: string): boolean {
  return getReasoningEffortOverride(model) !== undefined
}

export function getUserEffortWireParam(model: string): string | undefined {
  return getReasoningEffortOverride(model)?.param
}

export type ReasoningEffortOverrideMutation = {
  match: string
  param: string
}

/**
 * Upserts a user override. Exact-id and prefix (`*`) entries are kept distinct;
 * matching an existing entry with the same `match` updates its `param`/enabled
 * flag rather than appending a duplicate.
 */
export function setReasoningEffortOverride(
  mutation: ReasoningEffortOverrideMutation,
): { error: Error | null } {
  const match = mutation.match.trim()
  if (!match) {
    return { error: new Error('override match cannot be empty') }
  }
  const param = mutation.param.trim()
  if (!param) {
    return { error: new Error('override param cannot be empty') }
  }

  const current =
    getSettingsForSource('userSettings')?.reasoningEffortOverrides ?? []
  const normalizedMatch = match.toLowerCase()
  const next = current.filter((o) => o.match.toLowerCase() !== normalizedMatch)
  next.push({ match, param, enabled: true })

  return updateSettingsForSource('userSettings', {
    reasoningEffortOverrides: next,
  })
}

export function disableReasoningEffortOverride(
  match: string,
): { error: Error | null } {
  const normalizedMatch = match.trim().toLowerCase()
  const current =
    getSettingsForSource('userSettings')?.reasoningEffortOverrides ?? []
  const next = current.map((o) =>
    o.match.toLowerCase() === normalizedMatch ? { ...o, enabled: false } : o,
  )
  return updateSettingsForSource('userSettings', {
    reasoningEffortOverrides: next,
  })
}

export function listReasoningEffortOverrides(): ReasoningEffortOverride[] {
  return (
    getSettingsForSource('userSettings')?.reasoningEffortOverrides ?? []
  ).slice()
}
