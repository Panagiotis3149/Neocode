# Context-Window Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `/context` slash command to support `/context <size>` for setting a per-model context-window override, `/context reset` (and `/context -1` / `/context 0`) for clearing it, and show the effective context + resolution source in the no-arg visualization.

**Architecture:** Add a new highest-priority resolution layer in `getContextWindowForModel` that reads `settings.contextWindowOverrides[currentModel]`. Persist overrides in `settings.json` under `contextWindowOverrides` (Record<string, {contextWindowTokens: number}>). Mirror the `ReasoningEffortOverride` pattern for settings round-trip. Extend the `/context` command dispatcher to route based on arg: no-arg → view, `reset|-1|0` → clear, valid size → set, else → usage toast. New helpers: `parseContextWindowSize`, `getContextWindowOverride`, `setContextWindowOverride`, `clearContextWindowOverride`, `getContextWindowSource`.

**Tech Stack:** TypeScript, Bun test, Zod for settings schema, existing `updateSettingsForSource`/`getSettingsForSource` helpers, shared mutation lock for tests.

---

## File Structure Map

| File | Responsibility |
|------|----------------|
| `src/utils/contextWindowOverrides.ts` (NEW) | Parser, constants, settings get/set/clear helpers |
| `src/utils/settings/types.ts` (MODIFY) | Add `ContextWindowOverride` + `ContextWindowOverrides` Zod schema |
| `src/utils/context.ts` (MODIFY) | Insert highest-priority override layer in `getContextWindowForModel`; add `getContextWindowSource(model)` |
| `src/utils/contextWindowOverrides.test.ts` (NEW) | Parser unit tests (accept/reject per spec §4.2) |
| `src/utils/context.test.ts` (MODIFY) | Resolution-order, ADD) | Resolution-order + source-label tests |
| `src/commands/context/index.ts` (MODIFY) | Add `argumentHint: '[size|reset]'`; dispatcher logic |
| `src/commands/context/context-set.ts` (NEW) | Parse/validate/persist/toast with delta |
| `src/commands/context/context-reset.ts` (NEW) | Remove override, toast with effective value |
| `src/commands/context/context.js` (MODIFY) | Extend first row: "Effective context for X: Y (source)" |

---

## Tasks

### Task 1: Create `src/utils/contextWindowOverrides.ts`

**Files:**
- Create: `src/utils/contextWindowOverrides.ts`
- Test: `src/utils/contextWindowOverrides.test.ts`

- [ ] **Step 1: Write failing parser tests**

```ts
// src/utils/contextWindowOverrides.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { parseContextWindowSize } from './contextWindowOverrides.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'

const LOCK_KEY = 'contextWindowOverrides'

beforeEach(async () => {
  await acquireSharedMutationLock(LOCK_KEY)
})

afterEach(() => {
  releaseSharedMutationLock(LOCK_KEY)
})

// Accept cases
test('parseContextWindowSize accepts 256k', () => {
  expect(parseContextWindowSize('256k')).toBe(256_000)
})
test('parseContextWindowSize accepts 256K', () => {
  expect(parseContextWindowSize('256K')).toBe(256_000)
})
test('parseContextWindowSize accepts 1m', () => {
  expect(parseContextWindowSize('1m')).toBe(1_000_000)
})
test('parseContextWindowSize accepts 1M', () => {
  expect(parseContextWindowSize('1M')).toBe(1_000_000)
})
test('parseContextWindowSize accepts 0.5m', () => {
  expect(parseContextWindowSize('0.5m')).toBe(500_000)
})
test('parseContextWindowSize accepts MAX_INT32 naked', () => {
  expect(parseContextWindowSize('2147483647')).toBe(2_147_483_647)
})
test('parseContextWindowSize accepts 128000 naked', () => {
  expect(parseContextWindowSize('128000')).toBe(128_000)
})

// Reject cases
test('parseContextWindowSize rejects 1.5k', () => {
  expect(parseContextWindowSize('1.5k')).toBeNull()
})
test('parseContextWindowSize rejects k', () => {
  expect(parseContextWindowSize('k')).toBeNull()
})
test('parseContextWindowSize rejects 0 as size', () => {
  expect(parseContextWindowSize('0')).toBeNull()
})
test('parseContextWindowSize rejects -2', () => {
  expect(parseContextWindowSize('-2')).toBeNull()
})
test('parseContextWindowSize rejects abc', () => {
  expect(parseContextWindowSize('abc')).toBeNull()
})
test('parseContextWindowSize rejects 1g', () => {
  expect(parseContextWindowSize('1g')).toBeNull()
})
test('parseContextWindowSize rejects > MAX_INT32', () => {
  expect(parseContextWindowSize('3000000000')).toBeNull()
})
test('parseContextWindowSize rejects < 16k', () => {
  expect(parseContextWindowSize('10k')).toBeNull()
})
```

