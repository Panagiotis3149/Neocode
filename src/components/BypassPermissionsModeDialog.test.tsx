import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { render, type Instance } from '../ink.js'

// Capture the latest onChange callbacks the dialog wires into its controls so
// the test can drive the two-stage flow deterministically without simulating
// raw keypresses (which is flaky in ink tests).
type SelectOnChange = (value: unknown) => void
type TextInputOnChange = (value: string) => void

let lastSelectOnChange: SelectOnChange | null = null
let lastTextInputOnChange: TextInputOnChange | null = null
let selectRenderCount = 0
let textInputRenderCount = 0

function installControlMocks() {
  mock.module('./CustomSelect/index.js', () => ({
    Select: (props: {
      options: Array<{ value: unknown }>
      onChange: SelectOnChange
    }) => {
      lastSelectOnChange = props.onChange
      selectRenderCount += 1
      return React.createElement(
        'select',
        { 'data-testid': 'select' },
        props.options.map((o: { value: unknown }) =>
          React.createElement('option', { key: String(o.value), value: String(o.value) }),
        ),
      )
    },
  }))

  mock.module('./TextInput.js', () => ({
    default: (props: { value: string; onChange: TextInputOnChange }) => {
      lastTextInputOnChange = props.onChange
      textInputRenderCount += 1
      return React.createElement('textinput', {
        'data-testid': 'textinput',
        value: props.value,
      })
    },
  }))
}

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  // Swallow writes that race in after the test ends the stream (terminal
  // querier runs an async loop that may emit one more write post-teardown).
  const baseWrite = stdout.write.bind(stdout)
  let ended = false
  stdout.on('finish', () => {
    ended = true
  })
  stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (ended) return true
    return baseWrite(chunk as never, ...(rest as never[]))
  }) as typeof stdout.write
  return { stdout, stdin }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for dialog state')
}

afterEach(() => {
  mock.restore()
  lastSelectOnChange = null
  lastTextInputOnChange = null
  selectRenderCount = 0
  textInputRenderCount = 0
})

describe('BypassPermissionsModeDialog two-stage confirmation', () => {
  test('does NOT call onAccept until both the warn and verify stages are confirmed', async () => {
    installControlMocks()

    const { BypassPermissionsModeDialog } = await import(
      `./BypassPermissionsModeDialog.js?twostage=${Date.now()}-${Math.random()}`
    )

    const { stdout, stdin } = createStreams()
    let accepted = 0
    let instance: Instance | null = null

    try {
      instance = await render(
        React.createElement(BypassPermissionsModeDialog, {
          mode: 'bypassPermissions',
          onAccept: () => {
            accepted += 1
          },
          onDecline: () => {},
          onCancel: () => {},
        }),
        {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
          exitOnCtrlC: false,
        },
      )

      // Stage 1 visible — warn dialog. onAccept must not have fired yet.
      await waitFor(() => lastSelectOnChange !== null)
      expect(accepted).toBe(0)

      // Simulate choosing "Yes, I understand…" in the warn stage.
      lastSelectOnChange?.('accept')

      // Stage 2 visible — verify dialog. Still not accepted.
      await waitFor(() => lastTextInputOnChange !== null)
      expect(accepted).toBe(0)

      // Nothing should enable without the second confirmation. Pick "Yes,
      // enable" in the verify stage WITHOUT typing DANGER — must be rejected.
      lastSelectOnChange?.('accept')
      await Bun.sleep(20)
      expect(accepted).toBe(0)

      // Now satisfy the verify stage: type the confirm word.
      lastTextInputOnChange?.('DANGER')

      // The verify-stage Select re-renders with a fresh onChange closure that
      // closes over the typed DANGER. Wait for that re-render before clicking
      // so we invoke the gated handler (not the stale, pre-type closure).
      const selectBefore = selectRenderCount
      await waitFor(() => selectRenderCount > selectBefore)
      lastSelectOnChange?.('accept')

      await waitFor(() => accepted === 1)
      expect(accepted).toBe(1)
    } finally {
      instance?.unmount()
      stdout.end()
    }
  })

  test('declining in the warn stage never reaches the verify stage', async () => {
    installControlMocks()

    const { BypassPermissionsModeDialog } = await import(
      `./BypassPermissionsModeDialog.js?decline=${Date.now()}-${Math.random()}`
    )

    const { stdout, stdin } = createStreams()
    let accepted = 0
    let declined = 0
    let instance: Instance | null = null

    try {
      instance = await render(
        React.createElement(BypassPermissionsModeDialog, {
          mode: 'fullAccess',
          onAccept: () => {
            accepted += 1
          },
          onDecline: () => {
            declined += 1
          },
          onCancel: () => {},
        }),
        {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
          exitOnCtrlC: false,
        },
      )

      await waitFor(() => lastSelectOnChange !== null)
      lastSelectOnChange?.('decline')

      await waitFor(() => declined === 1)
      expect(declined).toBe(1)
      expect(accepted).toBe(0)
      // TextInput (verify stage) is never rendered on decline.
      expect(lastTextInputOnChange).toBeNull()
    } finally {
      instance?.unmount()
      stdout.end()
    }
  })
})
