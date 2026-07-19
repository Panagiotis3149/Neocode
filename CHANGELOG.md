# Changelog

All notable changes to Neocode are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.18.2] - 2026-07-19

### Performance

Skidded five upstream performance-fix PRs from `Gitlawb/openclaude` into NeoCode:

- **PR #1869 — Universal tool-history compression + doom-loop guard + configurable
  auto-compact tail.**
  - `compressToolHistory` (shim) now also runs on Anthropic-native transports
    (firstParty / bedrock / vertex / GitHub-native-anthropic) when prompt caching is
    inactive, so long sessions stop saturating context (`src/services/api/claude.ts`).
  - New `doomLoop.ts` blocks the Nth (default 3rd) consecutive identical tool call per
    agent and returns an `is_error` tool_result instructing the model to change approach
    (`src/utils/doomLoop.ts`, wired in `src/services/tools/toolExecution.ts`,
    reset per query turn in `src/query.ts`).
  - `compactTailTurns` global config (default 3) replaces the hardcoded `preserveRecent`
    in `pruneByRelevance` (`src/utils/config.ts`, `src/services/compact/autoCompact.ts`,
    Settings UI in `src/components/Settings/Config.tsx`).
  - `compressToolHistory` idempotency: a second pass over already-compressed output is a
    no-op via stub/truncation markers (`src/services/api/compressToolHistory.ts`).
- **PR #1948 — Bounded file-IO concurrency.** `src/utils/boundedAsync.ts` limits parallel
  file reads so a large glob/read burst can't exhaust FDs or thrash disk.
- **PR #1744 — Batched streaming + cached message normalization.** `streamingTextPublish`
  coalesces assistant-text updates; `normalizeMessagesCached` memoizes normalization and
  `onStreamingToolUses` mutates in place to avoid per-token rebuilds
  (`src/screens/streamingTextPublish.ts`, `src/utils/messages.ts`, `src/screens/REPL.tsx`).
- **PR #1743 — CLI bundle minification.** Production bundle is minified to cut startup
  parse time (`scripts/build.ts`).
- **PR #1478 — `response.clone()` + lazy tool getters.** Streaming responses are cloned
  for side-channel reads and tool descriptors are lazily produced to defer heavy
  initialization (`src/tools.ts`).

> All five ports retain upstream control flow and edge-case handling; `bun run build`
> passes. Unit tests: `doomLoop.test.ts` (12/12). NOTE: `compressToolHistory.test.ts`
> and the `messages.*` tests are currently blocked in this bun-test environment by a
> pre-existing `src/constants/tools.ts` TDZ circular-import error (unrelated to these
> PRs) — the build and `doomLoop` unit path are unaffected.

## [0.18.1] - 2026-07-19

