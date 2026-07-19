import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import {
  getModeColor,
  permissionModeTitle,
} from '../../utils/permissions/PermissionMode.js'
import { applyPermissionModeChange } from '../../utils/permissions/permissionSetup.js'
import { requestPermissionModeChange } from '../../utils/permissions/permissionModeChange.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  formatSettingsInstructions,
  getCommandMetadata,
} from './index.js'

type PermissionModeChangeContextLocal = {
  isBypassPermissionsModeAvailable: boolean
}

const AUTONOMOUS_MODE = 'autoNew' as const

function parseEnableArg(
  raw: string | undefined,
): 'enable' | 'disable' | 'toggle' {
  if (!raw) return 'toggle'
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === 'on' ||
    normalized === 'enable' ||
    normalized === 'true' ||
    normalized === '1'
  ) {
    return 'enable'
  }
  if (
    normalized === 'off' ||
    normalized === 'disable' ||
    normalized === 'false' ||
    normalized === '0'
  ) {
    return 'disable'
  }
  return 'toggle'
}

function setModeLocal(
  context: LocalJSXCommandContext,
  targetMode: 'autoNew' | 'default',
): void {
  const currentCtx = context.getAppState().toolPermissionContext
  const nextCtx = applyPermissionModeChange(currentCtx, targetMode)
  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: nextCtx,
    pendingAutoNewAttention:
      targetMode === 'autoNew'
        ? true
        : (prev.pendingAutoNewAttention ?? false),
  }))
}

async function changeMode(
  context: LocalJSXCommandContext,
  targetEnabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const targetMode = (targetEnabled ? 'autoNew' : 'default') as
    | 'autoNew'
    | 'default'
  const localCtx: PermissionModeChangeContextLocal = {
    isBypassPermissionsModeAvailable:
      context.getAppState().toolPermissionContext
        .isBypassPermissionsModeAvailable,
  }
  let applied = false
  const result = await requestPermissionModeChange({
    mode: targetMode,
    toolPermissionContext: localCtx,
    allowDangerousModeConfirmation: true,
    allowSessionBypassPermissionsModeEnable: false,
    onApply: () => {
      applied = true
    },
    onBlocked: () => {},
    onConfirmDangerousMode: (_mode, onConfirm) => {
      onConfirm()
    },
  })
  if (result.status === 'blocked' || !applied) {
    return {
      ok: false,
      error: result.status === 'blocked' ? result.error : 'not applied',
    }
  }
  setModeLocal(context, targetMode)
  return { ok: true }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  userArgs: string,
): Promise<ReactNode> {
  const trimmedArg = userArgs.trim()
  const intent = parseEnableArg(trimmedArg)
  const currentMode = context.getAppState().toolPermissionContext.mode
  const isEnabled = currentMode === AUTONOMOUS_MODE

  if (intent !== 'toggle') {
    const targetEnabled = intent === 'enable'
    if (targetEnabled === isEnabled) {
      onDone(
        targetEnabled
          ? 'Autonomous mode already enabled.'
          : 'Autonomous mode already disabled.',
      )
      return null
    }
    const res = await changeMode(context, targetEnabled)
    if (!res.ok) {
      onDone(
        `Could not ${
          targetEnabled ? 'enable' : 'disable'
        } autonomous mode: ${res.error}`,
      )
      return null
    }
    onDone(
      targetEnabled ? 'Autonomous mode enabled.' : 'Autonomous mode disabled.',
    )
    return null
  }

  // No arg: show a tiny enable/disable toggle for the autonomous mode only.
  return (
    <AutoToggleUI context={context} isEnabled={isEnabled} onDone={onDone} />
  )
}

function AutoToggleUI({
  context,
  isEnabled,
  onDone,
}: {
  context: LocalJSXCommandContext
  isEnabled: boolean
  onDone: LocalJSXCommandOnDone
}) {
  const [enabled, setEnabled] = useState<boolean>(isEnabled)
  const [done, setDone] = useState(false)

  const apply = useCallback(
    async (next: boolean) => {
      const currentMode = context.getAppState().toolPermissionContext.mode
      const already = currentMode === AUTONOMOUS_MODE
      if (next === already) {
        setEnabled(next)
        setDone(true)
        onDone(
          next
            ? 'Autonomous mode already enabled.'
            : 'Autonomous mode already disabled.',
        )
        return
      }
      const res = await changeMode(context, next)
      if (!res.ok) {
        setEnabled(next)
        setDone(true)
        onDone(
          `Could not ${
            next ? 'enable' : 'disable'
          } autonomous mode: ${res.error}`,
        )
        return
      }
      setEnabled(next)
      setDone(true)
      onDone(
        next ? 'Autonomous mode enabled.' : 'Autonomous mode disabled.',
      )
    },
    [context, onDone],
  )

  if (done) {
    return (
      <Text color={getModeColor(enabled ? 'autoNew' : 'default')}>
        Autonomous mode {enabled ? 'ENABLED' : 'DISABLED'}
        {enabled
          ? ` — now running as ${permissionModeTitle('autoNew')}.`
          : '.'}
      </Text>
    )
  }

  const meta = getCommandMetadata()

  return (
    <>
      <Text bold>Autonomous mode (Auto New)</Text>
      <Text color="gray">
        {'  '}
        Currently:{' '}
        <Text color={getModeColor(enabled ? 'autoNew' : 'default')}>
          {enabled ? 'ENABLED' : 'DISABLED'}
        </Text>
      </Text>
      <Text> </Text>
      <Select
        options={[
          {
            label: enabled ? 'Disable autonomous mode' : 'Enable autonomous mode',
            value: enabled ? 'disable' : 'enable',
          },
          {
            label: 'Exit (no change)',
            value: 'exit',
          },
        ]}
        defaultValue={enabled ? 'disable' : 'enable'}
        onChange={value => {
          if (value === 'exit') {
            onDone(undefined, { display: 'skip' })
            return
          }
          void apply(value === 'enable')
        }}
        onCancel={() => {
          onDone(undefined, { display: 'skip' })
        }}
      />
      <Text color="gray">Esc or "Exit (no change)" dismisses this without modifying the mode.</Text>
      <Text color="gray">{formatSettingsInstructions()}</Text>
      <Text color="gray">{meta.examples}</Text>
    </>
  )
}
