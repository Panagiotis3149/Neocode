# Subagents V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn opted-in subagents into session-scoped, observable participants with lifecycle control, filtered events, permission forwarding, peer messaging, model/provider overrides, and cached benchmark lookup.

**Architecture:** A session supervisor owns a registry of live subagents and an in-memory event bus. `runAgent()` remains the execution engine but exposes raw query messages through an optional callback and receives a supervisor runtime context for message delivery. The existing AgentTool path remains unchanged unless a caller supplies the V2 fields, so current callers keep their legacy behavior.

**Tech Stack:** TypeScript, Bun tests, Zod v4, React/Ink REPL, existing `runAgent()` and provider-profile routing.

**Spec:** `docs/superpowers/specs/2026-08-10-subagents-v2-design.md`

## Global Constraints

- Automatic file-cache sharing, cross-session persistence, and multi-user collaboration remain out of scope.
- Existing AgentTool callers remain compatible; new fields are optional and default to `mode: "async"`, `verbosity: "calls_only"`, and inherited model routing when the V2 path is selected.
- Provider overrides resolve a provider-profile id or name to its configured `baseUrl`, `apiKey`, and `model`; an unknown profile falls back to inherited routing with a warning.
- Permissions and subagent messages always remain observable even when text output is muted.
- Permission requests default to deny after 60 seconds.
- Event delivery must isolate subscriber failures and cap per-agent emission at 10,000 events per second.
- Do not add code comments unless they are required to explain a non-obvious invariant.

---

### Task 1: Supervisor execution contracts and lifecycle

**Files:**
- Create: `src/tools/AgentTool/subagentInstance.ts`
- Modify: `src/tools/AgentTool/subagentSupervisor.ts`
- Modify: `src/tools/AgentTool/subagentEventBus.ts`
- Modify: `src/tools/AgentTool/runAgent.ts`
- Test: `src/tools/AgentTool/subagentSupervisor.test.ts`
- Test: `src/tools/AgentTool/subagentEventBus.test.ts`

**Interfaces:**
- `SubagentSupervisor.spawn()` accepts `runAgentParams`, a display name, model/provider overrides, verbosity, mode, and optional benchmark lookup.
- `runAgent()` accepts an optional `onQueryMessage(message)` callback and optional supervisor runtime context.
- `SubagentHandle` exposes `agentId`, `agentName`, `done`, and `result`.
- `SubagentSupervisor.sendMessage()` resolves a name or id, queues a user turn for the target, and emits a `subagent_message` event.

- [x] **Step 1: Add RED tests for injected execution, termination, event forwarding, verbosity filtering, and peer inbox delivery.**
- [x] **Step 2: Run the focused supervisor tests and confirm failures identify missing behavior rather than fixture errors.**
- [x] **Step 3: Extract instance state and message-queue types into `subagentInstance.ts`.**
- [x] **Step 4: Thread the supervisor abort controller and raw-message callback into `runAgent()`.**
- [x] **Step 5: Implement supervisor execution, status transitions, permission timeout, event filtering, queue delivery, and rate limiting.**
- [x] **Step 6: Run the event-bus and supervisor tests and keep the result green while refactoring.**

### Task 2: Model benchmark registry

**Files:**
- Create: `src/utils/model/benchmarkRegistry.ts`
- Create: `src/utils/model/benchmarkRegistry.test.ts`
- Modify: `src/tools/AgentTool/subagentSupervisor.ts`

**Interfaces:**
- `lookupModelBenchmarks(modelId, options?)` returns a normalized `Benchmarks` object or `null`.
- The registry uses an injected `fetch`, caches by model id, requests Hugging Face for metadata, and requests Artificial Analysis only when `ARTIFICIAL_ANALYSIS_API_KEY` is present.

- [x] **Step 1: Write RED tests for Hugging Face normalization, optional Artificial Analysis lookup, cache reuse, and backend failure tolerance.**
- [x] **Step 2: Run the benchmark tests and verify the expected failures.**
- [x] **Step 3: Implement normalized response parsing and cache ownership.**
- [x] **Step 4: Expose `lookupModelBenchmarks()` from the supervisor and run the focused tests.**

