# Subagents V2 Implementation Plan (Supervisor Pattern)

> **For agentic workers:** REQUIRED SUB-SKILL: Implement task-by-task using
> superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Subagents V2 design (spec `docs/superpowers/specs/2026-08-10-subagents-v2-design.md`)
using the **supervisor pattern** (Approach 2, per team design-decisions memory). The supervisor is a
new runtime layer that manages `runAgent()` invocations as `SubagentInstance`s with an in-memory event
bus, permission forwarding, and peer messaging.

**New requirement (added 2026-08-13):** Let the orchestrator (main model) pick the **provider
profile** for a subagent's model too — not just the model id. This mirrors the existing `/model`
command's profile-picker machinery and the `agentModels` provider override, but is sourced from
**named provider profiles** (`providerProfiles.ts`).

**Architecture:** Introduce `SubagentSupervisor` (a `Set<SubagentInstance>` registry + `subscribe`
event bus + permission bridge `Map<requestId, {resolve,reject}>`). `AgentTool` delegates spawns to
`SubagentSupervisor.spawn()` instead of calling `runAgent` directly. Each `SubagentInstance` wraps a
`runAgent()` call with model config (resolved via `resolveAgentRunModelRouting`) plus a new
provider-profile override, a custom permission hook, verbosity, and `sendMessage`/peer addressing.

**Model-provider resolution (the new capability):** Add `provider?: string` to `model_overrides`
(profile `id` or display `name`). At spawn, when `provider` is set, resolve it via
`getProviderProfiles()` and build a `ProviderOverride` (`baseURL` = profile `baseUrl`, `apiKey` =
profile `apiKey`, `model` = primary profile model) and feed it into the subagent's request options.
Takes precedence over the `agentModels`-derived override; unresolvable profile → warn + inherit.

**Tech Stack:** TypeScript, Bun test, Zod settings schema, existing `runAgent` engine,
`resolveAgentRunModelRouting`, `getProviderProfiles`.

---

## File Structure Map

| File | Responsibility |
|------|----------------|
| `src/tools/AgentTool/subagentEventBus.ts` (NEW) | Typed in-memory pub/sub (`SupervisorEvent`) |
| `src/tools/AgentTool/subagentSupervisor.ts` (NEW) | Registry + spawn/terminate/list/sendMessage/setVerbosity + permission bridge |
| `src/tools/AgentTool/runAgent.ts` (MODIFY) | Accept `provider` in model overrides; resolve profile → `ProviderOverride` |
| `src/services/api/agentRouting.ts` (MODIFY) | New `resolveAgentProviderProfile(modelOverrides)` helper |
| `src/utils/providerProfiles.ts` (MODIFY) | Add `findProviderProfileByIdOrName(idOrName)` helper |
| `src/tools/AgentTool/AgentTool.tsx` (MODIFY) | Add `provider` to tool schema + `model_overrides` surface; delegate to supervisor |
| `src/memdir/memoryTypes.ts` (MODIFY) | Provider override field on `ToolContext`/`SubagentHandle` types |
| Tests (NEW/MODIFY) | `subagentEventBus.test.ts`, `subagentSupervisor.test.ts`, `agentRouting.test.ts`, `providerProfiles.test.ts`, `runAgent` routing tests |

---

## Tasks

### Task 1: `findProviderProfileByIdOrName` helper

**Files:** `src/utils/providerProfiles.ts`, `src/utils/providerProfiles.test.ts`

- [ ] Step 1: Failing test — resolve by `id` (exact), by display `name` (exact), and return
      `undefined` when no match. Case-insensitive name match.
- [ ] Step 2: Implement `findProviderProfileByIdOrName(idOrName: string, config? = getGlobalConfig()): ProviderProfile | undefined`.

### Task 2: `resolveAgentProviderProfile` in agentRouting

**Files:** `src/services/api/agentRouting.ts`, `src/services/api/agentRouting.test.ts`

- [ ] Step 1: Failing tests — given a `provider` override, returns `ProviderOverride`
      (`baseURL`/`apiKey`/`model` from the profile primary model); inherits profile model when freed;
      returns `null` for unknown provider (warn path).
- [ ] Step 2: Implement `resolveAgentProviderProfile(opts: { provider?: string }): ProviderOverride | null`
      using `findProviderProfileByIdOrName` + `getPrimaryModel`.

### Task 3: `runAgent` accepts and applies the `provider` override

**Files:** `src/tools/AgentTool/runAgent.ts`

- [ ] Step 1: Thread `provider` through the `model_overrides` shape into request options map.
- [ ] Step 2: In routing resolution, when `provider` is set, let the profile-derived `ProviderOverride`
      win over the `agentModels`-derived one (documented precedence).
- [ ] Step 3: Warn and fall back when the profile can't be resolved.

### Task 4: Event Bus

**Files:** `src/tools/AgentTool/subagentEventBus.ts`, `subagentEventBus.test.ts`

- [ ] Step 1: `SupervisorEvent` union (spawned/status/token_delta/permission_request/permission_response/message/terminated).
- [ ] Step 2: `subscribe`/`publish` with unsubscribe + idempotent filter.

### Task 5: `SubagentSupervisor` core

**Files:** `src/tools/AgentTool/subagentSupervisor.ts`, `subagentSupervisor.test.ts`

- [ ] Step 1: Registry (`Map<agentId, SubagentInstance>`), `spawn(params)`, `terminate`, `list`, `subscribe`.
- [ ] Step 2: Permission bridge (`Map<requestId, {resolve,reject}>`) matching permission events.
- [ ] Step 3: `spawn` wires model_overrides (now incl. `provider`) into the `runAgent` call.
- [ ] Step 4: `sendMessage` + `setVerbosity` + sync/async mode handling.

### Task 6: Wire `AgentTool` to the supervisor

**Files:** `src/tools/AgentTool/AgentTool.tsx`

- [ ] Step 1: Add `provider?: string` to the tool input schema (alias-friendly, "inherits" fallback).
- [ ] Step 2: Delegate spawns to `SubagentSupervisor.spawn()`; retain current default behavior.
- [ ] Step 3: `model_overrides` includes `provider`; surface in generic tool metadata.

### Task 7: Typecheck, build, full-suite gate

- [ ] `bun run build` and `bun test` green; new tests pass; existing subagent tests unbroken.