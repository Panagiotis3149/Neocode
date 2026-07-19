import { useEffect, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../../components/CustomSelect/select.js'
import TextInput from '../../TextInput.js'
import {
  getAutoNewModeConfig,
  setAutoNewModeConfig,
  type AutoNewModeCategoryPolicy,
  type AutoNewModeConfig,
} from '../../../utils/settings/settings.js'

export const AUTO_NEW_CATEGORY_LABELS: Record<string, string> = {
  recycleBin: 'Recycle bin',
  shiftDelete: 'Shift-delete',
  tempRead: 'temp/ read',
  tempWrite: 'temp/ write',
  onlineRead: 'Online read',
  onlineWrite: 'Online write',
  systemRead: 'System read',
  systemWrite: 'System write',
  safeDev: 'Safe dev tooling',
  runScript: 'Run script',
  runExecutable: 'Run executable',
  other: 'Other',
}

export const CATEGORY_KEYS = [
  'recycleBin',
  'shiftDelete',
  'tempRead',
  'tempWrite',
  'onlineRead',
  'onlineWrite',
  'systemRead',
  'systemWrite',
  'safeDev',
  'runScript',
  'runExecutable',
  'other',
] as const

const AUTO_NEW_POLICY_ORDER: readonly AutoNewModeCategoryPolicy[] = [
  'allow',
  'think',
  'ask',
  'thinkToThink',
]

// Per-sub-option descriptions shown in the Auto (New) settings editor. Each
// explains what the policy does, including the behavior numbers referenced in
// the permission-mode menu (1 = proceed silently, 2 = reflect/route per
// thinkMode, 3 = always prompt).
const POLICY_DESCRIPTIONS: Record<AutoNewModeCategoryPolicy, string> = {
  allow:
    'Behavior 1 — Allow: proceed with the action silently, no prompt.',
  think:
    'Behavior 2 — Think: reflect first, then route per think mode. thinkMode 1 = reflect "is this really needed?" then ask; thinkMode 2 = reflect "is this safe enough?" then allow silently.',
  ask:
    'Behavior 3 — Ask: always prompt the user for approval before acting.',
  thinkToThink:
    'Behavior 4 — Think to think: take a quick breath and decide whether this is worth a normal Think at all — if it is minor, just proceed; only if it gives you pause, fall back to a normal Think. A light triage, not a double-effort Think.',
}

function nextPolicy(current: AutoNewModeCategoryPolicy): AutoNewModeCategoryPolicy {
  const idx = AUTO_NEW_POLICY_ORDER.indexOf(current)
  return AUTO_NEW_POLICY_ORDER[(idx + 1) % AUTO_NEW_POLICY_ORDER.length]!
}

function nextThinkDepth(current: number): number {
  return current >= 5 ? 1 : current + 1
}

export type EditorOptionValue =
  | { kind: 'category'; key: (typeof CATEGORY_KEYS)[number] }
  | { kind: 'thinkMode' }
  | { kind: 'thinkDepth' }

export function AutoNewModeEditor({
  initialConfig,
}: {
  initialConfig: AutoNewModeConfig
}) {
  const [config, setConfig] = useState<AutoNewModeConfig>(initialConfig)

  const update = (
    value: EditorOptionValue,
    partial: Partial<AutoNewModeConfig>,
  ) => {
    setConfig(prev => ({ ...prev, ...partial }))
    setAutoNewModeConfig(partial)
    void value
  }

  const options: {
    label: string
    value: EditorOptionValue
    description: string
  }[] = [
    ...CATEGORY_KEYS.map(key => ({
      label: AUTO_NEW_CATEGORY_LABELS[key] ?? key,
      value: { kind: 'category', key } as EditorOptionValue,
      description: `${config[key]}: ${POLICY_DESCRIPTIONS[config[key]]} (select to change)`,
    })),
    {
      label: 'Think mode',
      value: { kind: 'thinkMode' } as EditorOptionValue,
      description: `${config.thinkMode} (select to toggle 1/2)`,
    },
    {
      label: 'Think depth',
      value: { kind: 'thinkDepth' } as EditorOptionValue,
      description: `${config.thinkDepth} (select to cycle 1–5)`,
    },
  ]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold={true}>Auto (New) mode — edit policy (select to change):</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Select
          options={options.map(opt => ({
            label: opt.label,
            value: opt.value,
            description: opt.description,
          }))}
          onChange={(value: EditorOptionValue) => {
            if (value.kind === 'category') {
              const next = nextPolicy(config[value.key])
              update(value, { [value.key]: next })
            } else if (value.kind === 'thinkMode') {
              const next: '1' | '2' = config.thinkMode === '1' ? '2' : '1'
              update(value, { thinkMode: next })
            } else {
              const next = nextThinkDepth(config.thinkDepth)
              update(value, { thinkDepth: next as AutoNewModeConfig['thinkDepth'] })
            }
          }}
          layout="compact-vertical"
        />
      </Box>
    </Box>
  )
}

/**
 * Lightweight single-line editor for the scriptCommands / executables
 * allowlists. The user types a comma/whitespace-separated list; submitting
 * (Enter) splits it into an array and commits it to settings (blank = empty
 * list). Uses the focus-aware TextInput so it never steals keystrokes from
 * the rest of the TUI unless focused.
 */
function AllowlistEditor({
  label,
  listKey,
}: {
  label: string
  listKey: 'scriptCommands' | 'executables'
}) {
  const current = getAutoNewModeConfig()[listKey]
  const [buffer, setBuffer] = useState(current.join(', '))
  const [editing, setEditing] = useState(false)

  const commit = () => {
    const next = buffer
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    setAutoNewModeConfig({ [listKey]: next } as Partial<AutoNewModeConfig>)
    setEditing(false)
  }

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={1}>
      <Text bold={true}>
        {label}
        {editing ? ' (editing — Enter to save, Esc to cancel):' : ' (Enter to edit):'}
      </Text>
      {editing ? (
        <TextInput
          focus={true}
          value={buffer}
          placeholder="comma,separated,entries"
          onChange={setBuffer}
          onSubmit={commit}
        />
      ) : (
        <Text color={undefined} onClick={() => setEditing(true)}>
          {current.length ? current.join(', ') : '(empty)'}
        </Text>
      )}
    </Box>
  )
}

/**
 * Dedicated Permissions tab for the Auto (New) mode policy. Renders the
 * interactive policy editor so the per-category settings live on their own
 * tab rather than inline below the Mode picker.
 */
export function AutoNewSettingsTab() {
  const config = getAutoNewModeConfig()
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1} gap={1}>
        <Text>
          Configure the Auto (New) mode policy. Each category decides how
          risky actions are handled; "think" routes to the thinking layer,
          "ask" prompts, "allow" proceeds, and "thinkToThink" briefly decides
          whether to proceed or do a normal Think (light triage).
        </Text>
      </Box>
      <AutoNewModeEditor initialConfig={config} />
      <Box marginTop={1}>
        <Text bold={true}>Allowlists (override classifier):</Text>
      </Box>
      <AllowlistEditor label="Script commands" listKey="scriptCommands" />
      <AllowlistEditor label="Executables" listKey="executables" />
    </Box>
  )
}
