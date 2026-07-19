import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  bashToolHasPermission,
  checkSandboxAutoAllow,
  stripAllLeadingEnvVars,
  suggestionForExactCommand,
} from './bashPermissions.js'

// Validate the persistent rule shape produced for a command. Returns the rule
// string (e.g. "ls:*") if a single prefix/exact rule is suggested, else null.
function firstRule(command: string): string | null {
  const updates = suggestionForExactCommand(command)
  if (updates.length !== 1) return null
  const rules = updates[0]!.rules
  if (rules.length !== 1) return null
  const rule = rules[0]!
  return typeof rule === 'string' ? rule : rule.ruleContent
}

const originalSandboxMethods = {
  isSandboxingEnabled: SandboxManager.isSandboxingEnabled,
  isAutoAllowBashIfSandboxedEnabled:
    SandboxManager.isAutoAllowBashIfSandboxedEnabled,
  areUnsandboxedCommandsAllowed: SandboxManager.areUnsandboxedCommandsAllowed,
  getExcludedCommands: SandboxManager.getExcludedCommands,
}
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const hadOriginalMacro = Object.hasOwn(globalThis, 'MACRO')

beforeEach(async () => {
  await acquireSharedMutationLock('tools/BashTool/bashPermissions.test.ts')
})

afterEach(() => {
  try {
    SandboxManager.isSandboxingEnabled =
      originalSandboxMethods.isSandboxingEnabled
    SandboxManager.isAutoAllowBashIfSandboxedEnabled =
      originalSandboxMethods.isAutoAllowBashIfSandboxedEnabled
    SandboxManager.areUnsandboxedCommandsAllowed =
      originalSandboxMethods.areUnsandboxedCommandsAllowed
    SandboxManager.getExcludedCommands = originalSandboxMethods.getExcludedCommands
    if (hadOriginalMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function makeToolUseContext() {
  const toolPermissionContext = getEmptyToolPermissionContext()

  return {
    abortController: new AbortController(),
    options: {
      isNonInteractiveSession: false,
    },
    getAppState() {
      return {
        toolPermissionContext,
      }
    },
  } as never
}

test('sandbox auto-allow still enforces Bash path constraints', async () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.isAutoAllowBashIfSandboxedEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true
  SandboxManager.getExcludedCommands = () => []

  const result = await bashToolHasPermission(
    { command: 'cat ../../../../../etc/passwd' },
    makeToolUseContext(),
  )

  expect(result.behavior).toBe('ask')
  expect(result.message).toContain('was blocked')
  expect(result.message).toContain('passwd')
})

// CC-643 regression: the subcommand-fanout cap must apply on the sandbox
// auto-allow path too, not only the main `bashToolHasPermission` body.
// Otherwise a crafted compound command can iterate `matchingRulesForInput`
// N times in the auto-allow path before the main cap ever runs.
//
// The cap is gated on the LEGACY splitter path (astSubcommands === null),
// mirroring the same gate in `bashToolHasPermission` — the fanout/ReDoS risk
// is specific to legacy `splitCommand`. The test forces parse-unavailable via
// CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK so the AST short-circuit cannot
// hide the regression.
test('sandbox auto-allow caps subcommand fanout when AST is unavailable', async () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const originalInjectionFlag =
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
  try {
    SandboxManager.isSandboxingEnabled = () => true
    SandboxManager.isAutoAllowBashIfSandboxedEnabled = () => true
    SandboxManager.areUnsandboxedCommandsAllowed = () => true
    SandboxManager.getExcludedCommands = () => []

    // 60 `echo`s chained with `&&` blow past the 50-subcommand cap.
    const command = Array.from({ length: 60 }, () => 'echo x').join(' && ')

    const result = await bashToolHasPermission(
      { command },
      makeToolUseContext(),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      type: 'other',
      reason: expect.stringContaining('too many to safety-check individually'),
    })
  } finally {
    if (originalInjectionFlag === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    } else {
      process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK =
        originalInjectionFlag
    }
  }
})

// CC-643 follow-up: when tree-sitter has parsed the chain cleanly
// (astSubcommands !== null), the cap must NOT fire — AST-validated long
// chains are intentional, and pre-emptively asking is a user-visible
// regression for legitimate compound commands. Driven directly via
// checkSandboxAutoAllow so the assertion does not depend on tree-sitter WASM
// availability in the test runtime.
test('sandbox auto-allow does not cap when astSubcommands is provided', () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const subs = Array.from({ length: 60 }, () => 'echo x')
  const command = subs.join(' && ')

  const result = checkSandboxAutoAllow(
    { command },
    getEmptyToolPermissionContext(),
    subs,
  )

  expect(result.behavior).toBe('allow')
  expect(result.decisionReason).toMatchObject({
    type: 'other',
    reason: expect.stringContaining('Auto-allowed with sandbox'),
  })
})

