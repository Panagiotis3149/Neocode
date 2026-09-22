# JetBrains Plugin — Milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the milestone-driven plugin — milestone 1 = MCP transport + registry; milestone 2 = Add-to-Context vertical (plugin action + Neocode listener); milestone 3 = DiffTools (verbatim snippets); milestone 4 = remaining components.

**Architecture:** Hand-rolled WS server (kotlinx-io + NIO RFC 6455), flat `MCPService.dispatch()` dispatcher (Option A), milestone phasing per design spec §5. Lockfile uses `transport: "ws"` (matches `client.ts` line 366).

**Tech Stack:** Kotlin 2.4.0, IntelliJ Platform 2.2.1 (IDE 2024.2), kotlinx-coroutines-core 1.9.0, kotlinx-serialization-json 1.7.3, JDK 21 toolchain.

---

## File Structure Map

| File (plugin repo `jetbrains-extension/`) | Status | Milestone |
|---|---|---|
| `build.gradle` / `gradle.properties` | Exists (stub) | 1 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/services/MCPService.kt` | Modify (fill body) | 1 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/services/ServerPortUtil.kt` | Modify (fill body) | 1 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/tools/ToolModels.kt` | Exists (stub) | 1 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/tools/DiffTools.kt` | Modify (fill body) | 3 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/actions/SendToClaudeAction.kt` | Modify (fill body) | 2 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/actions/OpenClaudeInTerminalAction.kt` | Modify (fill body) | 4 |
| `src/main/kotlin/wtf/pana/neocode/jetbrains/services/MCPService.kt` (`sendAddToContext`) | Fill body | 2 |

Neocode-side listener (`src/services/mcp/client.ts`): milestone 2.

---

### Milestone 1: Transport + Registry (Phase 1, ~6h)

- [ ] **Task M1.1:** Fill `ServerPortUtil.findFreePort()` (bind-then-release)
- [ ] **Task M1.2:** Fill `ServerPortUtil.writeLockfile()` and `deleteLockfile()` — `transport: "ws"` (not `"ws-ide"`), include `authToken`
- [ ] **Task M1.3:** Implement minimal WS frame I/O in `MCPService` (kotlinx-io NIO, RFC 6455 handshake + encode/decode). No JSON-RPC routing yet — just open/close socket.
- [ ] **Task M1.4:** Add JSON-RPC dispatcher `MCPService.dispatch()` with `initialize`, `initialized`. Store registry as `ConcurrentHashMap<String, ToolDef>` (stub value).
- [ ] **Task M1.5:** Wire `ToolManager.registerAll()` — calls `register()` for DiffTools, EditorTools, FileTools (stubs; tools don't dispatch yet, just register).
- [ ] **Task M1.6:** Verify `start()` writes lockfile; `PostStartupActivity` starts `MCPService` then `ToolManager`.
- [ ] **Task M1.7:** Manual smoke: `./gradlew buildPlugin` → `runIde` → check `~/.claude/ide/*.lock` appears with port and `transport: "ws"`.

### Milestone 2: Add-to-Context (Phase 2, ~4h)

- [ ] **Task M2.1:** Fill `SendToClaudeAction.actionPerformed()` — read selection, file path, language; call `MCPService.getInstance().sendAddToContext()`.
- [ ] **Task M2.2:** Fill `MCPService.sendAddToContext()` — send `notifications/` JSON-RPC message `mcp__ide__addToContext` over open WS session.
- [ ] **Task M2.3:** Add Neocode-side listener: `src/services/mcp/client.ts` — near `maybeNotifyIDEConnected`, add `setNotificationHandler` for `mcp__ide__addToContext` (schema + handler that pushes into conversation).
- [ ] **Task M2.4:** Verify: right-click → "Send to Neocode Context" → notification delivered to CLI.

### Milestone 3: DiffTools (Phase 3, ~6h)

- [ ] **Task M3.1:** Read `DiffTools` snippets from `known.txt` fully (already read, but verify lines 53-145 cover `openDiff` flow: args model, `addTool`, `invokeAndWait`, `DiffContentFactory`, `SimpleDiffRequest`).
- [ ] **Task M3.2:** Implement `DiffTools.register()` — mirror snippet's `addTools()` call, register `openDiff`, `close_tab`, `closeAllDiffTabs`. Use snippet's args class (`OpenDiffToolArgs`) and dispatch logic (`getLastFocusedOpenedProject()`, `openVirtualFileFromPath()`, `invokeAndWait`, `DiffContentFactory.create()` → `SimpleDiffRequest` → `FutureUtil.waitFor` for save/reject).
- [ ] **Task M3.3:** Implement `CloseTabToolArgs` / `OpenFileToolArgs` / `GetDiagnosticsToolArgs` (models exist in `ToolModels.kt`); register `close_tab`, `closeAllDiffTabs`, `openFile`.
- [ ] **Task M3.4:** Manual smoke in `runIde`: trigger `openDiff` from CLI, verify diff opens.

### Milestone 4: Polish (Phase 4, ~6h)

- [ ] **Task M4.1:** Implement `getDiagnostics` and `executeCode` tool handlers (stub to return `CallToolResult`).
- [ ] **Task M4.2:** Fill `NotificationManager.notifyInfo` / `notifyError`.
- [ ] **Task M4.3:** Fill `TerminalUtils.resolveNeocodeBinaryPath()`.
- [ ] **Task M4.4:** Fill `OpenInTerminal` action.
- [ ] **Task M4.5:** Build verification: `pluginVerifier()` passes; `zipSigner()` present (per `build.gradle`).
- [ ] **Task M4.6:** Final manual end-to-end: plug `runIde` + CLI `mcp` connection + `openDiff` + `addToContext` all working in one session.

---

## Self-Review

- **Spec coverage:** Milestones 1-4 map to spec §5 phasing. M1 = transport; M2 = Add-to-Context; M3 = DiffTools (verbatim); M4 = remaining.
- **Placeholder scan:** No TBD/TODO in plan steps; each milestone ends with manual verification.
- **Type consistency:** `transport: "ws"` (not `"ws-ide"`) aligns with `client.ts` line 366. `ConcurrentHashMap` registry matches snippet `addTool()` shape.
- **Boundary check:** Milestone 2 includes Neocode listener (`client.ts`) as spec requires.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-27-jetbrains-add-to-context-plan.md`. Two execution options:

**1. Subagent-Driven** — fresh subagent per milestone (recommended)
**2. Inline Execution** — batch milestone by milestone

Which approach? Once chosen, invoke `superpowers:executing-plans`.
