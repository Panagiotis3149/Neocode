import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  clearContextWindowOverride,
  getContextWindowOverride,
  listContextWindowOverrides,
  parseContextWindowSize,
  setContextWindowOverride,
} from './contextWindowOverrides.js'
import { updateSettingsForSource } from './settings/settings.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'

const LOCK_KEY = 'contextWindowOverrides'

beforeEach(async () => {
  await acquireSharedMutationLock(LOCK_KEY)
})

afterEach(() => {
  // { contextWindowOverrides: {} } does a deep merge (preserves keys);
  // use undefined to trigger the delete logic in mergeWith.
  updateSettingsForSource('userSettings', { contextWindowOverrides: undefined })
  releaseSharedMutationLock(LOCK_KEY)
})

test('parseContextWindowSize: accepts naked integer within bounds', () => {
  expect(parseContextWindowSize('16384')).toBe(16384)
  expect(parseContextWindowSize('200000')).toBe(200000)
  expect(parseContextWindowSize('2147483647')).toBe(2147483647)
})

test('parseContextWindowSize: accepts k suffix (case-insensitive)', () => {
  expect(parseContextWindowSize('17k')).toBe(17000)
  expect(parseContextWindowSize('256k')).toBe(256000)
  expect(parseContextWindowSize('256K')).toBe(256000)
  expect(parseContextWindowSize('1000k')).toBe(1000000)
})

test('parseContextWindowSize: accepts m suffix with decimals (case-insensitive)', () => {
  expect(parseContextWindowSize('1m')).toBe(1000000)
  expect(parseContextWindowSize('1M')).toBe(1000000)
  expect(parseContextWindowSize('0.5m')).toBe(500000)
  expect(parseContextWindowSize('0.5M')).toBe(500000)
  expect(parseContextWindowSize('2.5m')).toBe(2500000)
})

test('parseContextWindowSize: rejects decimal with k suffix', () => {
  expect(() => parseContextWindowSize('1.5k')).toThrow()
})

test('parseContextWindowSize: rejects values below minimum', () => {
  expect(() => parseContextWindowSize('10k')).toThrow('Context window must be between 16384 and 2147483647.')
  expect(() => parseContextWindowSize('15000')).toThrow('Context window must be between 16384 and 2147483647.')
})

test('parseContextWindowSize: rejects values above maximum', () => {
  expect(() => parseContextWindowSize('2147483648')).toThrow()
  expect(() => parseContextWindowSize('3000m')).toThrow()
})

test('parseContextWindowSize: rejects empty and non-numeric', () => {
  expect(() => parseContextWindowSize('')).toThrow('Usage: /context <size>')
  expect(() => parseContextWindowSize('abc')).toThrow('Usage: /context <size>')
  expect(() => parseContextWindowSize('k')).toThrow('Usage: /context <size>')
  expect(() => parseContextWindowSize('1g')).toThrow('Usage: /context <size>')
})

test('parseContextWindowSize: reset aliases throw RESET sentinel', () => {
  expect(() => parseContextWindowSize('reset')).toThrow('RESET')
  expect(() => parseContextWindowSize('0')).toThrow('RESET')
  expect(() => parseContextWindowSize('-1')).toThrow('RESET')
})

test('setContextWindowOverride: exact model id only, no prefix match', () => {
  setContextWindowOverride('openai/gpt-4', 256000)
  const o = getContextWindowOverride('openai/gpt-4')
  expect(o?.contextWindowTokens).toBe(256000)

  // Prefix should not match
  expect(getContextWindowOverride('openai/gpt-4-turbo')).toBeUndefined()
})

test('setContextWindowOverride: upserts without duplicating', () => {
  setContextWindowOverride('nvidia/nemotron', 500000)
  setContextWindowOverride('nvidia/nemotron', 1000000)
  const all = listContextWindowOverrides()
  expect(Object.keys(all).length).toBe(1)
  expect(all['nvidia/nemotron']?.contextWindowTokens).toBe(1000000)
})

test('setContextWindowOverride: validates bounds', () => {
  expect(setContextWindowOverride('test/model', 10000).error).toBeInstanceOf(Error)
  expect(setContextWindowOverride('test/model', 3000000000).error).toBeInstanceOf(Error)
})

test('clearContextWindowOverride: removes override', () => {
  setContextWindowOverride('test/model', 256000)
  clearContextWindowOverride('test/model')
  expect(getContextWindowOverride('test/model')).toBeUndefined()
})

test('clearContextWindowOverride: idempotent on missing key', () => {
  expect(clearContextWindowOverride('nonexistent/model').error).toBeNull()
})

test('listContextWindowOverrides: returns copy', () => {
  setContextWindowOverride('model/a', 100000)
  setContextWindowOverride('model/b', 200000)
  const all = listContextWindowOverrides()
  expect(Object.keys(all).length).toBe(2)
  expect(all['model/a']?.contextWindowTokens).toBe(100000)
  expect(all['model/b']?.contextWindowTokens).toBe(200000)

  // Mutate the copy shouldn't affect internal state
  all['model/a'] = { contextWindowTokens: 999 }
  expect(getContextWindowOverride('model/a')?.contextWindowTokens).toBe(100000)
})

test('normalizeModel: case insensitive and trim', () => {
  setContextWindowOverride('OpenAI/GPT-4', 256000)
  expect(getContextWindowOverride('openai/gpt-4')?.contextWindowTokens).toBe(256000)
  expect(getContextWindowOverride('  openai/gpt-4  ')?.contextWindowTokens).toBe(256000) // trim applied
  expect(getContextWindowOverride('openai/gpt-4')).toBeDefined()
})

test('normalizeModel: strips query params for override lookup', () => {
  setContextWindowOverride('deepseek-ai/deepseek-v4-pro', 1000000)
  expect(getContextWindowOverride('deepseek-ai/deepseek-v4-pro?reasoning=high')?.contextWindowTokens).toBe(1000000)
  expect(getContextWindowOverride('deepseek-ai/deepseek-v4-pro?thinking=medium')?.contextWindowTokens).toBe(1000000)
  expect(getContextWindowOverride('deepseek-ai/deepseek-v4-pro?anything=foo')?.contextWindowTokens).toBe(1000000)
})