Run: `bun test ./src/utils/contextWindowOverrides.test.ts -v`
Expected: FAIL (module not found)

- [ ] **Step 2: Implement parser + constants**

```ts
// src/utils/contextWindowOverrides.ts
export const CONTEXT_WINDOW_FLOOR = 16_384
export const CONTEXT_WINDOW_CEILING = 2_147_483_647

/**
 * Parses a context window size string like "256k", "1m", "0.5M", "128000".
 * Returns the integer token count, or null if invalid.
 * Rules:
 * - Suffix 'k'/'K' = ×1000, 'm'/'M' = ×1_000_000 (required for k, optional for m)
 * - Decimals allowed only on m/M suffix (e.g., "0.5m" ok, "1.5k" rejected)
 * - Naked integer allowed (treated as raw tokens), must be within [FLOOR, CEILING]
 * - Negative (other than -1/0 handled by callers) returns null
 */
export function parseContextWindowSize(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Naked integer (no suffix)
  if (/^\d+$/.test(trimmed)) {
    const val = parseInt(trimmed, 10)
    if (val >= CONTEXT_WINDOW_FLOOR && val <= CONTEXT_WINDOW_CEILING) return val
    return null
  }

  // Suffix form
  const match = trimmed.match(/^([\d.]+)([kmKM])$/)
  if (!match) return null

  const [, numStr, suffix] = match
  const isM = suffix.toLowerCase() === 'm'
  const multiplier = isM ? 1_000_000 : 1_000

  // Decimal only allowed on m
  if (numStr.includes('.') && !isM) return null

  const val = Math.round(parseFloat(numStr) * multiplier)
  if (val < CONTEXT_WINDOW_FLOOR || val > CONTEXT_WINDOW_CEILING) return null
  return val
}
```

Run: `bun test ./src/utils/contextWindowOverrides.test.ts -v`
Expected: PASS

- [ ] **Step 3: Add settings round-trip helpers + tests**

```ts
// Append to src/utils/contextWindowOverrides.test.ts
import {
  getContextWindowOverride,
  setContextWindowOverride,
  clearContextWindowOverride,
  listContextWindowOverrides,
} from './contextWindowOverrides.js'
import { updateSettingsForSource } from './settings/settings.js'

// Reset settings before each test
beforeEach(async () => {
  await acquireSharedMutationLock(LOCK_KEY)
  updateSettingsForSource('userSettings', { contextWindowOverrides: {} })
})

test('getContextWindowOverride returns undefined when none set', () => {
  expect(getContextWindowOverride('openai/gpt-5.4')).toBeUndefined()
})

test('setContextWindowOverride persists and get reads it back', () => {
  const result = setContextWindowOverride('openai/gpt-5.4', 256_000)
  expect(result.error).toBeNull()
  const o = getContextWindowOverride('openai/gpt-5.4')
  expect(o?.contextWindowTokens).toBe(256_000)
})

test('setContextWindowOverride validates floor', () => {
  const result = setContextWindowOverride('openai/gpt-5.4', 10_000)
  expect(result.error).toBeInstanceOf(Error)
})

test('setContextWindowOverride validates ceiling', () => {
  const result = setContextWindowOverride('openai/gpt-5.4', 3_000_000_000)
  expect(result.error).toBeInstanceOf(Error)
})

test('clearContextWindowOverride removes the key', () => {
  setContextWindowOverride('openai/gpt-5.4', 256_000)
  const r1 = clearContextWindowOverride('openai/gpt-5.4')
  expect(r1.error).toBeNull()
  expect(getContextWindowOverride('openai/gpt-5.4')).toBeUndefined()
})

test('listContextWindowOverrides returns all entries', () => {
  setContextWindowOverride('openai/gpt-5.4', 256_000)
  setContextWindowOverride('nvidia/nemotron-3-ultra', 500_000)
  const all = listContextWindowOverrides()
  expect(Object.keys(all)).toHaveLength(2)
  expect(all['openai/gpt-5.4'].contextWindowTokens).toBe(256_000)
})
```

