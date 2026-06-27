import * as React from 'react'
import { useCallback, useState } from 'react'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resetAllKeysToDefault, scheduleNextResetAt } from '../../services/api/backupTokenManager.js'
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
import { formatDuration } from '../../utils/format.js'
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

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000,
  yr: 365 * 24 * 60 * 60 * 1000,
}

const TOKEN_RE = /^(\d+)(mo|yr|s|m|h|d|w)$/

type CustomResetSpec =
  | { kind: 'duration'; label: string }
  | { kind: 'schedule'; label: string }

function parseCustomDuration(input: string): number | null {
  if (!input.trim()) return null
  let total = 0
  const tokens = input.trim().split(/\s+/)
  for (const tok of tokens) {
    if (!tok) continue
    const m = tok.match(TOKEN_RE)
    if (!m) return null
    const value = parseInt(m[1], 10)
    if (!Number.isFinite(value) || value <= 0) return null
    const unit = m[2]
    const unitMs = UNIT_MS[unit]
    if (!unitMs) return null
    total += value * unitMs
  }
  return total > 0 ? total : null
}

function formatMeridiemTime(hour: number, minute: number, meridiem: string) {
  const mm = minute.toString().padStart(2, '0')
  return `${hour}:${mm} ${meridiem.toUpperCase()}`
}

