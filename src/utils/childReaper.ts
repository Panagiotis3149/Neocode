// Global child-process reaper.
//
// Why: a crash (uncaughtException / unhandledRejection) or sudden exit could
// leave descendant processes alive — background bash tasks, and the many short-
// lived `git` / other children spawned via execFileNoThrow (the user observed
// large numbers of dead git instances lingering). This module is the single
// place that knows how to find and kill them all, and is invoked from the
// graceful-shutdown cleanup registry (which runs on SIGINT/SIGTERM/normal exit
// and — once the exception handlers force a shutdown — on crashes too).
//
// Scope: tracked execFileNoThrow children + running LocalShellTasks + (best
// effort) LSP servers.

import treeKill from 'tree-kill'
import { getLspServerManager, shutdownLspServerManager } from '../services/lsp/manager.js'
import { logError } from './log.js'
import { killAllShellTasks } from '../tasks/LocalShellTask/killShellTasks.js'

// PIDs of still-running children spawned through execFileNoThrow. Keyed by PID;
// value is the spawn command (for diagnostics only). Auto-pruned when a child
// exits so the set stays small.
const trackedChildren = new Map<number, string>()

/** Register a child PID for reaping. Called by execFileNoThrow on spawn. */
export function registerTrackedChild(pid: number, command: string): void {
  if (pid && Number.isFinite(pid)) {
    trackedChildren.set(pid, command)
  }
}

/** Drop a PID once its process has exited (called by execFileNoThrow). */
export function unregisterTrackedChild(pid: number): void {
  trackedChildren.delete(pid)
}

type AppStateLike = { tasks?: Record<string, unknown> }
type GetState = () => AppStateLike
type SetState = (updater: (prev: AppStateLike) => AppStateLike) => void

/**
 * Kill every known descendant process.
 *
 * @param getAppState accessor for app state (used to reach running shell tasks)
 * @param setAppState updater used to mark shell tasks killed
 */
export function reapOrphanedChildren(
  getAppState: GetState,
  setAppState: SetState,
): void {
  // 1. Tracked execFileNoThrow children (git, etc.).
  for (const [pid] of trackedChildren) {
    try {
      treeKill(pid, 'SIGKILL')
    } catch (error) {
      logError(error)
    }
  }
  trackedChildren.clear()

  // 2. Running background shell tasks (bash/shell orphans).
  try {
    killAllShellTasks(getAppState, setAppState)
  } catch (error) {
    logError(error)
  }

  // 3. Best-effort: stop LSP servers. shutdown() is idempotent (clear()s state)
  //    and is already called on normal exit, so re-calling on crash is safe.
  try {
    void shutdownLspServerManager()
  } catch (error) {
    logError(error)
  }
}