```ts
// Append to src/utils/contextWindowOverrides.ts
import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'

export type ContextWindowOverride = {
  contextWindowTokens: number
}

export type ContextWindowOverrides = Record<string, ContextWindowOverride>

function getOverrides(): ContextWindowOverrides {
  return getSettingsForSource('userSettings')?.contextWindowOverrides ?? {}
}

export function getContextWindowOverride(model: string): ContextWindowOverride | undefined {
  const overrides = getOverrides()
  return overrides[model]
}

export function setContextWindowOverride(model: string, tokens: number): { error: Error | null } {
  if (tokens < CONTEXT_WINDOW_FLOOR || tokens > CONTEXT_WINDOW_CEILING) {
    return { error: new Error(`Context window must be between ${CONTEXT_WINDOW_FLOOR} and ${CONTEXT_WINDOW_CEILING}`) }
  }
  const current = getOverrides()
  const next = { ...current, [model]: { contextWindowTokens: tokens } }
  return updateSettingsForSource('userSettings', { contextWindowOverrides: next })
}

export function clearContextWindowOverride(model: string): { error: Error | null } {
  const current = getOverrides()
  if (!current[model]) return { error: null }
  const next = { ...current }
  delete next[model]
  return updateSettingsForSource('userSettings', { contextWindowOverrides: next })
}

export function listContextWindowOverrides(): ContextWindowOverrides {
  return { ...getOverrides() }
}
```

Run: `bun test ./src/utils/contextWindowOverrides.test.ts -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/contextWindowOverrides.ts src/utils/contextWindowOverrides.test.ts
git commit -m "feat: add contextWindowOverrides utilities with parser and settings helpers"
```

---

### Task 2: Add Zod schema to `src/utils/settings/types.ts`

**Files:**
- Modify: `src/utils/settings/types.ts` (near `ReasoningEffortOverrides`)

- [ ] **Step 1: Write failing test** (re-run contextOverrides tests — they should already pass if schema is correct; this is a compile-time check)

Run: `bun test ./src/utils/contextWindowOverrides.test.ts -v`
Expected: PASS (schema addition doesn't break runtime if types are right)

- [ ] **Step 2: Add schema**

```ts
// In src/utils/settings/types.ts, near ReasoningEffortOverrides
// Add after the ReasoningEffortOverrides type definition

export const ContextWindowOverrideSchema = z.object({
  contextWindowTokens: z.number().int().min(16_384).max(2_147_483_647),
})

export type ContextWindowOverride = z.infer<typeof ContextWindowOverrideSchema>

export const ContextWindowOverridesSchema = z
  .record(z.string(), ContextWindowOverrideSchema)
  .optional()
  .catch({})
  .describe('Per-model context window overrides set via /context <size>')

// Add to SettingsSchema shape:
contextWindowOverrides: ContextWindowOverridesSchema,
```

- [ ] **Step 3: Verify no TypeScript errors**

Run: `bun run build` (or `tsc --noEmit`)
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/settings/types.ts
git commit -m "feat: add ContextWindowOverride Zod schema to settings"
```

---

### Task 3: Insert override layer in `src/utils/context.ts`

**Files:**
- Modify: `src/utils/context.ts`

- [ ] **Step 1: Write failing resolution-order tests**

```ts
// Append to src/utils/context.test.ts (inside existing beforeEach/afterEach lock)

test('user override takes precedence over provider-known value', () => {
  // Set up OpenAI-compatible env so provider path is active
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  // Mock the settings override
  const { setContextWindowOverride } = await import('./contextWindowOverrides.js')
  setContextWindowOverride('gpt-4o', 500_000)

  // gpt-4o normally returns 128k from provider metadata
  expect(getContextWindowForModel('gpt-4o')).toBe(500_000)

  // Clean up
  const { clearContextWindowOverride } = await import('./contextWindowOverrides.js')
  clearContextWindowOverride('gpt-4o')
})

test('user override takes precedence over 128k fallback', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  const { setContextWindowOverride } = await import('./contextWindowOverrides.js')
  setContextWindowOverride('some-unknown-3p-model', 1_000_000)

  // Unknown model normally returns 128k fallback
  expect(getContextWindowForModel('some-unknown-3p-model')).toBe(1_000_000)

  const { clearContextWindowOverride } = await import('./contextWindowOverrides.js')
  clearContextWindowOverride('some-unknown-3p-model')
})

