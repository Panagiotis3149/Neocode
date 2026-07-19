import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  deepMerge,
  deepMergeInto,
  disableRequestExtraOverride,
  getMergedRequestExtras,
  listRequestExtraOverrides,
  setRequestExtraOverride,
} from './requestExtras.js'
import { updateSettingsForSource } from './settings/settings.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'

const LOCK_KEY = 'requestExtras'

beforeEach(async () => {
  await acquireSharedMutationLock(LOCK_KEY)
})

afterEach(() => {
  updateSettingsForSource('userSettings', { requestExtraOverrides: [] })
  releaseSharedMutationLock(LOCK_KEY)
})

test('exact id match wins over prefix wins over global', () => {
  setRequestExtraOverride({ match: '*', json: { a: 1, b: { x: 1 } } })
  setRequestExtraOverride({ match: 'tencent/*', json: { b: { y: 2 } } })
  setRequestExtraOverride({
    match: 'tencent/hy3-20260706:free',
    json: { b: { z: 3 } },
  })
  const merged = getMergedRequestExtras('tencent/hy3-20260706:free')
  expect(merged).toEqual({ a: 1, b: { x: 1, y: 2, z: 3 } })
})

test('nested extra_body.chat_template_kwargs merges correctly', () => {
  setRequestExtraOverride({
    match: 'tencent/*',
    json: {
      extra_body: { chat_template_kwargs: { reasoning_effort: 'high' } },
    },
  })
  const merged = getMergedRequestExtras('tencent/hy3-20260706:free')
  expect(merged).toEqual({
    extra_body: { chat_template_kwargs: { reasoning_effort: 'high' } },
  })
})

test('placeholder substituted with effort level', () => {
  setRequestExtraOverride({
    match: 'tencent/*',
    json: {
      extra_body: { chat_template_kwargs: { reasoning_effort: '$reasoning_effort' } },
    },
  })
  const merged = getMergedRequestExtras('tencent/hy3-20260706:free', {
    reasoningEffort: 'low',
  })
  expect(merged).toEqual({
    extra_body: { chat_template_kwargs: { reasoning_effort: 'low' } },
  })
})

test('disabled override does not match', () => {
  setRequestExtraOverride({ match: 'nvidia/*', json: { reasoning: 'high' } })
  disableRequestExtraOverride('nvidia/*')
  expect(getMergedRequestExtras('nvidia/foo')).toEqual({})
})

test('upsert without duplicating on same match', () => {
  setRequestExtraOverride({ match: 'deepseek/*', json: { reasoning_effort: 'low' } })
  setRequestExtraOverride({ match: 'deepseek/*', json: { reasoning_effort: 'high' } })
  const all = listRequestExtraOverrides().filter(o => o.match === 'deepseek/*')
  expect(all.length).toBe(1)
  expect(all[0].json).toEqual({ reasoning_effort: 'high' })
})

test('empty match / non-object json rejected', () => {
  expect(setRequestExtraOverride({ match: '', json: {} }).error).toBeInstanceOf(Error)
  expect(
    setRequestExtraOverride({ match: 'x/*', json: [] as unknown as Record<string, unknown> }).error,
  ).toBeInstanceOf(Error)
})

test('no overrides returns empty', () => {
  expect(getMergedRequestExtras('whatever')).toEqual({})
})

test('deepMerge arrays are replaced, not concatenated', () => {
  const out = deepMerge({ a: [1, 2] }, { a: [3] })
  expect(out).toEqual({ a: [3] })
})

test('deepMergeInto mutates target in place', () => {
  const target: Record<string, unknown> = { a: 1 }
  deepMergeInto(target, { b: 2 })
  expect(target).toEqual({ a: 1, b: 2 })
})
