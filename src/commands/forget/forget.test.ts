import { afterEach, describe, expect, test } from 'bun:test'
import { call } from './forget.js'
import { clearMemoryV2CommandHandlers, configureMemoryV2CommandHandlers } from '../../services/memoryV2/commandHandlers.js'
import { MEMORY_ONLY_FORGET_MESSAGE } from '../../memdir/memdir.js'

describe('/forget command', () => {
  afterEach(() => clearMemoryV2CommandHandlers())

  test('delegates the selector through the production command module', async () => {
    const selectors: string[] = []
    configureMemoryV2CommandHandlers({
      forgetMemory: selector => { selectors.push(selector) },
      deleteSessionHistory: () => {},
    }, { MEMORY_STORE_V2: true })

    const result = await call('memory-1', {} as never)

    expect(result).toEqual({ type: 'text', value: MEMORY_ONLY_FORGET_MESSAGE })
    expect(selectors).toEqual(['memory-1'])
  })
})
