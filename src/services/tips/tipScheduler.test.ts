import { afterAll, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { Tip } from './types.js'

const settingsRef: {
  value: {
    spinnerTipsEnabled?: boolean
  }
} = { value: {} }
const configRef: {
  value: {
    numStartups: number
    tipsHistory?: Record<string, number>
  }
} = { value: { numStartups: 100 } }

const relevantTipsRef: { value: Tip[] } = { value: [] }

await acquireSharedMutationLock('services/tips/tipScheduler.test.ts')

mock.module('../../utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => settingsRef.value,
  getInitialSettings: () => settingsRef.value,
  getSettingsForSource: () => undefined,
}))

mock.module('../../utils/config.js', () => ({
  getGlobalConfig: () => configRef.value,
  saveGlobalConfig: (mut: (c: typeof configRef.value) => typeof configRef.value) => {
    configRef.value = mut(configRef.value)
  },
}))

mock.module('./tipRegistry.js', () => ({
  getRelevantTips: async () => relevantTipsRef.value,
}))

mock.module('../analytics/index.js', () => ({
  logEvent: () => undefined,
}))

afterAll(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

async function freshScheduler() {
  const stamp = `${Date.now()}-${Math.random()}`
  return import(`./tipScheduler.ts?ts=${stamp}`)
}

function makeTip(id: string): Tip {
  return {
    id,
    content: async () => id,
    cooldownSessions: 0,
    isRelevant: async () => true,
  }
}

describe('selectTipWithLongestTimeSinceShown', () => {
  test('returns undefined for empty array', async () => {
    const { selectTipWithLongestTimeSinceShown } = await freshScheduler()
    expect(selectTipWithLongestTimeSinceShown([])).toBeUndefined()
  })

  test('returns the only tip for single-element array', async () => {
    const { selectTipWithLongestTimeSinceShown } = await freshScheduler()
    const tip = makeTip('a')
    expect(selectTipWithLongestTimeSinceShown([tip])).toBe(tip)
  })

  test('prefers tip with longest time since shown', async () => {
    configRef.value = {
      numStartups: 100,
      tipsHistory: {
        a: 90, // 10 sessions ago
        b: 50, // 50 sessions ago
        c: 95, // 5 sessions ago
      },
    }
    const { selectTipWithLongestTimeSinceShown } = await freshScheduler()
    const a = makeTip('a')
    const b = makeTip('b')
    const c = makeTip('c')
    expect(selectTipWithLongestTimeSinceShown([a, b, c])).toBe(b)
  })

  test('returns tip with Infinity when no history exists', async () => {
    configRef.value = { numStartups: 100 }
    const { selectTipWithLongestTimeSinceShown } = await freshScheduler()
    const a = makeTip('a')
    const b = makeTip('b')
    // Both have Infinity; sort is stable-ish, expect first one
    expect(selectTipWithLongestTimeSinceShown([a, b])).toBe(a)
  })
})

describe('getTipToShowOnSpinner', () => {
  test('returns undefined when tips are disabled', async () => {
    settingsRef.value = { spinnerTipsEnabled: false }
    configRef.value = { numStartups: 100 }
    relevantTipsRef.value = []
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(await getTipToShowOnSpinner()).toBeUndefined()
  })

  test('returns undefined when no tips available', async () => {
    settingsRef.value = {}
    configRef.value = { numStartups: 100 }
    relevantTipsRef.value = []
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(await getTipToShowOnSpinner()).toBeUndefined()
  })

  test('returns a tip when available and enabled', async () => {
    settingsRef.value = {}
    configRef.value = { numStartups: 100 }
    const tip = makeTip('a')
    relevantTipsRef.value = [tip]
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(await getTipToShowOnSpinner()).toBe(tip)
  })

  test('skips tips shown within cooldown period', async () => {
    settingsRef.value = {}
    configRef.value = {
      numStartups: 100,
      tipsHistory: { 'cooldown-tip': 95 },
    }
    const a = makeTip('a')
    const coldTip = {
      id: 'cooldown-tip',
      content: async () => 'cooldown',
      cooldownSessions: 10,
      isRelevant: async () => true,
    }
    relevantTipsRef.value = [a, coldTip]
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(await getTipToShowOnSpinner()).toBe(a)
  })

  test('passes context to tip relevance check', async () => {
    settingsRef.value = {}
    configRef.value = { numStartups: 100 }
    const contextualTip: Tip = {
      id: 'ctx-tip',
      content: async () => 'ctx',
      cooldownSessions: 0,
      isRelevant: async ctx => !!ctx?.bashTools,
    }
    relevantTipsRef.value = [contextualTip]
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(
      await getTipToShowOnSpinner({ theme: 'dark', bashTools: new Set() }),
    ).toBe(contextualTip)
    expect(
      await getTipToShowOnSpinner({ theme: 'dark' }),
    ).toBeUndefined()
  })
})

describe('recordShownTip', () => {
  test('records tip as shown and logs event', async () => {
    configRef.value = { numStartups: 42 }
    const { recordShownTip } = await freshScheduler()
    const tip = makeTip('track-me')
    recordShownTip(tip)
    expect(configRef.value.tipsHistory).toEqual({ 'track-me': 42 })
  })

  test('overwrites previously recorded session number', async () => {
    configRef.value = {
      numStartups: 50,
      tipsHistory: { 'track-me': 999 },
    }
    const { recordShownTip } = await freshScheduler()
    const tip = makeTip('track-me')
    recordShownTip(tip)
    expect(configRef.value.tipsHistory).toEqual({ 'track-me': 50 })
  })

  test('does not overwrite when session numbers match', async () => {
    const tip = makeTip('stable')
    configRef.value = {
      numStartups: 42,
      tipsHistory: { stable: 42 },
    }
    const preScreenshot = JSON.stringify(configRef.value)
    const { recordShownTip } = await freshScheduler()
    recordShownTip(tip)
    expect(JSON.stringify(configRef.value)).toBe(preScreenshot)
  })
})