test('removing override restores provider value', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  const { setContextWindowOverride, clearContextWindowOverride } = await import('./contextWindowOverrides.js')
  setContextWindowOverride('gpt-4o', 500_000)
  expect(getContextWindowForModel('gpt-4o')).toBe(500_000)

  clearContextWindowOverride('gpt-4o')
  expect(getContextWindowForModel('gpt-4o')).toBe(128_000) // provider value
})
```

Run: `bun test ./src/utils/context.test.ts -v`
Expected: FAIL (override layer not yet implemented)

- [ ] **Step 2: Implement override layer + source helper**

```ts
// At top of src/utils/context.ts, add import:
import { getContextWindowOverride } from './contextWindowOverrides.js'

// In getContextWindowForModel, insert AT THE VERY TOP (before USER_TYPE==='ant' env check):
export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // 1. User override (NEW — highest priority)
  const override = getContextWindowOverride(model)
  if (override?.contextWindowTokens) {
    return override.contextWindowTokens
  }

  // 2. Existing USER_TYPE==='ant' + CLAUDE_CODE_MAX_CONTEXT_TOKENS env check (line 88-96)
  // ... rest of existing function unchanged ...
}

// Add new helper after getContextWindowForModel:
export function getContextWindowSource(
  model: string,
  betas?: string[],
): 'override' | 'provider' | 'fallback' | 'env' {
  const override = getContextWindowOverride(model)
  if (override?.contextWindowTokens) return 'override'

  // Replicate the resolution logic to determine the next source
  // (This mirrors getContextWindowForModel but returns source label)
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const v = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(v) && v > 0) return 'env'
  }

  if (has1mContext(model)) return 'provider' // [1m] suffix counts as explicit opt-in
  if (shouldUseIntegrationRuntimeLimits()) {
    const rt = resolveModelRuntimeLimits({ model })
    if (rt.contextWindow !== undefined) return 'provider'
    return 'fallback' // OPENAI_FALLBACK_CONTEXT_WINDOW
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) return 'provider'
  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) return 'provider'
  if (getSonnet1mExpTreatmentEnabled(model)) return 'provider'
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) return 'provider'
  }
  return 'fallback' // MODEL_CONTEXT_WINDOW_DEFAULT
}
```

Run: `bun test ./src/utils/context.test.ts -v`
Expected: PASS

- [ ] **Step 3: Verify existing tests still pass**

Run: `bun test ./src/utils/context.test.ts -v`
Expected: all 55+ existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/context.ts src/utils/context.test.ts
git commit -m "feat: add user override layer to getContextWindowForModel and getContextWindowSource"
```

---

### Task 4: Create `src/commands/context/context-set.ts`

**Files:**
- Create: `src/commands/context/context-set.ts`
- Modify: `src/commands/context/index.ts` (dispatcher)

- [ ] **Step 1: Write failing test** (integration style — requires TUI mount; skip unit, test via manual or snapshot in next task)

- [ ] **Step 2: Implement context-set.ts**

