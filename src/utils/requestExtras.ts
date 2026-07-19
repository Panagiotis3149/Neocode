import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'

/**
 * Generic, user-configured request-body overrides expressed as raw JSON.
 *
 * Unlike the `reasoningEffortOverrides` (which emit a single flat wire param
 * driven by the current effort level), this lets the user inject *arbitrary*
 * nested provider params — e.g. an OpenRouter/Novita model that needs
 * `extra_body.chat_template_kwargs.reasoning_effort` set deep inside the body.
 *
 * Matching "places":
 *   - exact model id          e.g. "tencent/hy3-20260706:free"
 *   - prefix pattern          e.g. "tencent/*" or "openrouter/*" (provider)
 *   - global wildcard "*"     applied to every model
 *
 * Entries are deep-merged in priority order (global < prefix < exact), so an
 * exact/more-specific entry wins. Within the JSON, the literal string
 * "$reasoning_effort" is substituted with the resolved effort level for the
 * request (e.g. "low" | "medium" | "high"), allowing dynamic values instead
 * of a hard-coded constant.
 */
export type RequestExtraOverride = {
  /** Exact model id, a prefix ending with '*', or '*' for global. */
  match: string
  /** Arbitrary nested JSON object merged into the request body. */
  json: Record<string, unknown>
  /** Whether this override is currently active. */
  enabled: boolean
}

/** Sentinel string in the JSON that is replaced by the current effort level. */
export const REASONING_EFFORT_PLACEHOLDER = '$reasoning_effort'

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

export function matchOverride(override: RequestExtraOverride, model: string): boolean {
  const normalizedMatch = override.match.trim().toLowerCase()
  if (!normalizedMatch) return false
  if (normalizedMatch === '*') return true
  if (normalizedMatch.endsWith('*')) {
    const prefix = normalizedMatch.slice(0, -1)
    if (!prefix) return false
    return normalizeModel(model).startsWith(prefix)
  }
  return normalizeModel(model) === normalizedMatch
}

function priority(override: RequestExtraOverride): number {
  const m = override.match.trim().toLowerCase()
  if (m === '*') return 0
  if (m.endsWith('*')) return 1
  return 2
}

/**
 * Recursively merge `source` into `target`, returning a new object.
 * Objects merge deeply; arrays and primitives are replaced (source wins).
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = Array.isArray(target)
    ? [...(target as unknown[])]
    : { ...target }
  for (const [key, value] of Object.entries(source)) {
    const existing = (out as Record<string, unknown>)[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      ;(out as Record<string, unknown>)[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      ;(out as Record<string, unknown>)[key] = value
    }
  }
  return out
}

/** Mutating deep-merge variant: merges `source` into `target` in place. */
export function deepMergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const merged = deepMerge(target, source)
  for (const key of Object.keys(merged)) {
    ;(target as Record<string, unknown>)[key] = merged[key]
  }
}

function substitutePlaceholder(
  value: unknown,
  effort: string,
): unknown {
  if (typeof value === 'string') {
    if (value === REASONING_EFFORT_PLACEHOLDER) {
      return effort
    }
    return value.replace(
      new RegExp(`\\${REASONING_EFFORT_PLACEHOLDER}`, 'g'),
      effort,
    )
  }
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((v) => substitutePlaceholder(v, effort))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePlaceholder(v, effort)
    }
    return out
  }
  return value
}

export type MergedExtrasOptions = {
  /** Current resolved reasoning effort level for this request. */
  reasoningEffort?: string
}

/**
 * Returns the deep-merged JSON for a model, applying all matching enabled
 * overrides in priority order, then substituting the effort placeholder.
 */
export function getMergedRequestExtras(
  model: string,
  opts?: MergedExtrasOptions,
): Record<string, unknown> {
  const overrides =
    getSettingsForSource('userSettings')?.requestExtraOverrides
  if (!overrides || overrides.length === 0) {
    return {}
  }

  const matching = overrides
    .filter((o) => o?.enabled && matchOverride(o, model))
    .sort((a, b) => priority(a) - priority(b))

  if (matching.length === 0) return {}

  let merged: Record<string, unknown> = {}
  for (const override of matching) {
    merged = deepMerge(merged, override.json)
  }

  if (opts?.reasoningEffort) {
    merged = substitutePlaceholder(merged, opts.reasoningEffort) as Record<
      string,
      unknown
    >
  }

  return merged
}

export type RequestExtraMutation = {
  match: string
  json: Record<string, unknown>
}

export function setRequestExtraOverride(
  mutation: RequestExtraMutation,
): { error: Error | null; entry?: RequestExtraOverride } {
  const match = mutation.match.trim()
  if (!match) {
    return { error: new Error('override match cannot be empty') }
  }
  if (
    !mutation.json ||
    typeof mutation.json !== 'object' ||
    Array.isArray(mutation.json)
  ) {
    return { error: new Error('override json must be an object') }
  }

  const current =
    getSettingsForSource('userSettings')?.requestExtraOverrides ?? []
  const normalizedMatch = match.toLowerCase()
  const next = current.filter(
    (o) => o.match.toLowerCase() !== normalizedMatch,
  )
  const entry: RequestExtraOverride = {
    match,
    json: mutation.json,
    enabled: true,
  }
  next.push(entry)
  const result = updateSettingsForSource('userSettings', {
    requestExtraOverrides: next,
  })
  if (result.error) {
    return { error: result.error }
  }
  return { error: null, entry }
}

export function disableRequestExtraOverride(
  match: string,
): { error: Error | null } {
  const normalizedMatch = match.trim().toLowerCase()
  if (!normalizedMatch) {
    return { error: new Error('override match cannot be empty') }
  }
  const current =
    getSettingsForSource('userSettings')?.requestExtraOverrides ?? []
  const next = current.map((o) =>
    o.match.toLowerCase() === normalizedMatch ? { ...o, enabled: false } : o,
  )
  return updateSettingsForSource('userSettings', {
    requestExtraOverrides: next,
  })
}

export function listRequestExtraOverrides(): RequestExtraOverride[] {
  return (
    getSettingsForSource('userSettings')?.requestExtraOverrides ?? []
  ).slice()
}