### Added
- **GPT-5.6 model family (Codex transport).** Added `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna` as first-class models with a conservative 272k Codex input cap (matches
  the `gpt-5.5` Codex cap; the vendor 1.05M descriptor value is not enforced on the
  catalog-less Codex route, so over-reporting there caused mid-turn "input exceeds the
  context window" 500s). A bare `gpt-5.6` alias resolves to `gpt-5.6-sol`
  (`src/integrations/models/gpt.ts`).
- **Codex-alias reasoning effort.** The `gpt-5.6` / `gpt-5.6-sol` aliases default to
  `reasoning_effort: high` and `gpt-5.6-terra` / `gpt-5.6-luna` to `medium`, but these
  defaults are **Codex-transport-only** — on a non-Codex gateway (e.g. OpenRouter) the
  alias effort is suppressed so a third-party route catalog owns the effort metadata.
  Explicit picks still flow everywhere: `/effort` overrides and a `?reasoning=` query
  parameter survive on every transport (`src/services/api/providerConfig.ts`,
  `src/utils/model/model.ts`, `src/utils/model/modelOptions.ts`).
- **Codex model picker entries.** The `/model` Codex section now lists GPT-5.6 Sol /
  Terra / Luna with descriptive labels, and persisted custom Codex models that match a
  GPT-5.6 id are merged back into the picker with their `[1m]` high-context tag preserved
  (`src/utils/model/modelOptions.ts`).

### Fixed
- **Codex model id `[1m]` tag placement.** When a `gpt-5.6` alias carries both an `[1m]`
  high-context window tag and a `?reasoning=` override, the tag now trails the query:
  `gpt-5.6?reasoning=medium[1m]` (previously the tag was emitted before the query,
  producing an invalid model specifier). Applies to alias resolution in
  `src/utils/model/model.ts`.

> Skidded from upstream `Gitlawb/openclaude` PR #2014 (unmerged), including the
> CodeRabbit review fixes for `[1m]` tag ordering and the non-Codex reasoning-suppression
> test expectations.

## [0.18.0] - 2026-07-17

### Added
- **Orphan child-process reaper.** If Neocode crashes (uncaught exception or unhandled
  rejection) or exits for any reason, it now force-kills lingering child processes —
  tracked `execFileNoThrow` subprocesses (e.g. the dead `git` instances that previously
  piled up), running `LocalShellTask` background shells, and LSP servers. The reaper runs
  via the existing cleanup registry on every shutdown path (SIGINT/SIGTERM/SIGHUP/normal
  exit) AND on crash, since the `uncaughtException`/`unhandledRejection` handlers now force
  a graceful shutdown instead of only logging (`src/utils/childReaper.ts`,
  `src/utils/gracefulShutdown.ts`, `src/tasks/LocalShellTask/killShellTasks.ts`,
  `src/utils/execFileNoThrow.ts`).
- **`autoNew` permission mode.** A new amber "auto" mode that auto-allows safe tools while
  still prompting for riskier ones, with a settings-tab row, a guided `PermissionModeMenu`,
  filesystem read-auto-accept guard, and `safeDev` category in the permission classifier
  (`src/utils/permissions/autoNewCategories.ts`, `AutoNewSettingsTab.tsx`,
  `PermissionModeMenu.tsx`, `autoNewPermissions.ts`).
- **Per-route reasoning-effort overrides + custom request extras.** `/effort enable
  <model|prefix> [param]` persists a provider `reasoning_effort` override for any route,
  and `/effort extras` deep-merges arbitrary JSON into the request body (e.g.
  `extra_body.chat_template_kwargs`), scoped per-model / prefix / global
  (`src/utils/effortOverrides.ts`, `src/utils/requestExtras.ts`, `src/commands/effort/effort.tsx`).
- **Settings schema for `runScript` / `runExecutable` + allowlists.** New schema fields,
  config types/defaults, merge logic, and AutoNew settings UI rows
  (`src/utils/settings/types.ts`, `src/utils/settings/settings.ts`,
  `src/tools/BashTool/bashPermissions.ts`).
- **Monitored orphan self-check / crash diagnostics.** `gracefulShutdown` logs shutdown
  state; uncaught-exception and unhandled-rejection handlers emit structured diagnostics.
- **Test runner hardening.** `bun test` scripts now pass `--no-orphans` (bun 1.3.14) to
  kill descendant processes on test exit (`package.json`).

### Changed
- **Bundler/runtime updated to bun 1.3.14.** Upgraded from bun 1.3.13; this is what resolves
  the test-runner `Bun.DMP` OOM crash. Test scripts now also pass the new `--no-orphans`
  flag (bun 1.3.14) (`project-bun-dmp-crash`, `package.json`).
- Softened default-permit behavior for `safeDev` tools (temp writes, recycle-bin ops) and
  broadened read-only command validation (`src/utils/shell/readOnlyCommandValidation.ts`,
  `src/utils/permissions/filesystem.ts`).
- `/effort` picker now offers a guided "Custom…" setup for unsupported models
  (`project-effort-custom-guided-setup`).
- Token-budget handling extended for reasoning-effort overrides
  (`src/query/tokenBudget.ts`, `src/utils/tokenBudget.ts`).

### Fixed
- `bun 1.3.13` test-runner OOM/`Bun.DMP` crash resolved by moving to bun 1.3.14
  (`project-bun-dmp-crash`); full suite: 3422 pass / 102 fail / 7 error on 1.3.14, no new DMP.
- `Provider Tabs` crash fixed by filtering invalid React children in `Tabs` and cleaning
  `BackupTokens` JSX (`provider-tabs-crash`).
- Provider file malformed-load handling; system prompt refinements.

### Notes
- The 102 test failures on the full bun 1.3.14 run are pre-existing
  `MonitorPermissionRequest.test.tsx` `waitFor` timeouts (harness timing, not regressions).
- Running Neocode loads `dist/cli.mjs` once at startup; rebuild + restart to pick up changes
  (`project-neocode-stale-bundle`).

[0.18.0]: (unreleased)
