# Neocode JetBrains Plugin

Connects an active [Neocode](https://github.com/Panagiotis3149/neocode) (Claude Code fork) CLI session to a JetBrains IDE over MCP. Provides in-IDE diff review, file navigation, diagnostics capture, and a right-click "Add to Context" action.

> **Status:** scaffold only — no implementation yet. See [`~/.neocode/plans/eager-beaming-dove.md`](../../.neocode/plans/eager-beaming-dove.md) for the spike plan and architecture.

## Project layout

```
jetbrains-extension/
├── build.gradle                                 # IntelliJ Platform Gradle Plugin 2.x
├── settings.gradle
├── gradle.properties
└── src/main/
    ├── kotlin/wtf/pana/neocode/jetbrains/
    │   ├── actions/
    │   │   ├── OpenClaudeInTerminalAction.kt    # Tools menu → open `neocode` in IDE terminal
    │   │   └── SendToClaudeAction.kt            # Right-click "Add to Neocode Context"
    │   ├── notifications/
    │   │   ├── NotificationManager.kt           # IDE balloon orchestration
    │   │   └── NotificationModels.kt            # Notification data types
    │   ├── services/
    │   │   ├── MCPService.kt                    # MCP WebSocket/SSE server lifecycle
    │   │   └── ServerPortUtil.kt                # ~/.claude/ide/{port}.lock lockfile mgmt
    │   ├── startup/
    │   │   └── PostStartupActivity.kt           # Bootstrap: start server, write lockfile, register tools
    │   ├── tools/
    │   │   ├── DiffTools.kt                     # openDiff, close_tab, closeAllDiffTabs RPC handlers
    │   │   ├── EditorTools.kt                   # openFile RPC handler
    │   │   ├── FileTools.kt                     # File system ops (TBD)
    │   │   ├── ToolManager.kt                   # MCP tool registration + dispatch
    │   │   └── ToolModels.kt                    # JSON-RPC arg models
    │   └── util/
    │       ├── StringBundle.kt                  # i18n via /messages/NeocodeBundle.properties
    │       ├── TerminalUtils.kt                 # Locate `neocode` binary; terminal helpers
    │       └── Utils.kt                         # Path conversion, JSON-RPC id correlation, etc.
    └── resources/
        ├── META-INF/plugin.xml                  # Plugin descriptor (services, actions, startup)
        └── messages/NeocodeBundle.properties     # i18n strings
```

## Building

Requires JDK 21 and an internet connection (IntelliJ Platform SDK + Kotlin plugin are downloaded by Gradle).

```bash
# From jetbrains-extension/
./gradlew buildPlugin          # Assembles the plugin ZIP into build/distributions/
./gradlew runIde               # Spawns a sandbox IDE with the plugin loaded
./gradlew verifyPlugin          # Binary compatibility check against target IDEs
```

Open in IntelliJ IDEA: **File → Open → jetbrains-extension/**. Gradle will sync, and the `runIde` run configuration will appear under Gradle tasks.

## Architecture

The plugin is the MCP **server**; the Neocode CLI is the MCP **client**. The CLI scans `~/.claude/ide/{port}.lock` to discover connected IDEs (existing logic in `src/utils/jetbrains.ts` of the Neocode repo), then connects via WebSocket (`ws-ide`) or SSE (`sse-ide`).

### RPC surface (Neocode → IDE)

| Method                | Args                                                                                         | Purpose                          |
|-----------------------|----------------------------------------------------------------------------------------------|----------------------------------|
| `openDiff`            | `{old_file_path, new_file_path, new_file_contents, tab_name}`                                | Open a diff tab for review       |
| `close_tab`           | `{tab_name}`                                                                                 | Close a specific diff tab        |
| `closeAllDiffTabs`    | —                                                                                            | Close all Neocode diff tabs      |
| `openFile`            | `{filePath, preview, startText, endText, selectToEndOfLine, makeFrontmost}`                  | Open a file in the editor        |
| `getDiagnostics`      | `{uri}` (file) or `{}` (all)                                                                 | Return IDE inspection results    |
| `set_permission_mode` | `{mode}`                                                                                     | (probably unused in plugin UI)   |
| `mcp__ide__executeCode`| (TBD)                                                                                       | Run a code block in the IDE      |
| `mcp__ide__getDiagnostics`| (TBD)                                                                                    | Same as getDiagnostics via MCP   |

### Notifications (IDE → Neocode)

| Notification                 | Payload                          | Purpose                                              |
|------------------------------|----------------------------------|------------------------------------------------------|
| `mcp__ide__addToContext`     | `{text, filePath, language}`     | Right-click "Add to Context" → model conversation    |
| `ide_connected`              | `{pid}`                          | Sent on connect (consumed by Neocode's detection)    |

### Connection lifecycle

1. IDE starts → plugin's `PostStartupActivity` runs
2. `MCPService` binds a WebSocket server to a free port
3. `ServerPortUtil` writes `~/.claude/ide/{port}.lock` with workspace folders + pid
4. Neocode CLI scans lockfile dir, connects as MCP client
5. Plugin's `ToolManager` registers RPC handlers; tool calls flow Neocode → IDE
6. Right-click "Add to Context" sends a notification (server → client) over the same socket
7. On IDE shutdown, lockfile is deleted

## Compatibility

- **Target IDE:** IntelliJ IDEA Community 2024.2+ (compatible with all JetBrains IDEs that include `com.intellij.modules.platform`)
- **JDK:** 21
- **Kotlin:** 2.4.0 (bundled into target IDE as a plugin dependency for diff highlighting)