function parseCustomScheduleSpec(input: string): CustomResetSpec | null {
  const raw = input.trim()
  if (!raw) return null

  const nextTime = raw.match(/^next\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (nextTime) {
    const hour = parseInt(nextTime[1], 10)
    const minute = nextTime[2] ? parseInt(nextTime[2], 10) : 0
    const meridiem = nextTime[3]
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      return {
        kind: 'schedule',
        label: `next ${formatMeridiemTime(hour, minute, meridiem)}`,
      }
    }
  }

  const nthNextTime = raw.match(/^(\d{1,2})(st|nd|rd|th)\s+next\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (nthNextTime) {
    const day = parseInt(nthNextTime[1], 10)
    const hour = parseInt(nthNextTime[3], 10)
    const minute = nthNextTime[4] ? parseInt(nthNextTime[4], 10) : 0
    const meridiem = nthNextTime[5]
    if (day >= 1 && day <= 31 && hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      return {
        kind: 'schedule',
        label: `${day}${nthNextTime[2]} next ${formatMeridiemTime(hour, minute, meridiem)}`,
      }
    }
  }

  return null
}

function parseCustomResetSpec(input: string): CustomResetSpec | null {
  const raw = input.trim()
  if (!raw) return null

  const duration = parseCustomDuration(raw)
  if (duration !== null) {
    return {
      kind: 'duration',
      label: formatDuration(duration),
    }
  }

  return parseCustomScheduleSpec(raw)
}

function isValidCustomResetSpec(input: string): boolean {
  return parseCustomResetSpec(input) !== null
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
  if (s.resetTiming === 'custom' && !isValidCustomResetSpec(s.customResetTime ?? '')) {
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

  return (
    <Pane color="permission">
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
  const { headerFocused, focusHeader } = useTabHeaderFocus()
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
      if (isValidCustomResetSpec(customTimeInput)) {
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
    const preview = parseCustomResetSpec(customTimeInput)

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="permission">
            Custom duration
          </Text>
        </Box>
        <Box>
          <Text dimColor>Duration: </Text>
          <TextInput
            value={customTimeInput}
            onChange={setCustomTimeInput}
            onSubmit={() => {
              if (isValidCustomResetSpec(customTimeInput)) {
                setSettings((prev) => ({ ...prev, customResetTime: customTimeInput.trim() }))
                setCustomEditorOpen(false)
                onTabsHiddenChange(false)
              }
            }}
            columns={Math.max(20, inputColumns - 14)}
            cursorOffset={customTimeCursorOffset}
            onChangeCursorOffset={setCustomTimeCursorOffset}
            placeholder="e.g. 5mo 4d 3m 1s or next 2AM"
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
            <Text dimColor>Supports durations like 1h 30m or schedules like next 2AM and 7th next 12PM</Text>
          ) : preview ? (
            <Text color="green">✓ {preview.label}</Text>
          ) : (
            <Text color="red">Invalid value. Try 1h 30m, next 2AM, or 7th next 12PM</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter save · Esc back</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {FIELDS.map((f, i) => {
        const isFocused = i === idx && !headerFocused
        return (
          <Box key={f.key} flexDirection="row" marginBottom={1}>
            <Box width={22}>
              <Text color={isFocused ? 'cyan' : undefined} bold={isFocused}>
                {isFocused ? '▶ ' : '  '}
                {f.label}
              </Text>
            </Box>
            <Box width={22}>
              <Text color={isFocused ? 'yellow' : 'gray'}>
                {f.type === 'select' ? '◀ ' : ''}
                {formatValue(f, settings)}
                {f.type === 'select' ? ' ▶' : ''}
              </Text>
            </Box>
          </Box>
        )
      })}
      {saved && (
        <Box marginTop={1}>
          <Text color="green">✓ Settings saved</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ or Home/End move · ←/→ change value · Space opens custom editor · Enter saves · Tab switches tab · Esc closes
        </Text>
      </Box>
    </Box>
  )
}

function splitPastedKeys(raw: string): string[] {
  return raw
    .split(/[\s,:;|]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
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
  const { columns: inputColumns } = useTerminalSize()
  const { headerFocused, focusHeader } = useTabHeaderFocus()

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
    },
    [saveProviders]
  )

  // Reset poller: on mount and every 5 minutes, check if any provider's
  // reset schedule has elapsed and reset + reschedule if so.
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

  useInput((input, key) => {
    if (headerFocused) return

    if (key.escape) {
      if (adding || selectingProvider) {
        cancelProviderFlow()
      }
      return
    }

    if (!adding && !selectingProvider && (key.tab || input === '\t')) {
      return
    }
  })

  const allItems = [
    ...Object.entries(providers).flatMap(([prov, keys]) =>
      keys.map((k, i) => ({
        type: 'key' as const,
        provider: prov,
        keyIndex: i,
        masked: `${k.slice(0, 8)}...${k.slice(-4)}`,
      }))
    ),
    { type: 'add' as const, provider: '', keyIndex: -1, masked: '' },
  ]

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
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="permission">
            Add Backup Key
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Provider: </Text>
          <Text>{metadata.label}</Text>
        </Box>
        <Box>
          <Text dimColor>API Key: </Text>
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
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter save · Esc cancel · Paste many keys with colons</Text>
        </Box>
      </Box>
    )
  }

  const selectOptions = allItems.map((item) => {
    if (item.type === 'add') {
      return {
        value: '__add__',
        label: 'Add new backup key',
        description: 'Select a provider and add one or many fallback API keys',
      }
    }
    return {
      value: `${item.provider}:${item.keyIndex}`,
      label: `${item.provider}: ${item.masked}`,
      description: 'Press Enter to delete this key',
    }
  })

  return (
    <Box flexDirection="column">
      {!Object.keys(providers).length && (
        <Box marginBottom={1}>
          <Text dimColor>No backup keys configured</Text>
        </Box>
      )}
      <Select
        options={selectOptions}
        onChange={(value: string) => {
          if (value === '__add__') {
            setSelectingProvider(true)
            onTabsHiddenChange(true)
            return
          }
          const [provider, idxStr] = value.split(':')
          const keyIndex = parseInt(idxStr, 10)
          handleDelete(provider, keyIndex)
        }}
        onCancel={() => {}}
        isDisabled={headerFocused}
        onUpFromFirstItem={focusHeader}
        visibleOptionCount={Math.min(10, allItems.length + 1)}
      />
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Enter add/delete · Tab switch tab · Esc close</Text>
      </Box>
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

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="permission">
          Select Provider
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>Which provider is this backup key for?</Text>
      </Box>
      <Select
        options={options}
        onChange={(value: string) => onSelect(value as ProviderPreset)}
        onCancel={onCancel}
        visibleOptionCount={Math.min(13, options.length)}
      />
    </Box>
  )
}