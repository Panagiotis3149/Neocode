# Backup Tokens + Provider Multi-Key Fixes

**Date:** 2026-06-25
**Status:** Approved

## Goal

Fix four related issues in the backup-tokens and provider-management systems so that:

1. The custom reset-time editor in `/backuptokens` has working save/exit keybinds.
2. The "add another key" option appears when editing a provider's API key (not only during setup).
3. Adding another key registers it with the backup-tokens system instead of creating extra provider entries.
4. Backup keys actually fall back to the next key on a 429 rate-limit response.

Additionally, the reset scheduler should use UNIX time, run on boot and every 5 minutes, and always treat the first key as the default.

## Current state (what exists)

- `src/commands/backuptokens/backuptokens.tsx` — Settings tab with a custom reset-time editor (lines 359–430). Uses `useTextInput` with `onSubmit`/`onExit` but no `Editor` keybinding context is registered, so Enter/Esc in input mode have no effect. Only the `Confirmation` context is registered, gated by `!isCustomEditorVisible`.
- `src/components/ProviderManager.tsx` — Setup flow offers "Add another key?" after the API key field. Edit flow (`handleEditProfile`, lines ~1477–1804) does not.
- `src/services/api/backupTokenManager.ts` — `getActiveApiKey`, `notifyRateLimitError`, `consumePendingRotation`, `switchToNextToken`. Reads `backupTokenProviders[providerName]` from global config. First key in the array is the default.
- `src/services/api/withRetry.ts` — On HTTP 429, calls `notifyRateLimitError(error)`. On retry, calls `consumePendingRotation()` to pop a pending rotation and rebuild the client.
- `src/services/api/client.ts` — Calls `getActiveApiKey(providerName)` to pick the key for each request.
- `src/utils/config.ts` — `backupTokenProviders?: Record<string, string[]>` (line 659). No reset-schedule field yet.
- `src/keybindings/schema.ts`, `types.ts`, `defaultBindings.ts` — Define contexts and actions. No `Editor` context, no `editor:save` / `editor:exit` actions.

## Files to change

| File | Change |
|------|--------|
| `src/keybindings/types.ts` | Add `'Editor'` to `KeybindingContextName`; add `'editor:save'` and `'editor:exit'` to `KeybindingAction`. |
| `src/keybindings/schema.ts` | Add `'Editor'` to `KEYBINDING_CONTEXTS` and a description to `KEYBINDING_CONTEXT_DESCRIPTIONS`; add the two actions to `KEYBINDING_ACTIONS`. |
| `src/keybindings/defaultBindings.ts` | Add an `Editor` block: `enter → editor:save`, `escape → editor:exit`. |
| `src/commands/backuptokens/backuptokens.tsx` | Register `useRegisterKeybindingContext('Editor', isCustomEditorVisible)`; wire `useKeybinding('editor:save', ...)` to the existing `onSubmit` and `useKeybinding('editor:exit', ...)` to the existing `onExit`. Add boot-time + 5-min reset poller. |
| `src/components/ProviderManager.tsx` | Render the "Add another key?" prompt in the edit flow's API key step, mirroring the setup flow. |
| `src/services/api/backupTokenManager.ts` | Add `addBackupTokenProvider`, `getProviderByApiKey`, `getNextResetAt`, `scheduleNextResetAt`, `resetAllKeysToDefault`. Make `activeKeys` module-level so rotation state survives across calls. |
| `src/services/api/withRetry.ts` | Fix provider-key lookup so a 429 on the active key enqueues a rotation for the right provider. |
| `src/utils/config.ts` | Add `backupTokenResetSchedule?: Record<string, number>` (UNIX ms, keyed by provider name). |
| `docs/superpowers/specs/2026-06-25-backup-tokens-fix-design.md` | This document. |

## Detailed design

### 1. Editor keybinding context for the custom reset-time editor

Add a new keybinding context `Editor` with two actions:

- `editor:save` — default binding `enter`. Calls the `onSubmit` callback already passed to `useTextInput` in the custom editor view (saves the time string and closes the editor).
- `editor:exit` — default binding `escape`. Calls the `onExit` callback (closes the editor without saving).

