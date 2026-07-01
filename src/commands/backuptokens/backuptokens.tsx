import * as React from 'react'
import { useCallback, useState } from 'react'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resetAllKeysToDefault, scheduleNextResetAt, parseBackupTokenResetSpec, isValidBackupTokenResetSpec, setActiveBackupToken, getActiveApiKey } from '../../services/api/backupTokenManager.js'
import { sanitizeApiKey } from '../../utils/providerSecrets.js'
import type { LocalJSXCommandOnDone, LocalJSXCommandCall } from '../../types/command.js'
import { Box, Text, useInput } from '../../ink.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Tabs, Tab, useTabHeaderFocus } from '../../components/design-system/Tabs.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useRegisterKeybindingContext } from '../../keybindings/KeybindingContext.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import {
getProviderPresetUiMetadata,
ORDERED_PROVIDER_PRESETS,
} from '../../integrations/providerUiMetadata.js'
import type { ProviderPreset } from '../../integrations/generated/integrationArtifacts.generated.js'

interface BackupTokenSettings {
threshold: number
resetTiming: '1m' | '1h' | '1d' | 'custom' | 'never'
customResetTime?: string
logging: boolean
}

function getSettings(): BackupTokenSettings {
const c = getGlobalConfig()
const bt = c.backupTokenConfig ?? { threshold: 3, resetTiming: 'never', logging: false }
return {
threshold: bt.threshold ?? 3,
resetTiming: (bt.resetTiming as BackupTokenSettings['resetTiming']) ?? 'never',
customResetTime: bt.customResetTime ?? '',
logging: bt.logging ?? false,
}
}

function saveSettings(s: BackupTokenSettings) {
if (s.resetTiming === 'custom' && !isValidBackupTokenResetSpec(s.customResetTime ?? '')) {
return
}
saveGlobalConfig((c) => ({ ...c, backupTokenConfig: s }))
}

export const call: LocalJSXCommandCall = async (onDone) => {
return <BackupTokensRoot onDone={onDone} />
}

function BackupTokensRoot({ onDone }: { onDone: LocalJSXCommandOnDone }) {
const [selectedTab, setSelectedTab] = useState('Settings')
const [tabsHidden, setTabsHidden] = useState(false)
const insideModal = false
const { rows } = useTerminalSize()
const contentHeight = insideModal ? rows + 1 : Math.max(12, Math.min(Math.floor(rows * 0.7), 25))

const isActive = !tabsHidden
useKeybinding(
'confirm:no',
() => {
if (tabsHidden) return
onDone()
},
{ context: 'Settings', isActive }
)

useInput((input, key) => {
if (tabsHidden) return
if (key.tab || input === '\t') {
setSelectedTab((prev) => (prev === 'Settings' ? 'Providers' : 'Settings'))
}
})

return ( <Pane color="permission">
<Tabs
  color="permission"
  selectedTab={selectedTab}
  onTabChange={setSelectedTab}
  hidden={tabsHidden}
  initialHeaderFocused={true}
  contentHeight={tabsHidden ? undefined : contentHeight}
>
  <Tab key="settings" title="Settings">
    <SettingsTab onTabsHiddenChange={setTabsHidden} />
  </Tab>
  <Tab key="providers" title="Providers">
    <ProvidersTab onTabsHiddenChange={setTabsHidden} />
  </Tab>
</Tabs>
</Pane>
)
}

type FieldDef = {
label: string
key: string
type: 'number' | 'select' | 'toggle'
min?: number
max?: number
options?: { label: string; value: string }[]
}

const FIELDS: FieldDef[] = [
{
label: 'Rotation threshold',
key: 'threshold',
type: 'number',
min: 1,
max: 20,
},
{
label: 'Reset timing',
key: 'resetTiming',
type: 'select',
options: [
{ label: '1 minute', value: '1m' },
{ label: '1 hour', value: '1h' },
{ label: '1 day', value: '1d' },
{ label: 'Custom', value: 'custom' },
{ label: 'Never', value: 'never' },
],
},
{
label: 'Error logging',
key: 'logging',
type: 'toggle',
},
]

