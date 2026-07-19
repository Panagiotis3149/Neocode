import React from 'react'
import { PRODUCT_DISPLAY_NAME } from '../constants/product.js'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Newline, Text } from '../ink.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import {
  type PermissionMode,
  permissionModeTitle,
} from '../utils/permissions/PermissionMode.js'
import { Select } from './CustomSelect/index.js'
import TextInput from './TextInput.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  mode?: Extract<PermissionMode, 'bypassPermissions' | 'fullAccess'>
  onAccept(): void
  onDecline?(): void
  onCancel?(): void
}

// Stage 1 explains the risk and asks for a first acknowledgment.
// Stage 2 requires a second, explicit confirmation (type DANGER or click
// "Yes, enable") before the mode can actually be enabled. This double-verify
// is the hard gate that prevents accidentally enabling the bypass mode.
type Stage = 'warn' | 'verify'

const CONFIRM_WORD = 'DANGER'

export function BypassPermissionsModeDialog({
  mode = 'bypassPermissions',
  onAccept,
  onDecline,
  onCancel,
}: Props) {
  const [stage, setStage] = React.useState<Stage>('warn')
  const [confirmText, setConfirmText] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)

  React.useEffect(() => {
    logEvent('tengu_bypass_permissions_mode_dialog_shown', {})
  }, [])

  const handleDecline = React.useCallback(() => {
    if (onDecline) {
      onDecline()
      return
    }
    gracefulShutdownSync(1)
  }, [onDecline])

  const handleEscape = React.useCallback(() => {
    if (onCancel) {
      onCancel()
      return
    }
    gracefulShutdownSync(0)
  }, [onCancel])

  const proceedToVerify = React.useCallback(() => {
    logEvent('tengu_bypass_permissions_mode_dialog_verify_shown', {})
    setStage('verify')
    setConfirmText('')
    setCursorOffset(0)
  }, [])

  const accept = React.useCallback(() => {
    // The second verification requires the user to have typed the confirm word.
    // This is the hard double-confirm gate: clicking "Yes, enable" alone is not
    // enough — without CONFIRM_WORD the attempt is silently ignored and the
    // mode is NOT enabled. Only explicit typing of DANGER reaches onAccept().
    if (confirmText.trim().toUpperCase() !== CONFIRM_WORD) {
      return
    }
    logEvent('tengu_bypass_permissions_mode_dialog_accept', {})
    onAccept()
  }, [confirmText, onAccept])

  const modeTitle = permissionModeTitle(mode)

  if (stage === 'warn') {
    return (
      <Dialog
        title={`WARNING: ${PRODUCT_DISPLAY_NAME} running in ${modeTitle} mode`}
        color="error"
        onCancel={handleEscape}
      >
      <Box flexDirection="column" gap={1}>
        <Text>
          In {modeTitle} mode, {PRODUCT_DISPLAY_NAME} will not ask for your approval
          before running potentially dangerous commands.
          <Newline />
          This mode should only be used in a sandboxed container/VM that has
          restricted internet access and can easily be restored if damaged.
        </Text>
        <Text>
          By proceeding, you accept all responsibility for actions taken while
          running in {modeTitle} mode.
        </Text>
      </Box>
        <Select
          options={[
            { label: 'No, exit', value: 'decline' },
            { label: 'Yes, I understand…', color: 'error', value: 'accept' },
          ]}
          onChange={(value: 'accept' | 'decline') => {
            if (value === 'accept') {
              proceedToVerify()
            } else {
              handleDecline()
            }
          }}
        />
      </Dialog>
    )
  }

  // Stage 2: explicit second verification. The mode is ONLY enabled after the
  // user either types the confirm word or clicks "Yes, enable".
  return (
    <Dialog
      title={`CONFIRM: enable ${modeTitle}?`}
      color="error"
      onCancel={handleEscape}
    >
      <Box flexDirection="column" gap={1}>
        <Text color="error">
          This is your final confirmation. Enabling {modeTitle} disables ALL
          safety and permission checks for this session.
        </Text>
        <Text>
          This action cannot be undone except by manually disabling the mode.
        </Text>
        <Box flexDirection="column" gap={0}>
          <Text>
            Type <Text bold color="error">{CONFIRM_WORD}</Text> to confirm, then
            choose "Yes, enable" below:
          </Text>
          <Box borderDimColor borderStyle="round" marginY={1} paddingLeft={1}>
            <TextInput
              showCursor
              value={confirmText}
              onChange={setConfirmText}
              columns={40}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
        </Box>
        <Select
          options={[
            { label: 'No, cancel', value: 'decline' },
            {
              label: 'Yes, enable bypass',
              color: 'error',
              value: 'accept',
            },
          ]}
          onChange={(value: 'accept' | 'decline') => {
            if (value === 'accept') {
              accept()
            } else {
              handleDecline()
            }
          }}
        />
      </Box>
    </Dialog>
  )
}