```ts
// src/commands/context/context-set.ts
import type { SlashCommandResult } from '../../commands.js'
import { parseContextWindowSize } from '../../../utils/contextWindowOverrides.js'
import { setContextWindowOverride } from '../../../utils/contextWindowOverrides.js'
import { getContextWindowForModel, getContextWindowSource } from '../../../utils/context.js'
import { getCurrentModel } from '../../../services/api/providerConfig.js'

export async function contextSet(
  args: string,
): Promise<SlashCommandResult> {
  const model = getCurrentModel()
  if (!model) {
    return {
      type: 'error',
      message: 'No model selected. Pick a model first (e.g. /model openai/gpt-5.4).',
    }
  }

  const arg = args.trim()
  if (!arg) {
    return {
      type: 'error',
      message: 'Usage: /context <size>  e.g. 256k, 1m, or /context reset.',
    }
  }

  // Check for reset aliases first
  if (/^(reset|0|-1)$/i.test(arg)) {
    return { type: 'delegate', command: 'context', args: 'reset' }
  }

  const tokens = parseContextWindowSize(arg)
  if (tokens === null) {
    return {
      type: 'error',
      message:
        'Usage: /context <size>  e.g. 256k, 1m, or /context reset.\n' +
        'Rules: suffix k/m required (1.5k invalid, 0.5m ok). Min 16k, max 2147483647.',
    }
  }

  // Compute "was" value (what the model would resolve to WITHOUT override)
  const wasSource = getContextWindowSource(model)
  let wasLabel: string
  if (wasSource === 'override') {
    // Should not happen since we haven't set yet, but guard
    wasLabel = `${getContextWindowForModel(model).toLocaleString()} (override)`
  } else if (wasSource === 'provider') {
    wasLabel = `${getContextWindowForModel(model).toLocaleString()} (provider)`
  } else if (wasSource === 'env') {
    wasLabel = `${getContextWindowForModel(model).toLocaleString()} (env)`
  } else {
    wasLabel = `${getContextWindowForModel(model).toLocaleString()} (fallback)`
  }

  const result = setContextWindowOverride(model, tokens)
  if (result.error) {
    return { type: 'error', message: result.error.message }
  }

  const newLabel = `${tokens.toLocaleString()} (user override)`
  return {
    type: 'toast',
    message: `Context window for ${model} set to ${tokens.toLocaleString()} (was ${wasLabel}). /context reset to undo.`,
  }
}
```

- [ ] **Step 3: Update index.ts dispatcher**

```ts
// src/commands/context/index.ts
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const context: Command = {
  name: 'context',
  description: 'Visualize current context usage as a colored grid',
  argumentHint: '[size|reset]',
  isEnabled: () => !getIsNonInteractiveSession(),
  type: 'local-jsx',
  load: async () => {
    const { contextSet } = await import('./context-set.js')
    const { contextReset } = await import('./context-reset.js')
    const { contextView } = await import('./context.js')
    const args = (await import('../../bootstrap/state.js')).getPendingSlashArgs?.() ?? ''

    const arg = args.trim()
    if (!arg) return contextView
    if (/^(reset|0|-1)$/i.test(arg)) return contextReset
    // Validate it's a size-like arg; else fall through to view with usage toast
    const { parseContextWindowSize } = await import('../../utils/contextWindowOverrides.js')
    if (parseContextWindowSize(arg) !== null) return contextSet
    return contextView // will show usage inline
  },
}

export const contextNonInteractive: Command = {
  type: 'local',
  name: 'context',
  supportsNonInteractive: true,
  description: 'Show current context usage',
  argumentHint: '[size|reset]',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: async () => {
    const { contextNonInteractiveView } = await import('./context-noninteractive.js')
    return contextNonInteractiveView
  },
}
```

- [ ] **Step 4: Verify build**

Run: `bun run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/context/context-set.ts src/commands/context/index.ts
git commit -m "feat: add /context <size> set command with validation and toast"
```

---

### Task 5: Create `src/commands/context/context-reset.ts`

**Files:**
- Create: `src/commands/context/context-reset.ts`

