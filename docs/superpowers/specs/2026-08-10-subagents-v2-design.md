# Subagents V2 — Design Spec

**Date:** 2026-08-10
**Status:** Approved (pending user review)
**Scope:** Subagent feature update for Neocode (fork of Claude Code)

---

## Goal

Upgrade subagents from "fire-and-forget black boxes" to first-class participants in the conversation:
real-time visibility, independent model configuration, transparent permissions, peer messaging, and
shared context via inter-agent dialogue.

## Non-Goals

- Automatic file-cache sharing between subagents (out of scope; deferred)
- Cross-session subagent persistence (out of scope)
- Multi-user / collaborative sessions (out of scope)

## User Stories

1. **Real-time streaming**: When the main model spawns a subagent, the user sees the subagent's
   tool calls and (optionally) text output stream into the main conversation with a `[Subagent: name]`
   badge. Verbosity is configurable per-spawn.
2. **Model selection**: Main model can override model, temperature, and reasoning effort per subagent.
   Defaults inherit from the main model's config. Benchmarks (parameter count, context window,
   pricing) are queryable from Hugging Face / Artificial Analysis to inform model choice.
3. **Permission forwarding**: When a subagent requests permission for a tool, the user sees the
   request inline in the main conversation with the subagent name, and approves/denies as if the
   main model had asked. The subagent blocks until a response is received.
4. **Main → Subagent communication**: Main model can send messages to any active subagent (for
   course corrections, follow-up questions, or to terminate).
5. **Subagent → Main communication**: A subagent can post messages back to the main model. These
   appear in the unified thread with the subagent's name as sender.
6. **Subagent ↔ Subagent communication**: A subagent can send messages to peer subagents by name
   (e.g., "summarize the auth flow you just read"). Messages are routed through the supervisor's
   event bus.
7. **Shared context via dialogue**: There is no automatic file-cache sharing. Subagents discover
   shared context by asking peers to describe what they've read (a SendMessageTool exchange).

## Architectural Approach

**Supervisor pattern.** A new `SubagentSupervisor` class owns the lifecycle, streaming,
permissions, and messaging for all subagents. Subagents themselves remain `runAgent()` calls; the
supervisor wraps them.

Rationale: this isolates the new complexity from the main `query()` loop, makes the streaming /
permissions / messaging surface easy to evolve, and avoids touching the main agent's query
pipeline beyond a single subscription point.

## Components

### 1. `SubagentSupervisor` (`src/tools/AgentTool/SubagentSupervisor.ts`)

Singleton per session. Owns:

- **Registry**: `Map<agentId, SubagentInstance>` with metadata (`name`, `modelConfig`,
  `verbosity`, `status`, `spawnedAt`, `mode`)
- **Event bus**: emits typed events to subscribers (see §3)
- **Lifecycle hooks**: spawn, terminate, list
- **Permission bridge**: matches `PermissionRequestEvent{requestId}` to `PermissionResponseEvent`
  via an internal `Map<requestId, {resolve, reject}>`; subagents block on `await` until response

Public API (consumed by `AgentTool`):

```ts
class SubagentSupervisor {
  spawn(params: SpawnParams): Promise<SubagentHandle>
  sendMessage(fromAgentId: string, to: AgentAddress, content: string): Promise<void>
  setVerbosity(agentId: string, verbosity: Verbosity): void
  terminate(agentId: string, reason?: string): Promise<void>
  list(): SubagentSummary[]
  subscribe(listener: (event: SupervisorEvent) => void): Unsubscribe
}
```

### 2. `SubagentInstance` (per-supervisor)

Wraps a `runAgent()` invocation with supervisor-aware configuration:

- **Model config**: fully resolved at spawn via
  `resolveAgentRunModelRouting({ agentDefinition: { model, temperature, reasoning_effort }, ... })`.
  Inheritance: if any field is omitted, it inherits from the main model's resolved config.
- **Verbosity**: `"outputs_and_calls" | "calls_only" | "none"` — controls which event types the
  supervisor forwards to subscribers.
- **Permission hook**: a custom callback injected into the subagent's app state that, instead of
  auto-denying, publishes a `PermissionRequestEvent` and awaits the matched
  `PermissionResponseEvent`.
- **Messaging**: the subagent has access to a `sendMessage` tool whose target address space
  includes `"main"` and `"subagent:<name>"` in addition to existing `SendMessageTool` targets.

