import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { createRoot } from '../../../ink.js'
import {
  getEmptyToolPermissionContext,
} from '../../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import {
  MODE_MENU_EXIT,
  PermissionModeMenu,
  type ModeMenuValue,
} from './PermissionModeMenu.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => output }
}

async function waitForOutput(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const startedAt = Date.now()
  let frame = ''

  while (Date.now() - startedAt < 2500) {
    frame = stripAnsi(extractLastFrame(getOutput()))
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }

  throw new Error(`Timed out waiting for mode menu output:\n${frame}`)
}

// Capture the Select props so we can drive selection without simulating raw
// ink keypresses (which are flaky in unit tests).
let lastOptions: Array<{ value: unknown; label: string }> = []
let lastOnChange: ((value: ModeMenuValue) => void) | null = null
let lastOnCancel: (() => void) | null = null
let lastDefaultFocusValue: unknown = undefined

mock.module('../../CustomSelect/select.js', () => ({
  Select: <T extends string>(props: {
    options: Array<{ value: T; label: string }>
    onChange: (value: T) => void
    onCancel: () => void
    defaultFocusValue: T
  }) => {
    lastOptions = props.options as Array<{ value: unknown; label: string }>
    lastOnChange = props.onChange as (value: ModeMenuValue) => void
    lastOnCancel = props.onCancel
    lastDefaultFocusValue = props.defaultFocusValue
    return React.createElement(
      'select',
      { 'data-testid': 'mode-menu' },
      props.options.map(o =>
        React.createElement(
          'option',
          { key: String(o.value), value: String(o.value) },
          o.label,
        ),
      ),
    )
  },
}))

const context = {
  ...getEmptyToolPermissionContext(),
  mode: 'default',
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'src/components/permissions/rules/PermissionModeMenu.test.tsx',
  )
})

afterEach(() => {
  lastOptions = []
  lastOnChange = null
  lastOnCancel = null
  lastDefaultFocusValue = undefined
  releaseSharedMutationLock()
})

describe('PermissionModeMenu', () => {
  test('renders every manageable mode plus an Exit without saving sentinel', async () => {
    const { stdout, stdin, getOutput } = createTestStreams()
    const root = await createRoot({ stdout, stdin, exitOnCtrlC: false })

    let frame = ''
    await root.render(
      React.createElement(PermissionModeMenu, {
        context,
        onSelect: () => {},
        onExit: () => {},
        onCancel: () => {},
      }),
    )

    // Wait for the mocked Select to have rendered and captured its props.
    frame = await waitForOutput(getOutput, () => lastOptions.length > 0)

    const values = lastOptions.map(o => o.value)
    // Manageable modes are present (smoke check on a few well-known ones).
    expect(values).toContain('default')
    expect(values).toContain('plan')
    expect(values).toContain('autoNew')
    expect(values).toContain('acceptEdits')
    // Trailing sentinel option.
    expect(values).toContain(MODE_MENU_EXIT)
    expect(
      lastOptions.find(o => o.value === MODE_MENU_EXIT)?.label,
    ).toBe('Exit without saving')
    // Focus starts on the current mode.
    expect(lastDefaultFocusValue).toBe('default')
    expect(typeof lastOnChange).toBe('function')
    expect(typeof lastOnCancel).toBe('function')
  })

  test('selecting a mode calls onSelect and not onExit/onCancel', async () => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout, stdin, exitOnCtrlC: false })

    let selected: string | null = null
    let exited = false
    let cancelled = false

    await root.render(
      React.createElement(PermissionModeMenu, {
        context,
        onSelect: mode => {
          selected = mode
        },
        onExit: () => {
          exited = true
        },
        onCancel: () => {
          cancelled = true
        },
      }),
    )

    await waitForOutputWithProps()

    lastOnChange?.('plan')
    expect(selected).toBe('plan')
    expect(exited).toBe(false)
    expect(cancelled).toBe(false)
  })

  test('selecting the exit sentinel calls onExit only', async () => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout, stdin, exitOnCtrlC: false })

    let selected: string | null = null
    let exited = false
    let cancelled = false

    await root.render(
      React.createElement(PermissionModeMenu, {
        context,
        onSelect: mode => {
          selected = mode
        },
        onExit: () => {
          exited = true
        },
        onCancel: () => {
          cancelled = true
        },
      }),
    )

    await waitForOutputWithProps()

    lastOnChange?.(MODE_MENU_EXIT)
    expect(exited).toBe(true)
    expect(selected).toBe(null)
    expect(cancelled).toBe(false)
  })

  test('cancel invokes onCancel only', async () => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout, stdin, exitOnCtrlC: false })

    let selected: string | null = null
    let exited = false
    let cancelled = false

    await root.render(
      React.createElement(PermissionModeMenu, {
        context,
        onSelect: mode => {
          selected = mode
        },
        onExit: () => {
          exited = true
        },
        onCancel: () => {
          cancelled = true
        },
      }),
    )

    await waitForOutputWithProps()

    lastOnCancel?.()
    expect(cancelled).toBe(true)
    expect(selected).toBe(null)
    expect(exited).toBe(false)
  })
})

async function waitForOutputWithProps(): Promise<void> {
  const { stdout, stdin, getOutput } = createTestStreams()
  void stdout
  void stdin
  // Re-poll the captured module-level props (set by the mock) until populated.
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2500) {
    if (lastOptions.length > 0) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for Select props to be captured')
}
