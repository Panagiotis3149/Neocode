import { expect, test } from 'bun:test'
import {
  parseTokenBudget,
  parseTokenBudgetWithMode,
} from './tokenBudget.js'

test('shorthand +500k parses as target', () => {
  expect(parseTokenBudget('+500k')).toBe(500_000)
  expect(parseTokenBudgetWithMode('+500k')?.mode).toBe('target')
})

test('plain "use 2M tokens" is a soft target', () => {
  const p = parseTokenBudgetWithMode('use 2M tokens')
  expect(p?.budget).toBe(2_000_000)
  expect(p?.mode).toBe('target')
})

test('"use less than 2M tokens" is a hard cap', () => {
  const p = parseTokenBudgetWithMode('use less than 2M tokens')
  expect(p?.budget).toBe(2_000_000)
  expect(p?.mode).toBe('cap')
})

test('cap synonyms: no more than / at most / maximum of / max', () => {
  for (const phrase of [
    'no more than 1M tokens',
    'no more 1M tokens',
    'at most 1M tokens',
    'maximum of 1M tokens',
    'max 1M tokens',
  ]) {
    const p = parseTokenBudgetWithMode(phrase)
    expect(p?.budget, phrase).toBe(1_000_000)
    expect(p?.mode, phrase).toBe('cap')
  }
})

test('negated instruction is not a budget', () => {
  expect(parseTokenBudget('do not use 2M tokens')).toBeNull()
  expect(parseTokenBudgetWithMode('do not use 2M tokens')).toBeNull()
  expect(parseTokenBudget("don't use 2M tokens")).toBeNull()
  expect(parseTokenBudget('never use 2M tokens')).toBeNull()
})

test('negated instruction is not highlighted', () => {
  const { findTokenBudgetPositions } = require('./tokenBudget.js') as typeof import('./tokenBudget.js')
  expect(findTokenBudgetPositions('do not use 2M tokens')).toHaveLength(0)
})

test('plain number is not a budget', () => {
  expect(parseTokenBudget('the budget is 2M')).toBeNull()
})

test('spend variant works', () => {
  const p = parseTokenBudgetWithMode('spend 500k tokens')
  expect(p?.budget).toBe(500_000)
  expect(p?.mode).toBe('target')
})
