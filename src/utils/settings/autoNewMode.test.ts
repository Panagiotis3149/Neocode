import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../../bootstrap/state.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from './settingsCache.js'

type SettingsModule = typeof import('./settings.js')

// Make the test hermetic without mocking the settings module (a mock on
// 'settings.js' hangs in Bun for this project). getAutoNewModeConfig reads the
// disk-backed sources via getSettingsForSource directly; we seed those sources in
// the per-source cache to null so only the flagSettings the test controls can
// contribute, preventing a real on-disk config from leaking in.
const KEY = 'utils/settings/autoNewMode.test.ts'

function resetBootstrap() {
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  resetSettingsCache()
}

// Use the singleton settings module (no query string) so that it shares the same
// bootstrap/state.js instance as this test — setFlagSettingsInline writes inline
// flag settings into that shared singleton, which getAutoModeConfig / getAutoNewModeConfig
// read via getSettingsForSource('flagSettings'). resetSettingsCache() clears the per-source
// settings cache so the new inline flags are re-read on the next getAutoNewModeConfig() call.
const settings = (await import('./settings.js')) as SettingsModule

async function loadSettings(inline: Record<string, unknown>) {
  resetSettingsCache()
  // Prevent real on-disk / MDM / remote settings from leaking in; only the
  // flagSettings this test controls may contribute to the merged config.
  setCachedSettingsForSource('userSettings', null)
  setCachedSettingsForSource('localSettings', null)
  setCachedSettingsForSource('policySettings', null)
  setFlagSettingsInline(inline as never)
  return settings
}

beforeEach(async () => {
  await acquireSharedMutationLock(KEY)
  setAllowedSettingSources(['flagSettings'])
})

afterEach(() => {
  resetBootstrap()
  setAllowedSettingSources([
    'userSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
    'projectSettings',
  ])
  releaseSharedMutationLock()
})

test('applies defaults when autoNewMode is absent', async () => {
  const mod = await loadSettings({})
  const cfg = mod.getAutoNewModeConfig()
  expect(cfg.thinkMode).toBe('2')
  expect(cfg.thinkDepth).toBe(2)
  expect(cfg.shiftDelete).toBe('ask')
  expect(cfg.tempRead).toBe('allow')
  expect(cfg.other).toBe('ask')
})

test('thinkMode is honored and other defaults still apply', async () => {
  const mod = await loadSettings({ autoNewMode: { thinkMode: '1' } })
  const cfg = mod.getAutoNewModeConfig()
  expect(cfg.thinkMode).toBe('1')
  expect(cfg.tempWrite).toBe('allow')
  expect(cfg.onlineWrite).toBe('ask')
  expect(cfg.safeDev).toBe('allow')
})

test('thinkDepth 1..5 is honored', async () => {
  const mod = await loadSettings({ autoNewMode: { thinkDepth: 5 } })
  expect(mod.getAutoNewModeConfig().thinkDepth).toBe(5)

  const mod2 = await loadSettings({ autoNewMode: { thinkDepth: 1 } })
  expect(mod2.getAutoNewModeConfig().thinkDepth).toBe(1)
})

test('thinkToThink is a valid category policy', async () => {
  const mod = await loadSettings({ autoNewMode: { recycleBin: 'thinkToThink' } })
  expect(mod.getAutoNewModeConfig().recycleBin).toBe('thinkToThink')
})