function SettingsTab({ onTabsHiddenChange }: { onTabsHiddenChange: (hidden: boolean) => void }) {
const [settings, setSettings] = useState<BackupTokenSettings>(getSettings)
const [idx, setIdx] = useState(0)
const [saved, setSaved] = useState(false)
const [customTimeInput, setCustomTimeInput] = useState(settings.customResetTime ?? '')
const [customTimeCursorOffset, setCustomTimeCursorOffset] = useState(0)
const { columns: inputColumns } = useTerminalSize()
const { headerFocused } = useTabHeaderFocus()
const [customEditorOpen, setCustomEditorOpen] = useState(false)

const isCustomRowFocused = FIELDS[idx]?.key === 'resetTiming' && settings.resetTiming === 'custom'
const isCustomEditorVisible = isCustomRowFocused && customEditorOpen

useRegisterKeybindingContext('Confirmation', !headerFocused && !isCustomEditorVisible)
useRegisterKeybindingContext('Editor', isCustomEditorVisible)

React.useEffect(() => {
onTabsHiddenChange(isCustomEditorVisible)
}, [isCustomEditorVisible, onTabsHiddenChange])

const updateField = useCallback((key: string, delta: number) => {
setSaved(false)
setSettings((prev) => {
const f = FIELDS.find((x) => x.key === key)
if (!f) return prev


  if (f.type === 'number') {
    const cur = prev[key as keyof BackupTokenSettings] as number
    const next = Math.max(f.min ?? 1, Math.min(f.max ?? 20, cur + delta))
    return { ...prev, [key]: next }
  }

  if (f.type === 'select') {
    const opts = f.options ?? []
    const curVal = prev[key as keyof BackupTokenSettings] as string
    const curIdx = opts.findIndex((o) => o.value === curVal)
    const baseIdx = curIdx < 0 ? 0 : curIdx
    const nextIdx = (baseIdx + delta + opts.length) % opts.length
    return { ...prev, [key]: opts[nextIdx].value }
  }

  if (f.type === 'toggle') {
    return { ...prev, [key]: !prev[key as keyof BackupTokenSettings] }
  }

  return prev
})


}, [])

useKeybinding(
'confirm:toggle',
() => {
if (headerFocused || isCustomRowFocused || isCustomEditorVisible) return
const f = FIELDS[idx]
if (f) updateField(f.key, 1)
},
{ context: 'Confirmation', isActive: !headerFocused && !isCustomRowFocused && !isCustomEditorVisible }
)

useKeybinding(
'confirm:next',
() => {
if (headerFocused || isCustomEditorVisible) return
setIdx((i) => Math.min(i + 1, FIELDS.length - 1))
},
{ context: 'Confirmation', isActive: !headerFocused && !isCustomEditorVisible }
)

useKeybinding(
'confirm:previous',
() => {
if (headerFocused || isCustomEditorVisible) return
setIdx((i) => Math.max(i - 1, 0))
},
{ context: 'Confirmation', isActive: !headerFocused && !isCustomEditorVisible }
)

useKeybinding(
'confirm:yes',
() => {
if (headerFocused) return
const finalSettings: BackupTokenSettings = isCustomEditorVisible
? { ...settings, customResetTime: customTimeInput.trim() }
: settings
saveSettings(finalSettings)
setSaved(true)
},
{ context: 'Confirmation', isActive: !headerFocused }
)

useKeybinding(
'editor:save',
() => {
if (isValidBackupTokenResetSpec(customTimeInput)) {
setSettings((prev) => ({ ...prev, customResetTime: customTimeInput.trim() }))
setCustomEditorOpen(false)
onTabsHiddenChange(false)
}
},
{ context: 'Editor', isActive: isCustomEditorVisible }
)

useKeybinding(
'editor:exit',
() => {
setCustomTimeInput(settings.customResetTime ?? '')
setCustomEditorOpen(false)
onTabsHiddenChange(false)
},
{ context: 'Editor', isActive: isCustomEditorVisible }
)

useInput((input, key) => {
if (headerFocused || isCustomEditorVisible) return


if (isCustomRowFocused && input === ' ') {
  setCustomTimeInput(settings.customResetTime ?? '')
  setCustomEditorOpen(true)
  return
}

if (key.upArrow || key.home) {
  setIdx((i) => Math.max(i - 1, 0))
  return
}

if (key.downArrow || key.end) {
  setIdx((i) => Math.min(i + 1, FIELDS.length - 1))
  return
}

if (key.leftArrow) {
  const f = FIELDS[idx]
  if (f) updateField(f.key, -1)
  return
}

if (key.rightArrow) {
  const f = FIELDS[idx]
  if (f) updateField(f.key, 1)
  return
}


})

const formatValue = (f: FieldDef, s: BackupTokenSettings): string => {
const val = s[f.key as keyof BackupTokenSettings]


if (f.key === 'resetTiming' && val === 'custom') {
  const custom = s.customResetTime?.trim()
  if (!custom) return 'Custom'
  return `Custom (${custom})`
}

if (f.type === 'number') return `${val} error${val !== 1 ? 's' : ''}`
if (f.type === 'toggle') return val ? 'Enabled' : 'Disabled'
if (f.type === 'select') return (f.options ?? []).find((o) => o.value === val)?.label ?? String(val)
return String(val)


}

if (isCustomEditorVisible) {
const preview = parseBackupTokenResetSpec(customTimeInput)


return (
  <Box flexDirection="column">
    <Box marginBottom={1}>
      <Text bold color="permission">
        Custom reset
      </Text>
    </Box>
    <Box>
      <Text dimColor>Spec: </Text>
      <TextInput
        value={customTimeInput}
        onChange={setCustomTimeInput}
        onSubmit={() => {
          if (isValidBackupTokenResetSpec(customTimeInput)) {
            setSettings((prev) => ({ ...prev, customResetTime: customTimeInput.trim() }))
            setCustomEditorOpen(false)
            onTabsHiddenChange(false)
          }
        }}
        columns={Math.max(20, inputColumns - 14)}
        cursorOffset={customTimeCursorOffset}
        onChangeCursorOffset={setCustomTimeCursorOffset}
        placeholder="1h 30m, next 2AM UTC, next 2AM Europe/Athens"
        focus
        showCursor
        disableEscapeDoublePress={true}
        onExit={() => {
          setCustomTimeInput(settings.customResetTime ?? '')
          setCustomEditorOpen(false)
          onTabsHiddenChange(false)
        }}
      />
    </Box>
    <Box marginTop={1}>
      {!customTimeInput.trim() ? (
        <Text dimColor>Supports durations like 1h 30m and schedules like next 2AM UTC or 7th next 12PM Europe/Athens</Text>
      ) : preview ? (
        <Text color="green">✓ {preview.label}</Text>
      ) : (
        <Text color="red">Invalid value. Try 1h 30m, next 2AM UTC, or 7th next 12PM Europe/Athens</Text>
      )}
    </Box>
    <Box marginTop={1}>
      <Text dimColor>Enter save · Esc back</Text>
    </Box>
  </Box>
)


}

return ( <Box flexDirection="column">
{FIELDS.map((f, i) => {
const isFocused = i === idx && !headerFocused
return ( <Box key={f.key} flexDirection="row" marginBottom={1}> <Box width={22}>
<Text color={isFocused ? 'cyan' : undefined} bold={isFocused}>
{isFocused ? '▶ ' : '  '}
{f.label} </Text> </Box> <Box width={22}>
<Text color={isFocused ? 'yellow' : 'gray'}>
{f.type === 'select' ? '◀ ' : ''}
{formatValue(f, settings)}
{f.type === 'select' ? ' ▶' : ''} </Text> </Box> </Box>
)
})}
{saved && ( <Box marginTop={1}> <Text color="green">✓ Settings saved</Text> </Box>
)} <Box marginTop={1}> <Text dimColor>
↑/↓ or Home/End move · ←/→ change value · Space opens custom editor · Enter saves · Tab switches tab · Esc closes </Text> </Box> </Box>
)
}

