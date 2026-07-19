// Shorthand (+500k) anchored to start/end to avoid false positives in natural language.
// Verbose (use/spend 2M tokens) matches anywhere.
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
// Lookbehind (?<=\s) is avoided — it defeats YARR JIT in JSC, and the
// interpreter scans O(n) even with the $ anchor. Capture the whitespace
// instead; callers offset match.index by 1 where position matters.
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
// Prefix variants (all capture nothing) before the mandatory "<n><unit> tokens":
//   "use 2M tokens", "spend 2M tokens"
//   "use less than 2M tokens"
//   "no more than 2M tokens" / "no more 2M tokens"
//   "maximum of 2M tokens", "max 2M tokens"
//   "at most 2M tokens"
// The prefix is captured (group 1) so we can distinguish a soft TARGET
// ("use 2M tokens") from a hard CAP ("less than 2M tokens" etc).
const VERBOSE_PREFIX_RE =
  /(?:(?:use|spend)\s+less\s+than\s+|no\s+more(?:\s+than)?\s+|maximum\s+of\s+|max\s+of\s+|max\s+|at\s+most\s+|(?:use|spend)\s+)/i
const VERBOSE_RE = new RegExp(
  String.raw`\b(${VERBOSE_PREFIX_RE.source})(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b`,
  'i',
)
const VERBOSE_RE_G = new RegExp(VERBOSE_RE.source, 'gi')

// A cap-style prefix hard-limits output (stop at the limit, never nudge to
// reach it). Anything else ("use"/"spend" alone) is a soft target.
const CAP_DETECT_RE =
  /less\s+than|no\s+more(?:\s+than)?|maximum\s+of|max\s+of|at\s+most|\bmax\b/i

export type TokenBudgetMode = 'target' | 'cap'

export interface ParsedTokenBudget {
  budget: number
  mode: TokenBudgetMode
}

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

function parseBudgetMatch(value: string, suffix: string): number {
  return parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!
}

// Negation guard: reject a verbose match when preceded by a negation phrase
// (e.g. "do not use 2M tokens"). Lookbehind is intentionally avoided (JSC YARR
// regresses with it), so we inspect the text before match.index instead.
const NEGATION_RE = /\b(?:do\s+not|don't|does\s+not|doesn't|never|without|avoid|refrain\s+from)\s+[a-z']*\s*$/i
function isNegatedMatch(text: string, matchIndex: number): boolean {
  const before = text.slice(0, matchIndex)
  return NEGATION_RE.test(before)
}

function modeForVerboseMatch(verboseMatch: RegExpMatchArray): TokenBudgetMode {
  // group 1 is the captured prefix; CAP_DETECT_RE tests whether it is a
  // cap-style phrasing. The shorthand forms have no such phrasing, so they
  // are always a soft target.
  const prefix = verboseMatch[1] ?? ''
  return CAP_DETECT_RE.test(prefix) ? 'cap' : 'target'
}

// Parses a token budget, returning null when none present OR when the match
// is a negated instruction (e.g. "do not use 2M tokens"). When present, the
// `mode` distinguishes a soft TARGET ("use 2M tokens" — nudge to reach ~90%)
// from a hard CAP ("less than 2M tokens" — stop at the limit, never nudge).
export function parseTokenBudgetWithMode(
  text: string,
): ParsedTokenBudget | null {
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) {
    return { budget: parseBudgetMatch(startMatch[1]!, startMatch[2]!), mode: 'target' }
  }
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) {
    return { budget: parseBudgetMatch(endMatch[1]!, endMatch[2]!), mode: 'target' }
  }
  const verboseMatch = text.match(VERBOSE_RE)
  if (
    verboseMatch &&
    !isNegatedMatch(text, verboseMatch.index ?? 0)
  ) {
    return {
      budget: parseBudgetMatch(verboseMatch[2]!, verboseMatch[3]!),
      mode: modeForVerboseMatch(verboseMatch),
    }
  }
  return null
}

// Backwards-compatible: returns just the budget number (mode ignored).
export function parseTokenBudget(text: string): number | null {
  const parsed = parseTokenBudgetWithMode(text)
  return parsed ? parsed.budget : null
}

export function findTokenBudgetPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) {
    const offset =
      startMatch.index! +
      startMatch[0].length -
      startMatch[0].trimStart().length
    positions.push({
      start: offset,
      end: startMatch.index! + startMatch[0].length,
    })
  }
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) {
    // Avoid double-counting when input is just "+500k"
    const endStart = endMatch.index! + 1 // +1: regex includes leading \s
    const alreadyCovered = positions.some(
      p => endStart >= p.start && endStart < p.end,
    )
    if (!alreadyCovered) {
      positions.push({
        start: endStart,
        end: endMatch.index! + endMatch[0].length,
      })
    }
  }
  for (const match of text.matchAll(VERBOSE_RE_G)) {
    // Skip negated instructions (e.g. "do not use 2M tokens") — they are not
    // a budget and must not be highlighted as one.
    if (isNegatedMatch(text, match.index ?? 0)) continue
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  return positions
}

export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number): string => new Intl.NumberFormat('en-US').format(n)
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working \u2014 do not summarize.`
}