In `backuptokens.tsx`, register the context only while the custom editor is visible:

```ts
const isCustomEditorVisible = activeField === 'customResetTime'
useRegisterKeybindingContext('Editor', isCustomEditorVisible)
```

Then inside the custom editor view:

```ts
useKeybinding('editor:save', () => {
  update({ customResetTime: customResetTime })
  setActiveField(null)
})
useKeybinding('editor:exit', () => {
  setActiveField(null)
})
```

The existing `useTextInput` already handles Enter/Esc in raw input mode; the explicit `useKeybinding` calls ensure the same callbacks fire even when the input is not the focused leaf, and they make the bindings user-rebindable.

### 2. Multi-key option in the edit-provider flow

In `ProviderManager.tsx`, the edit flow's API key step currently renders a single `TextInput` for `apiKey`. After the user submits a value, render the same "Add another key?" prompt that the setup flow shows:

```tsx
{!hasAddedBackupKeys && (
  <Box>
    <Text>Add another key for backup rotation? (y/n)</Text>
  </Box>
)}
```

On `y`, open a second `TextInput` for the backup key and call `addBackupTokenProvider(providerName, key)` on submit. Repeat until the user declines. This mirrors the setup flow exactly, so the two code paths can share a small helper (`promptAndAddBackupKeys`) if desired — but a direct copy is acceptable since the surrounding state (draft vs edit) differs.

### 3. Register keys with backup-tokens, not as extra providers

Replace the current setup-flow behavior (which creates additional provider entries with different API keys) with a call to `addBackupTokenProvider(providerName, key)`:

```ts
export function addBackupTokenProvider(providerName: string, key: string): void {
  const config = getGlobalConfig()
  const existing = config.backupTokenProviders?.[providerName] ?? []
  if (existing.includes(key)) return
  saveGlobalConfig({
    ...config,
    backupTokenProviders: {
      ...config.backupTokenProviders,
      [providerName]: [...existing, key],
    },
  })
}
```

The first key entered becomes `backupTokenProviders[providerName][0]` — the default. `getActiveApiKey` already returns index 0 when `activeKeys[provider]` is unset, so the default invariant holds automatically.

Note: when a provider is first created via `/provider`, the primary key is written to `profile.apiKey`. The setup flow must also seed `backupTokenProviders[providerName] = [primaryKey]` at that point, so the runtime manager has a key array to rotate into. Subsequent "add another key" calls append to this array.

### 4. Fix 429 fallback

Two compounding bugs:

**4a. Rotation state not preserved.** `activeKeys` is currently scoped such that it can be re-initialized between calls. Make it module-level in `backupTokenManager.ts`:

```ts
const activeKeys: Record<string, number> = {}
```

This survives across `getActiveApiKey` / `notifyRateLimitError` / `consumePendingRotation` calls within a session.

**4b. Provider-key lookup.** `withRetry.ts` calls `notifyRateLimitError(error)` with the API error, but the manager needs the provider name to find the right key array. Add a reverse lookup:

```ts
export function getProviderByApiKey(apiKey: string): string | undefined {
  const config = getGlobalConfig()
  for (const [provider, keys] of Object.entries(config.backupTokenProviders ?? {})) {
    if (keys.includes(apiKey)) return provider
  }
  return undefined
}
```

In `withRetry.ts`, before calling `notifyRateLimitError`, resolve the provider from the active key used for the failed request and pass it through. The manager then enqueues rotation for that specific provider.

### 5. Reset scheduling with UNIX time

Add to `backupTokenManager.ts`:

```ts
export function getNextResetAt(spec: string, now: number = Date.now()): number
export function scheduleNextResetAt(providerName: string, spec: string): void
export function resetAllKeysToDefault(providerName: string): void
```

- `getNextResetAt` parses the spec. Supported forms:
  - Relative durations: `"2 days"`, `"1d"`, `"5mo 4d 3m 1s"` → `now + parsedMs`.
  - Weekly schedules: `"next 2AM"`, `"every Monday 09:00"` → next matching wall-clock time.
  - Falls back to `now + 3600_000` (1 hour) if parsing fails, matching the existing `getResetIntervalMs` default.
