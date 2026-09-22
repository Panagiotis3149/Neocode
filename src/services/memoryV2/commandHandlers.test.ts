import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearMemoryV2CommandHandlers,
  configureMemoryV2CommandHandlers,
  executeForgetCommand,
  executeSessionHistoryCommand,
  MemoryV2CommandUnavailableError,
} from './commandHandlers.js'

const gates = { MEMORY_STORE_V2: true } as const

describe('memory V2 command handlers', () => {
  afterEach(() => clearMemoryV2CommandHandlers())

  test('forget delegates the selector to the tombstone and revoke hook', async () => {
    let selected = ''
    configureMemoryV2CommandHandlers({
      forgetMemory: async selector => { selected = selector },
      deleteSessionHistory: async () => {},
    }, gates)

    await expect(executeForgetCommand('  cat name  ')).resolves.toContain('Forgotten from durable memory.')
    expect(selected).toBe('cat name')
  })

  test('session history commands route both explicit deletion forms', async () => {
    const modes: string[] = []
    configureMemoryV2CommandHandlers({
      forgetMemory: async () => {},
      deleteSessionHistory: async mode => { modes.push(mode) },
    }, gates)

    await executeSessionHistoryCommand('delete-history')
    await executeSessionHistoryCommand('reset --delete-history')

    expect(modes).toEqual(['delete-history', 'reset'])
  })

  test('commands fail closed when V2 hooks are not registered', async () => {
    await expect(executeForgetCommand('memory')).rejects.toBeInstanceOf(MemoryV2CommandUnavailableError)
    await expect(executeSessionHistoryCommand('delete-history')).rejects.toBeInstanceOf(MemoryV2CommandUnavailableError)
  })

  test('registration is disabled unless the store gate is effective', () => {
    expect(() => configureMemoryV2CommandHandlers({
      forgetMemory: async () => {},
      deleteSessionHistory: async () => {},
    })).toThrow(MemoryV2CommandUnavailableError)
  })
})