### Task 3: AgentTool V2 delegation and model configuration

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Modify: `src/tools/AgentTool/runAgent.ts`
- Modify: `src/query.ts`
- Modify: `src/Tool.ts`
- Modify: `src/tools/AgentTool/AgentTool.schema.test.ts`
- Create: `src/tools/AgentTool/AgentTool.subagents-v2.test.ts`

**Interfaces:**
- Add `subagent_name`, `model_overrides`, `verbosity`, `lookup_benchmarks`, and V2-compatible `mode` input handling without removing legacy team permission-mode values.
- V2 spawns pass inherited model configuration plus explicit `model`, `provider`, `temperature`, and `reasoning_effort` values to the supervisor.
- Temperature and effort are carried through the child tool context into the existing API options.

- [x] **Step 1: Add RED schema and delegation tests for defaults, explicit overrides, provider profile selection, and async/sync return shapes.**
- [x] **Step 2: Run the tests and confirm the new fields are rejected or ignored by the current implementation.**
- [x] **Step 3: Extend the schema and route opted-in calls through the session supervisor while leaving team and legacy calls on their existing path.**
- [x] **Step 4: Thread temperature and effort into child query options.**
- [x] **Step 5: Run AgentTool routing/schema tests plus the V2 tests.**

### Task 4: Main and peer messaging

**Files:**
- Modify: `src/Tool.ts`
- Modify: `src/utils/forkedAgent.ts`
- Modify: `src/tools/AgentTool/runAgent.ts`
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts`
- Create: `src/tools/SendMessageTool/SendMessageTool.subagents-v2.test.ts`

**Interfaces:**
- A child `ToolUseContext` carries `{ supervisor, agentId, agentName }` only when created by the V2 supervisor.
- `SendMessageTool` accepts `main` and `subagent:<name>` for V2 contexts and retains existing teammate, UDS, bridge, and mailbox routing.

- [x] **Step 1: Write RED routing tests for main delivery, peer name resolution, unknown targets, and legacy routing preservation.**
- [x] **Step 2: Run the routing tests and confirm the V2 target is currently unsupported.**
- [x] **Step 3: Add the runtime context override and route V2 messages through the supervisor inbox.**
- [x] **Step 4: Run the focused messaging tests and the existing SendMessageTool tests.**

### Task 5: REPL event subscription and permission presentation

**Files:**
- Create: `src/hooks/useSubagentEventStream.ts`
- Modify: `src/screens/REPL.tsx`
- Modify: `src/components/permissions/PermissionRequest.tsx`
- Create: `src/hooks/useSubagentEventStream.test.ts`

**Interfaces:**
- `useSubagentEventStream(supervisor)` subscribes once, cleans up on unmount, and exposes ordered events for the current session.
- The REPL renders `[Subagent: name]` labels for visible subagent events and maps permission requests to the existing permission queue with a worker badge.

- [ ] **Step 1: Write RED hook tests for subscription, cleanup, event ordering, and bounded event state.**
- [ ] **Step 2: Run the hook tests and verify the missing hook behavior.**
- [x] **Step 3: Implement the hook and connect the session supervisor to the REPL tool context.**
- [x] **Step 4: Render text/tool/message events without adding subagent text to the main model context.**
- [x] **Step 5: Route permission decisions back through `resolvePermission()` and run focused UI tests/type checks.**

### Task 6: End-to-end verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-31-subagents-v2.md`

- [x] **Step 1: Re-read the spec and mark each implemented requirement or explicit remaining gap.**
- [x] **Step 2: Run the focused V2 tests.**
- [x] **Step 3: Run the repository typecheck and build commands that do not require network access.**
- [x] **Step 4: Inspect the final diff and confirm unrelated dirty files were not changed.**
- [x] **Step 5: Record verification evidence and any unverified runtime/manual checks.**

## Verification record

- The serial focused suite passed: 57 tests across 10 files, 0 failures, 154 assertions.
- `bun run build` passed, including CLI and SDK bundle checks, external dependency checks, and SDK declaration checks.
- `bun run typecheck` exits with 1,779 repository baseline diagnostics. No V2-only file produced an actionable diagnostic in the targeted review.
- `git diff --check` reported no whitespace errors; only existing line-ending normalization warnings.
- The interactive REPL permission surface and a real network-backed provider run were not manually exercised. The hook has no standalone unit test because the repository has no existing hook-renderer test harness.