// Symmetric direct check: AST unavailable (null) → cap fires.
test('checkSandboxAutoAllow caps fanout when astSubcommands is null', () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const command = Array.from({ length: 60 }, () => 'echo x').join(' && ')

  const result = checkSandboxAutoAllow(
    { command },
    getEmptyToolPermissionContext(),
    null,
  )

  expect(result.behavior).toBe('ask')
  expect(result.decisionReason).toMatchObject({
    type: 'other',
    reason: expect.stringContaining('too many to safety-check individually'),
  })
})

// SEC-02 regression: array subscript with command substitution must NOT be stripped.
// Bash executes FOO[$(cmd)]=val as a side effect; if the pattern matched the
// subscript, the env-var prefix would be stripped while $(cmd) silently ran.
describe('stripAllLeadingEnvVars — SEC-02 subscript expansion guard', () => {
  test('does not strip env var whose subscript contains $()', () => {
    const cmd = 'FOO[$(id)]=val denied_cmd'
    // Pattern must NOT match — command stays intact, deny check sees the full string.
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd.trim())
  })

  test('does not strip env var whose subscript contains ${var}', () => {
    const cmd = 'ARR[${evil}]=x ls'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd.trim())
  })

  test('does not strip env var whose subscript contains a backtick', () => {
    const cmd = 'X[`id`]=1 echo hi'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd.trim())
  })

  test('still strips a safe numeric array subscript', () => {
    // FOO[0]=val cmd → cmd (safe, no expansion in subscript)
    expect(stripAllLeadingEnvVars('FOO[0]=val cmd')).toBe('cmd')
  })

  test('still strips a safe identifier array subscript', () => {
    expect(stripAllLeadingEnvVars('ARR[idx]=x ls')).toBe('ls')
  })
})

describe('suggestionForExactCommand — persistent rule breadth', () => {
  test('flag 2nd token yields a first-word prefix rule (e.g. ls -la → ls:*)', () => {
    const rule = firstRule('ls -la')
    expect(rule).toBe('ls:*')
  })

  test('file 2nd token yields a first-word prefix rule (e.g. cat file.txt → cat:*)', () => {
    const rule = firstRule('cat file.txt')
    expect(rule).toBe('cat:*')
  })

  test('git subcommand yields a 2-word prefix rule (git status → git status:*)', () => {
    const rule = firstRule('git status')
    expect(rule).toBe('git status:*')
  })

  test('npm run X yields a 2-word prefix rule (npm run build → npm run:*)', () => {
    const rule = firstRule('npm run build')
    expect(rule).toBe('npm run:*')
  })

  test('bare-shell base never gets a prefix rule (sh -c ... → exact)', () => {
    const rule = firstRule('sh -c "echo hi"')
    expect(rule).toBe('sh -c "echo hi"')
  })

  test('sudo wrapper never gets a prefix rule (sudo ls → exact)', () => {
    const rule = firstRule('sudo ls')
    expect(rule).toBe('sudo ls')
  })
})