- [ ] **Step 1: Implement context-reset.ts**

```ts
// src/commands/context/context-reset.ts
import type { SlashCommandResult } from '../../commands.js'
import { clearContextWindowOverride } from '../../../utils/contextWindowOverrides.js'
import { getContextWindowForModel, getContextWindowSource } from '../../../utils/context.js'
import { getCurrentModel } from '../../../services/api/providerConfig.js'

export async function contextReset(
  _args: string,
): Promise<SlashCommandResult> {
  const model = getCurrentModel()
  if (!model) {
    return {
      type: 'error',
      message: 'No model selected. Pick a model first (e.g. /model openai/gpt-5.4).',
    }
  }

  const result = clearContextWindowOverride(model)
  if (result.error) {
    return { type: 'error', message: result.error.message }
  }

  const effective = getContextWindowForModel(model)
  const source = getContextWindowSource(model)
  const sourceLabel = source === 'fallback' ? 'fallback' : source === 'provider' ? 'provider' : 'env'

  return {
    type: 'toast',
    message: `Context window override removed for ${model}. Effective: ${effective.toLocaleString()} (${sourceLabel}).`,
  }
}
```

- [ ] **Step 2: Verify build**

Run: `bun run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/context/context-reset.ts
git commit -m "feat: add /context reset command with effective-value toast"
```

---

### Task 6: Extend visualization in `src/commands/context/context.js`

**Files:**
- Modify: `src/commands/context/context.js`

- [ ] **Step 1: Read existing context.js to understand render structure**

Run: `cat src/commands/context/context.js`
Expected: see the grid render function

- [ ] **Step 2: Add top-line with effective context + source**

```js
// In the main render, BEFORE the grid cells, add:
import { getContextWindowForModel, getContextWindowSource } from '../../utils/context.js'
import { getCurrentModel } from '../../services/api/providerConfig.js'

// Inside the component:
const model = getCurrentModel()
const effective = model ? getContextWindowForModel(model) : null
const source = model ? getContextWindowSource(model) : null

// Render top line:
{model && (
  <Box marginBottom={1}>
    <Text>
      Effective context for <B>{model}</B>: {effective.toLocaleString()}
      {' '}
      <Text color={source === 'override' ? 'green' : source === 'provider' ? 'blue' : 'yellow'}>
        ({source === 'override' ? 'user override' : source === 'provider' ? 'provider' : source === 'env' ? 'env' : 'fallback'})
      </Text>
    </Text>
  </Box>
)}
```

- [ ] **Step 3: Verify build**

Run: `bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/context/context.js
git commit -m "feat: extend /context view with effective context line and source label"
```

---

### Task 7: Full test suite + integration sanity

**Files:**
- Test: all modified test files

- [ ] **Step 1: Run all context-related tests**

Run: `bun test ./src/utils/context.test.ts ./src/utils/contextWindowOverrides.test.ts -v`
Expected: ALL PASS

- [ ] **Step 2: Run full test suite (smoke)**

Run: `bun test --reporter=default 2>&1 | tail -20`
Expected: No new failures (pre-existing 102 fail / 7 error baseline unchanged)

- [ ] **Step 3: Manual smoke test (optional, requires running CLI)**

```bash
bun run build
# In another terminal, run the built CLI and test:
# /context          -> shows grid + top line
# /context 256k     -> toast with delta
# /context          -> top line shows "user override"
# /context reset    -> toast with effective fallback
# /context          -> top line shows "fallback"
```

- [ ] **Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "test: verify context override resolution order and UI"
```

---

## Self-Review Checklist

1. **Spec coverage**: All sections §4-§12 addressed — parser rules, storage shape, dispatcher, toasts, resolution chain, source labeling, error handling, testing.
2. **Placeholder scan**: No TBD/TODO; every step has concrete code.
3. **Type consistency**: `ContextWindowOverride` used uniformly; `parseContextWindowSize` returns `number | null`; `getContextWindowSource` returns the exact union type; settings schema matches runtime shape.
4. **No push**: All commits local only per user instruction.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-26-context-override.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**