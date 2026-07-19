import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  disableReasoningEffortOverride,
  getReasoningEffortOverride,
  listReasoningEffortOverrides,
  setReasoningEffortOverride,
} from './effortOverrides.js'
import { updateSettingsForSource } from './settings/settings.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'

const LOCK_KEY = 'effortOverrides'

beforeEach(async () => {
  await acquireSharedMutationLock(LOCK_KEY)
})

afterEach(() => {
  // Reset overrides so tests don't leak into each other's userSettings.
  updateSettingsForSource('userSettings', { reasoningEffortOverrides: [] })
  releaseSharedMutationLock(LOCK_KEY)
})

test('prefix match selects via trailing *', () => {
  setReasoningEffortOverride({ match: 'novita/*', param: 'reasoning_effort' })
  const o = getReasoningEffortOverride('novita/llama-3.1-8b')
  expect(o).toBeDefined()
  expect(o?.param).toBe('reasoning_effort')
  expect(o?.match).toBe('novita/*')
})

test('exact id match wins over prefix', () => {
  setReasoningEffortOverride({ match: 'novita/*', param: 'reasoning' })
  setReasoningEffortOverride({ match: 'novita/llama-3.1-8b', param: 'reasoning_effort' })
  const o = getReasoningEffortOverride('novita/llama-3.1-8b')
  expect(o?.param).toBe('reasoning_effort')
  expect(o?.match).toBe('novita/llama-3.1-8b')
})

test('disabled override does not match', () => {
  setReasoningEffortOverride({ match: 'nvidia/*', param: 'reasoning' })
  disableReasoningEffortOverride('nvidia/*')
  expect(getReasoningEffortOverride('nvidia/foo')).toBeUndefined()
})

test('set upserts without duplicating on same match', () => {
  setReasoningEffortOverride({ match: 'deepseek/*', param: 'reasoning' })
  setReasoningEffortOverride({ match: 'deepseek/*', param: 'thinking' })
  const all = listReasoningEffortOverrides().filter(o => o.match === 'deepseek/*')
  expect(all.length).toBe(1)
  expect(all[0].param).toBe('thinking')
  expect(all[0].enabled).toBe(true)
})

test('empty match/param rejected', () => {
  expect(setReasoningEffortOverride({ match: '', param: 'reasoning' }).error).toBeInstanceOf(Error)
  expect(setReasoningEffortOverride({ match: 'x/*', param: '' }).error).toBeInstanceOf(Error)
})
