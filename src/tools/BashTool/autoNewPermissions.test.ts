import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  setAllowedSettingSources,
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

type SettingsModule = typeof import('../../utils/settings/settings.js')
type BashPermModule = typeof import('./bashPermissions.js')

const KEY = 'tools/BashTool/autoNewPermissions.test.ts'

function resetBootstrap() {
  setFlagSettingsInline(null)
  resetSettingsCache()
}

// Use the singleton modules (no query-string dynamic import) so that bashPermissions,
// settings, and this test all share the same bootstrap/state.js instance. setFlagSettingsInline
// writes inline flag settings into that shared singleton; getSettingsForSource('flagSettings')
// reads them, and resetSettingsCache() clears the per-source cache so each load re-reads.
const settings = (await import('../../utils/settings/settings.js')) as SettingsModule
const bash = (await import('./bashPermissions.js')) as BashPermModule

async function load(inline: Record<string, unknown>) {
  resetSettingsCache()
  setFlagSettingsInline(inline as never)
  return { settings, bash }
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

const ctx = {
  ...getEmptyToolPermissionContext(),
  mode: 'autoNew',
} as never

test('allow policy permits immediately', async () => {
  const { bash } = await load({
    autoNewMode: { tempRead: 'allow', onlineRead: 'allow' },
  })
  const res = bash.resolveAutoNewPermission(
    { command: 'cat temp/x.txt', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('allow')
})

test('ask policy surfaces a permission prompt', async () => {
  const { bash } = await load({ autoNewMode: { onlineWrite: 'ask' } })
  const res = bash.resolveAutoNewPermission(
    { command: 'git push', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('ask')
  expect(res.decisionReason).toMatchObject({ type: 'mode', mode: 'autoNew' })
})

test('think + thinkMode 1 still asks (never silent)', async () => {
  const { bash } = await load({
    autoNewMode: { onlineWrite: 'think', thinkMode: '1' },
  })
  const res = bash.resolveAutoNewPermission(
    { command: 'git push', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('ask')
})

test('think + thinkMode 2 silently allows', async () => {
  const { bash } = await load({
    autoNewMode: { onlineWrite: 'think', thinkMode: '2' },
  })
  const res = bash.resolveAutoNewPermission(
    { command: 'git push', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('allow')
})

test('thinkToThink resolves to the user thinkMode choice', async () => {
  const { bash } = await load({
    autoNewMode: { recycleBin: 'thinkToThink', thinkMode: '2' },
  })
  const res = bash.resolveAutoNewPermission(
    { command: 'rm old.txt', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('allow')
})

test('thinkToThink + thinkMode 1 asks', async () => {
  const { bash } = await load({
    autoNewMode: { recycleBin: 'thinkToThink', thinkMode: '1' },
  })
  const res = bash.resolveAutoNewPermission(
    { command: 'rm old.txt', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('ask')
})

test('allow policy permits even catastrophic commands (defers to policy)', async () => {
  const { bash } = await load({ autoNewMode: { shiftDelete: 'allow' } })
  const res = bash.resolveAutoNewPermission(
    { command: 'rm -rf /', description: undefined } as never,
    ctx,
  )
  // shiftDelete=allow means autoNew permits it even though it is catastrophic;
  // the safety here comes from the user's explicit category policy.
  expect(res.behavior).toBe('allow')
})

test('explicit deny rule wins over allow policy', async () => {
  const { bash } = await load({ autoNewMode: { shiftDelete: 'allow' } })
  // A prefix deny rule must take precedence over the per-category allow policy.
  const denyCtx = {
    ...getEmptyToolPermissionContext(),
    mode: 'autoNew',
    alwaysDenyRules: {
      userSettings: ['Bash(rm -rf /:*)'],
    },
  } as never
  const res = bash.resolveAutoNewPermission(
    { command: 'rm -rf /', description: undefined } as never,
    denyCtx,
  )
  expect(res.behavior).toBe('deny')
})

test('runScript default allow permits interpreter-launched scripts', async () => {
  const { bash } = await load({})
  const res = bash.resolveAutoNewPermission(
    { command: 'node server.js', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('allow')
})

test('runScript policy can be set to ask', async () => {
  const { bash } = await load({ autoNewMode: { runScript: 'ask' } })
  const res = bash.resolveAutoNewPermission(
    { command: 'python x.py', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('ask')
})

test('runExecutable default ask prompts for direct binaries', async () => {
  const { bash } = await load({})
  const res = bash.resolveAutoNewPermission(
    { command: './dist/app', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('ask')
})

test('runExecutable policy can be set to allow', async () => {
  const { bash } = await load({ autoNewMode: { runExecutable: 'allow' } })
  const res = bash.resolveAutoNewPermission(
    { command: '/usr/local/bin/tool', description: undefined } as never,
    ctx,
  )
  expect(res.behavior).toBe('allow')
})