- `scheduleNextResetAt` computes the next occurrence and persists it to `config.backupTokenResetSchedule[providerName]`.
- `resetAllKeysToDefault` sets `activeKeys[providerName] = 0` and clears any pending rotation.

In `backuptokens.tsx`, add a poller:

```ts
useEffect(() => {
  let cancelled = false
  const tick = () => {
    if (cancelled) return
    const now = Date.now()
    for (const [provider, keys] of Object.entries(backupTokenProviders)) {
      if (keys.length <= 1) continue
      const spec = customResetTime
      const next = config.backupTokenResetSchedule?.[provider] ?? 0
      if (now >= next) {
        resetAllKeysToDefault(provider)
        scheduleNextResetAt(provider, spec)
      }
    }
  }
  tick() // on mount (boot within this screen)
  const interval = setInterval(tick, 5 * 60 * 1000)
  return () => { cancelled = true; clearInterval(interval) }
}, [backupTokenProviders, customResetTime])
```

Additionally, invoke `scheduleNextResetAt` from the API client initialization path (e.g., `client.ts` or a boot hook) so the schedule is set at process start even if the user never opens `/backuptokens`. The 5-minute heartbeat, however, only needs to run while the settings screen is open — outside that screen, the next-reset check happens lazily on the next API call via `getActiveApiKey`.

## Data flow

```
User flow:
  /providers → enter API key → "Add another key?" → Y → enter key 2 → ...
      ↳ each key appended to backupTokenProviders[provider].keys[]

Runtime:
  API call fails 429
    → withRetry.notifyRateLimitError(apiKey)
    → getProviderByApiKey(apiKey) → provider
    → enqueue rotation for provider
    → consumePendingRotation advances activeKeys[provider]
  next call to getActiveApiKey(provider)
    → returns keys[activeKeys[provider]]

Reset loop (every boot + every 5 min):
  parse customResetTime spec
  nextResetAt = getNextResetAt(spec, Date.now())
  persist to backupTokenResetSchedule[provider]
  if Date.now() >= nextResetAt → resetAllKeysToDefault(provider)
```

## Trade-offs considered

| Decision | Alternatives | Why chosen |
|----------|--------------|------------|
| New `Editor` keybinding context | Reuse `Confirmation`; rely on `useTextInput` alone | Reusing Confirmation leaks `Esc = No` into the input. `useTextInput` alone doesn't make the binds rebindable. New context is cleanest. |
| Inline multi-key prompt in edit flow | Extra form step; separate menu item | Cheapest, consistent with setup flow. |
| `addBackupTokenProvider` writes to `backupTokenProviders` | Write to `profile.apiKeys` | `backupTokenProviders` is the existing source of truth for the runtime manager; `profile.apiKeys` is a separate, currently-unused field. Keep one source. |
| Module-level `activeKeys` | Per-manager-instance state | Survives across calls within a session; matches the existing `pendingRotation` pattern. |
| Manual date math for reset scheduling | `node-cron` or similar | Spec is simple relative offsets and weekly schedules; no need for a cron dependency. |
| Scan `backupTokenProviders` on 429 for reverse lookup | Maintain a reverse index | Small N (few providers, few keys each); scan is simple and correct. |

## Out of scope

- Persisting `activeKeys` across process restarts (rotation resets to default on restart — acceptable).
- Migrating existing `profile.apiKeys` data (field is unused in the current code path).
- UI for viewing/editing the reset schedule (the custom-time editor is sufficient).
- Per-key rate-limit tracking (all keys share one rotation pointer).

## Verification

- Manual: open `/backuptokens`, select Custom for reset time, type a value, press Enter → editor closes and value persists. Press Esc → editor closes without saving.
- Manual: open `/provider`, edit a provider, enter an API key, answer `y` to "Add another key?", enter a second key → both keys appear in the Providers tab of `/backuptokens` and no extra provider entries are created.
- Manual: configure two keys for a provider, trigger a 429 (e.g., by exceeding a rate limit), observe the next request uses the second key.
- Manual: set a custom reset spec of `"1m"`, wait 65 seconds, observe the active key index returns to 0.