### 3. Event Bus (`src/tools/AgentTool/subagentEventBus.ts`)

In-memory pub/sub. Typed events:

```ts
type SupervisorEvent =
  | { type: "subagent_spawned"; agentId; agentName; modelConfig; verbosity; mode }
  | { type: "subagent_status"; agentId; agentName; status: "running" | "paused" | "done" | "failed" }
  | { type: "subagent_token_delta"; agentId; agentName; delta }                  // verbosity >= outputs_and_calls
  | { type: "subagent_assistant_message"; agentId; agentName; content }           // verbosity >= outputs_and_calls
  | { type: "subagent_tool_call"; agentId; agentName; tool; params }             // verbosity != none
  | { type: "subagent_tool_result"; agentId; agentName; tool; result; isError }  // verbosity != none
  | { type: "subagent_permission_request"; agentId; agentName; tool; params; requestId }
  | { type: "subagent_permission_response"; agentId; agentName; requestId; decision; reason? }
  | { type: "subagent_message"; fromAgentId; fromAgentName; toAgentId; toAgentName; content }
  | { type: "subagent_terminated"; agentId; agentName; reason? }
```

Subscribers:

- **Main REPL renderer** (`src/screens/REPL.tsx`): subscribes via a new hook
  `useSubagentEventStream()`. Renders all events into the unified conversation thread with
  `[Subagent: name]` badges and sender labels.
- **Permission UI**: subscribes to `subagent_permission_request` events; shows the existing
  permission dialog with a subagent-name prefix; resolves via `supervisor.resolvePermission(
  requestId, decision )`.

### 4. Main Model API (`src/tools/AgentTool/AgentTool.tsx`)

The existing `AgentTool` input schema is extended:

```ts
{
  // existing fields...
  subagent_name?: string                  // required, used as display name + addressing
  model_overrides?: {                     // all optional; inherit from main model if omitted
    model?: string
    temperature?: number
    reasoning_effort?: "low" | "medium" | "high"
  }
  verbosity?: "outputs_and_calls" | "calls_only" | "none"  // default: "calls_only"
  mode?: "async" | "sync"                 // default: "async" (current behavior)
  lookup_benchmarks?: boolean             // if true, supervisor fetches HF/AA data for the model
}
```

Internally, `AgentTool.tsx` delegates to `SubagentSupervisor.spawn()` instead of calling `runAgent`
directly. `runAgent` is still the underlying execution engine.

### 5. Benchmark Lookup (`src/utils/model/benchmarkRegistry.ts`)

Optional feature. New module with two backends:

- **Hugging Face API**: `GET https://huggingface.co/api/models/{modelId}` → returns parameter
  count, tags, downloads.
- **Artificial Analysis API**: `GET https://artificialanalysis.ai/api/v2/models/{slug}` →
  returns benchmark scores, pricing, context window. (Requires an `ARTIFICIAL_ANALYSIS_API_KEY`
  env var; if absent, this backend is skipped.)

Caching: in-memory `Map<modelId, Benchmarks>` keyed by model id, no TTL (static data). Lookup is
opt-in via the `lookup_benchmarks` flag on `spawn`.

The supervisor exposes a `lookupModelBenchmarks(modelId)` method callable by the main model via
the existing `AgentTool` result, or via a new `ModelLookupTool`.

### 6. Shared Context (Peer-to-Peer Only)

There is no automatic file-cache sharing. Subagents discover shared context by sending messages
to peers. Example:

> **Subagent A** (read `src/auth/session.ts`):
> → `sendMessage("subagent:researcher", "Summarize the session-validation flow you read in src/auth/session.ts")`
>
> **Subagent B** (researcher, read same file earlier):
> → `sendMessage("subagent:explorer", "Session validation: 1) check JWT signature, 2) verify exp, 3) load user from DB...")`

The existing `SendMessageTool` is extended to allow `"subagent:<name>"` as a valid target when
called from inside a subagent's context. The supervisor resolves the name to an `agentId`.

## Data Flow

### Spawn

```
AgentTool (main) → SubagentSupervisor.spawn({...})
  → resolve model config (inherit + override)
  → resolve benchmarks (if requested)
  → emit subagent_spawned
  → runAgent({...subagentInstanceConfig})
  → attach permission hook + sendMessage wrapper
  → attach stream_event / message forwarder (filtered by verbosity)
  → return SubagentHandle
```

### Permission Request

