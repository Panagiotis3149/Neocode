# Design: `/context <size>` Context-Window Override

Date: 2026-07-26
Status: Approved (pending user review of written spec)
Scope: extend the existing `/context` slash command so a single integer arg sets a per-model context-window override for the currently selected model.

## 1. Problem

Some models in `getContextWindowForModel` resolve to the hard-coded 128k fallback because no provider-known value is set, even when the user knows the real window (e.g. a custom endpoint, a vendor that ships a larger window under a model name that the canonical catalog doesn't recognize).

Today there is no way to override at the user level. The `128k` fallback is silent and untraceable — neither the user nor our telemetry knows that a real value exists and is being shadowed by the fallback.

## 2. Goals

- Give the user a way to override the context window for the **currently selected model**, transparently visible in the existing `/context` view.
- Persist across restarts (settings.json).
- Be writable as a slash command, not a manual settings.json edit.
- Surface the resolution source (`override | provider | fallback`) so overrides are obvious in the existing visualization.

## 3. Non-Goals (YAGNI)

- `/context <model|prefix> <num>` — by deliberate user choice the override is current-model only.
- Per-prompt override flags.
- Custom picker UI for size selection.
- Auto-tuning override based on detected provider errors.
- Multi-model session overrides.

## 4. Behavior

### 4.1 Modes of `/context`

| Invocation | Effect |
|---|---|
| `/context` (no args) | Existing visualization grid, plus a new top-line showing the effective value and its resolution source. |
| `/context <size>` | Parse, validate, persist to settings.json, apply immediately. Toast confirms with delta. |
| `/context reset` | Remove the override for the current model. Falls back to next resolution layer. |
| `/context -1` / `/context 0` | Numeric aliases for `reset`. |
| Any other arg | Inline usage error in the TUI. |

### 4.2 Size parsing

Unit suffixes required, case-insensitive:

- `k` → ×1,000
- `m` → ×1,000,000

Decimals allowed only on `m` units (`0.5m` valid; `1.5k` rejected).

Validation:

- Floor: 16,384 (16k). Below 16k is rejected with `Context window must be at least 16k. Use /context reset to remove an existing override.`
- Ceiling: `MAX_INT32 = 2147483647`. Larger rejected.
- Negative (other than `-1`): `Use /context reset or /context -1 to clear.`
- Unparseable: `Usage: /context <size>  e.g. 256k, 1m, or /context reset.`

### 4.3 Resolution chain

`getContextWindowForModel(model)` gains a highest-priority layer:

```
1. settings.contextWindowOverrides[model]   ← NEW
2. provider-known value                     ← EXISTING
3. hard 128_000 fallback                    ← EXISTING
```

Function signature is unchanged. Existing callers (spinner, status row, request builder, all tests in `src/utils/context.test.ts`) keep working — they receive a transparently higher resolution for any model with an override.

## 5. Storage

Single new settings.json key, shaped to mirror `reasoningEffortOverrides` so reader/writer paths stay uniform:

```ts
// lives next to ReasoningEffortOverrides type definition
export type ContextWindowOverride = {
  contextWindowTokens: number  // resolved integer, 16384 ≤ n ≤ 2147483647
}
export type ContextWindowOverrides = Record<string, ContextWindowOverride>
// key = provider/model id as returned by the runtime (e.g. "openai/gpt-5.4").
// Implementations MUST use one canonical key shape only; if the runtime cannot
// produce a "provider/x" string, fall back to the catalog id, but never to a
// human-readable display name (collisions across providers).
```

Default: `{}`. Settings writes go through the existing `saveSettings` helper used by `/effort`. When the override is *unset* (reset), the key is *removed*, not set to `null`.

## 6. Command Wiring

`src/commands/context/index.ts` keeps two `Command` entries — the existing visualization command and the `contextNonInteractive` variant. The dispatcher logic moves into the load target:

- `!arg` → load existing `./context.js` (current view).
- `arg matches /^(reset|0|-1)$/i` → load new `./context-reset.js`.
- `arg parses to integer ∈ [16k, MAX_INT32]` → load new `./context-set.js`.
- Else → inline usage toast.

Add `argumentHint: '[size|reset]'` so the slash-completion dropdown shows hints.

The view-mode command is extended so its first row shows the effective context and resolution source (`override | provider | fallback`), colored cues.

## 7. UI

### 7.1 No-arg view (extends existing grid)

Top line, before grid cells:

```
Effective context for openai/gpt-5.4: 256k   (user override)
Effective context for acme/unknown-3p: 128k   (fallback)
```

Color cues differentiate sources; the override label is opt-in (only when present).

### 7.2 Set toast

One-line, click-to-clear (existing pattern):

`Context window for openai/gpt-5.4 set to 256k (was 128k fallback). /context reset to undo.`

`was` is computed by reading the chain as if no override existed.

### 7.3 Reset toast

`Context window override removed for openai/gpt-5.4. Effective: 128k (fallback).`

## 8. Error & Edge Handling

- **Pre-model selection**: `/context <size>` errors `No model selected. Pick a model first (e.g. /model openai/gpt-5.4).`
- **Model switch**: old override **kept** in settings.json for the old model. Re-selecting it reapplies. Other models unaffected.
- **Provider rejects request** (e.g. 400 `context_length_exceeded`): surface upstream error verbatim — no synthetic ceiling.
- **Unknown provider (128k fallback path)**: still overridable via `/context <size>`. The new layer fires above the fallback.
- **Settings write failure**: existing in-place error toast from `saveSettings`.

## 9. Components Affected

Files expected to change (no new top-level feature directories):

- `src/commands/context/index.ts` — extend dispatcher; add `argumentHint`
- `src/commands/context/context.js` — render new top line; source-color cues
- `src/commands/context/context-set.ts` — NEW: parse, validate, persist, toast
- `src/commands/context/context-reset.ts` — NEW: remove override, toast
- `src/utils/context.ts` — insert highest-priority resolution layer
- `src/utils/context.ts` (exposes new helper `getContextWindowSource(model)`)
- `src/utils/settings/types.ts` (or wherever `ReasoningEffortOverrides` is typed) — add `ContextWindowOverride` + `ContextWindowOverrides`
- `src/utils/context.test.ts` — new cases for resolution order, source labeling, parser; integration round-trip `saveSettings` test

No changes to: spinner, status row, request builders, descriptor tables, prompt catalog.

## 10. Testing

Unit (`src/utils/context.test.ts`, alongside the existing 128k fallback case):

- `getContextWindowForModel` returns the override when set.
- Removing the override restores the prior layer (provider or fallback).
- Resolution order determinism: override > provider > fallback.
- `getContextWindowSource` returns `override` / `provider` / `fallback` correctly across fixtures.

Parser unit tests:

- Accept: `256k`, `256K`, `1m`, `1M`, `0.5m`, `MAX_INT32` (`2147483647`, naked integers also OK when ≤ MAX_INT32 with no suffix).
- Reject: `1.5k`, `k`, `0` (as size — only alias for reset), `-2`, `abc`, `1g`, values > MAX_INT32, values < 16k.

Integration:

- Settings.json round-trip via existing `saveSettings` helper.
- Toast-shape snapshot tests for set and reset.

## 11. Open Questions

None at design time. Re-evaluate at implementation time only if a concrete blocker is hit.

## 12. References

- `/effort` precedent: `src/commands/effort/index.ts`, `src/utils/effort.ts`
- Existing resolution: `src/utils/context.ts::getContextWindowForModel`
- Existing settings pattern: `ReasoningEffortOverrides` — mirror exactly

_Approval gate next: user reviews this spec. Implementation will be planned by the writing-plans skill, committed locally, and not pushed._
