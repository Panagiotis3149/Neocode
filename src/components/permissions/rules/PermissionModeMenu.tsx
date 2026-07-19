import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import {
  getPermissionModeOptions,
  type ManageablePermissionMode,
} from './permissionModeOptions.js'

// Sentinel value used for the trailing "Exit without saving" option.
export const MODE_MENU_EXIT = '__exit__' as const
export type ModeMenuValue = ManageablePermissionMode | typeof MODE_MENU_EXIT

type Props = {
  context: ToolPermissionContext
  onSelect: (mode: ManageablePermissionMode) => void
  onExit: () => void
  onCancel: () => void
}

/**
 * Small overlay listing every manageable permission mode plus a trailing
 * "Exit without saving" sentinel. Opened from the footer mode badge (Enter)
 * or the chat:cycleMode keybinding, replacing the old one-step cycle behavior.
 * Esc / Ctrl-C invoke onCancel (no mode change).
 */
export function PermissionModeMenu({ context, onSelect, onExit, onCancel }: Props) {
  const baseOptions = getPermissionModeOptions(context)
  const options = [
    ...baseOptions,
    {
      value: MODE_MENU_EXIT,
      label: 'Exit without saving',
      description: 'Close this menu without changing the mode',
      color: 'gray',
    },
  ]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold={true}>Permission mode</Text>
      <Select<ModeMenuValue>
        options={options}
        defaultFocusValue={context.mode}
        visibleOptionCount={Math.min(9, options.length)}
        layout="compact-vertical"
        onChange={value => {
          if (value === MODE_MENU_EXIT) {
            onExit()
          } else {
            onSelect(value)
          }
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}