```
subagent runAgent → tool needs permission
  → permission hook (injected by supervisor) → publishes subagent_permission_request{requestId}
  → main REPL renders permission dialog with subagent name prefix
  → user clicks Allow/Deny → main UI publishes subagent_permission_response{requestId, decision}
  → supervisor.resolvePermission(requestId, decision) → unblocks subagent
```

### Peer Message

```
Subagent A calls sendMessage("subagent:B", "...")
  → supervisor routes by name → resolves agentId for B
  → publishes subagent_message{fromAgentId: A, fromAgentName, toAgentId: B, ...}
  → main REPL renders as a thread message (sender = A)
  → Subagent B receives the message via its injected sendMessage wrapper → injected as a
    user-role turn into B's query() loop
```

### Verbosity Filtering

The supervisor's stream forwarder inspects each `stream_event` / `message` from the subagent's
`query()` loop:

| Event                  | outputs_and_calls | calls_only | none |
|------------------------|:-----------------:|:----------:|:----:|
| `token_delta`          | ✓                 |            |      |
| `assistant_message`    | ✓                 |            |      |
| `tool_call`            | ✓                 | ✓          |      |
| `tool_result`          | ✓                 | ✓          |      |
| `permission_request`   | ✓                 | ✓          | ✓    |
| `subagent_message`     | ✓                 | ✓          | ✓    |
| `subagent_status`      | ✓                 | ✓          | ✓    |

Permissions and messages always flow (required for correctness); text streams can be muted.

## Error Handling

- **Subagent crash**: emit `subagent_status{status: "failed"}`, surface error in main thread,
  keep subagent in registry for inspection. Do not auto-restart.
- **Permission timeout**: if the user doesn't respond within 60s, default to deny and notify the
  subagent with a `permission_timeout` error.
- **Model override invalid**: at spawn time, validate the model id against the provider catalog;
  fall back to inherited model with a warning event.
- **Peer message target not found**: emit `subagent_message{status: "failed", reason: "not_found"}`
  back to sender.
- **Supervisor bus overflow**: cap each subagent's emitted events at 10k/sec; drop excess with a
  warning event (prevents runaway streaming from blocking main thread).

## Testing

- **Unit tests**:
  - `SubagentSupervisor.test.ts`: spawn/terminate lifecycle, permission bridge, verbosity filter
  - `subagentEventBus.test.ts`: typed event emission, subscriber isolation
  - `benchmarkRegistry.test.ts`: HF + AA lookup with mocked fetch
- **Integration tests**:
  - Spawn a real subagent, verify `subagent_spawned` + first `tool_call` events arrive at a
    test subscriber
  - Inject a permission request, verify the bridge round-trip resolves the subagent
  - Peer message routing: subagent A → subagent B → B's `query()` loop receives the message
- **Manual tests** (documented in plan):
  - Spawn subagent with `verbosity: "outputs_and_calls"`, verify text streams with badge
  - Spawn with `model_overrides`, verify the subagent uses the override
  - Trigger a Bash permission request, verify main UI prompts with subagent name
  - Spawn two subagents, have one message the other, verify round-trip

## Migration / Compatibility

- Existing `AgentTool` callers continue to work: new fields are all optional with sensible defaults
  (`mode: "async"`, `verbosity: "calls_only"`, no model overrides)
- `runAgent()` is unchanged — all new behavior lives in `SubagentSupervisor` and the wiring in
  `AgentTool.tsx`
- `SendMessageTool` gets a backward-compatible extension (new `"subagent:<name>"` target)

## Files Affected (Approximate)

- **New**:
  - `src/tools/AgentTool/SubagentSupervisor.ts`
  - `src/tools/AgentTool/subagentEventBus.ts`
  - `src/tools/AgentTool/subagentInstance.ts`
  - `src/utils/model/benchmarkRegistry.ts`
  - `src/hooks/useSubagentEventStream.ts`
  - Tests for above
- **Modified**:
  - `src/tools/AgentTool/AgentTool.tsx` — extended schema, delegate to supervisor
  - `src/tools/SendMessageTool/SendMessageTool.ts` — add `"subagent:<name>"` target
  - `src/screens/REPL.tsx` — subscribe to subagent events, render with badges
  - `src/utils/permissions/permissions.ts` — remove `shouldAvoidPermissionPrompts` for subagents
    when supervisor is active

## Open Questions

None at design time. Implementation details will be resolved during the plan phase.