function splitPastedKeys(raw: string): string[] {
return raw
.split(/[\s,:;|]+/g)
.map((part) => part.trim())
.filter(Boolean)
}

type ProviderListRow =
| {
type: 'key'
provider: string
keyIndex: number
rawKey: string
masked: string
active: boolean
}
| {
type: 'add'
}

function ProvidersTab({ onTabsHiddenChange }: { onTabsHiddenChange: (hidden: boolean) => void }) {
const [providers, setProviders] = useState<Record<string, string[]>>(() => {
const c = getGlobalConfig()
return c.backupTokenProviders ?? {}
})
const [adding, setAdding] = useState(false)
const [selectingProvider, setSelectingProvider] = useState(false)
const [selectedProvider, setSelectedProvider] = useState<ProviderPreset>('anthropic')
const [newKey, setNewKey] = useState('')
const [cursorOffset, setCursorOffset] = useState(0)
const [selectedRow, setSelectedRow] = useState(0)
const [notice, setNotice] = useState<string>('')
const { columns: inputColumns } = useTerminalSize()
const { headerFocused } = useTabHeaderFocus()

const saveProviders = useCallback((next: Record<string, string[]>) => {
saveGlobalConfig((c) => ({ ...c, backupTokenProviders: next }))
}, [])

const cancelProviderFlow = useCallback(() => {
setSelectingProvider(false)
setAdding(false)
setNewKey('')
setCursorOffset(0)
onTabsHiddenChange(false)
}, [onTabsHiddenChange])

const handleAdd = useCallback(() => {
const chunks = splitPastedKeys(newKey)
if (!chunks.length) return


const cleaned = Array.from(
  new Set(
    chunks
      .map((part) => sanitizeApiKey(part))
      .filter((part): part is string => Boolean(part))
  )
)

if (!cleaned.length) return

setProviders((prev) => {
  const next = {
    ...prev,
    [selectedProvider]: [...(prev[selectedProvider] ?? []), ...cleaned],
  }
  saveProviders(next)
  return next
})

setNewKey('')
setCursorOffset(0)
setAdding(false)
onTabsHiddenChange(false)
setNotice(`Added ${cleaned.length} key${cleaned.length === 1 ? '' : 's'}`)


}, [newKey, selectedProvider, saveProviders, onTabsHiddenChange])

const handleDelete = useCallback(
(provider: string, keyIndex: number) => {
setProviders((prev) => {
const keys = prev[provider]
if (!keys) return prev
const nextKeys = keys.filter((_, i) => i !== keyIndex)
const next =
nextKeys.length > 0
? { ...prev, [provider]: nextKeys }
: (() => {
const { [provider]: _, ...rest } = prev
return rest
})()
saveProviders(next)
return next
})
setNotice('Deleted token')
},
[saveProviders]
)

React.useEffect(() => {
let cancelled = false
const tick = () => {
if (cancelled) return
const config = getGlobalConfig()
const schedule = config.backupTokenResetSchedule ?? {}
const customResetTime = config.backupTokenConfig?.customResetTime ?? ''
for (const [provider, keys] of Object.entries(providers)) {
if (keys.length <= 1) continue
const next = schedule[provider] ?? 0
if (next === 0 || Date.now() >= next) {
resetAllKeysToDefault(provider)
if (customResetTime) {
scheduleNextResetAt(provider, customResetTime)
}
}
}
}
tick()
const interval = setInterval(tick, 5 * 60 * 1000)
return () => {
cancelled = true
clearInterval(interval)
}
}, [providers])

const rows: ProviderListRow[] = React.useMemo(() => {
const out: ProviderListRow[] = []
for (const [provider, keys] of Object.entries(providers)) {
const active = getActiveApiKey(provider)
for (let i = 0; i < keys.length; i++) {
const rawKey = keys[i]
out.push({
type: 'key',
provider,
keyIndex: i,
rawKey,
masked: `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`,
active: rawKey === active,
})
}
}
out.push({ type: 'add' })
return out
}, [providers])

React.useEffect(() => {
setSelectedRow((prev) => Math.max(0, Math.min(prev, rows.length - 1)))
}, [rows.length])

useInput((input, key) => {
if (headerFocused) return


if (key.escape) {
  if (adding || selectingProvider) {
    cancelProviderFlow()
    return
  }
  return
}

if (adding || selectingProvider) return

if (key.upArrow || key.home) {
  setSelectedRow((i) => Math.max(i - 1, 0))
  return
}

if (key.downArrow || key.end) {
  setSelectedRow((i) => Math.min(i + 1, rows.length - 1))
  return
}

if (key.shift && input === ' ') {
  const row = rows[selectedRow]
  if (row?.type === 'key') {
    handleDelete(row.provider, row.keyIndex)
  }
  return
}

if (key.return) {
  const row = rows[selectedRow]
  if (!row) return
  if (row.type === 'add') {
    setSelectingProvider(true)
    onTabsHiddenChange(true)
    return
  }
  if (setActiveBackupToken(row.provider, row.keyIndex)) {
    setNotice(`Applied ${row.provider}`)
  }
  return
}


})

if (selectingProvider) {
return (
<ProviderSelectPanel
onSelect={(preset) => {
setSelectedProvider(preset)
setSelectingProvider(false)
setAdding(true)
onTabsHiddenChange(true)
}}
onCancel={cancelProviderFlow}
/>
)
}

if (adding) {
const metadata = getProviderPresetUiMetadata(selectedProvider)
return ( <Box flexDirection="column"> <Box marginBottom={1}> <Text bold color="permission">
Add Backup Key </Text> </Box> <Box marginBottom={1}> <Text dimColor>Provider: </Text> <Text>{metadata.label}</Text> </Box> <Box> <Text dimColor>API Key: </Text>
<TextInput
value={newKey}
onChange={setNewKey}
onSubmit={handleAdd}
columns={Math.max(20, inputColumns - 10)}
cursorOffset={cursorOffset}
onChangeCursorOffset={setCursorOffset}
placeholder="sk-... or key1:key2:key3"
focus
showCursor
disableEscapeDoublePress={true}
onExit={cancelProviderFlow}
/> </Box> <Box marginTop={1}> <Text dimColor>Enter save · Esc cancel · Paste many keys with separators</Text> </Box> </Box>
)
}

return ( <Box flexDirection="column">
{!Object.keys(providers).length && ( <Box marginBottom={1}> <Text dimColor>No backup keys configured</Text> </Box>
)} <Box marginBottom={1}> <Text dimColor>Enter applies the selected token · Shift+Space deletes it · Add new token lives at the bottom</Text> </Box>
{rows.map((row, index) => {
const focused = index === selectedRow && !headerFocused
if (row.type === 'add') {
return ( <Box key="add" flexDirection="row" marginBottom={1}> <Box width={46}>
<Text color={focused ? 'cyan' : undefined} bold={focused}>
{focused ? '▶ ' : '  '}
Add new backup key </Text> </Box> <Box width={24}>
<Text color={focused ? 'yellow' : 'gray'}>{focused ? 'Enter apply' : 'Select'}</Text> </Box> </Box>
)
}


    return (
      <Box key={`${row.provider}:${row.keyIndex}`} flexDirection="row" marginBottom={1}>
        <Box width={22}>
          <Text color={focused ? 'cyan' : undefined} bold={focused}>
            {focused ? '▶ ' : '  '}
            {row.provider}
          </Text>
        </Box>
        <Box width={28}>
          <Text color={focused ? 'yellow' : 'gray'}>
            {row.masked}
          </Text>
        </Box>
        <Box width={18}>
          <Text color={row.active ? 'green' : 'gray'}>{row.active ? '[✔]' : ''}</Text>
        </Box>
      </Box>
    )
  })}
  {!!notice && (
    <Box marginTop={1}>
      <Text color="green">✓ {notice}</Text>
    </Box>
  )}
</Box>


)
}

function ProviderSelectPanel({
onSelect,
onCancel,
}: {
onSelect: (preset: ProviderPreset) => void
onCancel: () => void
}) {
const options: OptionWithDescription<string>[] = ORDERED_PROVIDER_PRESETS.map((preset) => {
const metadata = getProviderPresetUiMetadata(preset)
return {
value: preset,
label: metadata.label,
description: metadata.description,
}
})

return ( <Box flexDirection="column"> <Box marginBottom={1}> <Text bold color="permission">
Select Provider </Text> </Box> <Box marginBottom={1}> <Text dimColor>Which provider is this backup key for?</Text> </Box>
<Select
options={options}
onChange={(value: string) => onSelect(value as ProviderPreset)}
onCancel={onCancel}
visibleOptionCount={Math.min(13, options.length)}
/> </Box>
)
}
