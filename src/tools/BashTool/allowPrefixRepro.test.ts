import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { bashToolHasPermission } from './bashPermissions.js'
import { applyPermissionUpdatesToLiveContext } from '../../utils/permissions/permissionSetup.js'

const originalSandboxMethods = {
  isSandboxingEnabled: SandboxManager.isSandboxingEnabled,
  isAutoAllowBashIfSandboxedEnabled:
    SandboxManager.isAutoAllowBashIfSandboxedEnabled,
  areUnsandboxedCommandsAllowed:
    SandboxManager.areUnsandboxedCommandsAllowed,
  getExcludedCommands: SandboxManager.getExcludedCommands,
}

// `MACRO` is a Bun compile-time global substituted only in the esbuild bundle.
// Path-constraint validation (getBundledSkillsRoot) reads MACRO.VERSION, so we
// shim it for the raw `bun test` harness.
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const hadOriginalMacro = Object.hasOwn(globalThis, 'MACRO')
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/BashTool/allowPrefixRepro.test.ts')
})
afterEach(() => {
  try {
    SandboxManager.isSandboxingEnabled =
      originalSandboxMethods.isSandboxingEnabled
    SandboxManager.isAutoAllowBashIfSandboxedEnabled =
      originalSandboxMethods.isAutoAllowBashIfSandboxedEnabled
    SandboxManager.areUnsandboxedCommandsAllowed =
      originalSandboxMethods.areUnsandboxedCommandsAllowed
    SandboxManager.getExcludedCommands =
      originalSandboxMethods.getExcludedCommands
    if (hadOriginalMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function makeContext(toolPermissionContext: unknown) {
  return {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
    getAppState() {
      return { toolPermissionContext }
    },
  } as never
}

describe('Bug#2: read-only allow persists rule for similar commands', () => {
  test('read-only command result carries suggestions so "allow for this" persists a matching rule', async () => {
    const ctx = getEmptyToolPermissionContext()
    const firstCommand = 'ls -la'

    const result = await bashToolHasPermission(
      { command: firstCommand },
      makeContext(ctx),
    )

    // This is the bug: read-only branch returns allow WITHOUT suggestions,
    // so clicking "Yes, allow for this (thing)" (onAllow(input, suggestions))
    // persists nothing and similar commands re-prompt.
    expect(result.suggestions).toBeDefined()
    expect(result.suggestions!.length).toBeGreaterThan(0)

    // Apply the suggestion exactly as the UI would.
    const updatedCtx = applyPermissionUpdatesToLiveContext(
      ctx,
      result.suggestions!,
    )

    const nextResult = await bashToolHasPermission(
      { command: 'ls -la src' },
      makeContext(updatedCtx),
    )
    expect(nextResult.behavior).toBe('allow')
  })
})
