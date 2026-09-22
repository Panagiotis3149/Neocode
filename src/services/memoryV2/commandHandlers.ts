import {
  MEMORY_ONLY_FORGET_MESSAGE,
  SESSION_HISTORY_DELETE_COMMANDS,
} from '../../memdir/memdir.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from './featureGates.js'

export type SessionHistoryCommand = 'delete-history' | 'reset'

export type MemoryV2CommandHandlers = Readonly<{
  forgetMemory: (selector: string) => void | Promise<void>
  deleteSessionHistory: (command: SessionHistoryCommand) => void | Promise<void>
}>

export class MemoryV2CommandUnavailableError extends Error {
  constructor() {
    super('Memory V2 command hooks are not enabled')
    this.name = 'MemoryV2CommandUnavailableError'
  }
}

export class MemoryV2CommandUsageError extends Error {
  constructor() {
    super(`Expected /forget <memory> or ${SESSION_HISTORY_DELETE_COMMANDS}`)
    this.name = 'MemoryV2CommandUsageError'
  }
}

let handlers: MemoryV2CommandHandlers | null = null

export function configureMemoryV2CommandHandlers(next: MemoryV2CommandHandlers, gates: FeatureGateRequest = {}): void {
  if (!isFeatureGateEnabled('MEMORY_STORE_V2', gates)) throw new MemoryV2CommandUnavailableError()
  if (typeof next.forgetMemory !== 'function' || typeof next.deleteSessionHistory !== 'function') {
    throw new TypeError('Memory V2 command hooks must be callable')
  }
  handlers = Object.freeze({ ...next })
}

export function clearMemoryV2CommandHandlers(): void {
  handlers = null
}

export function isMemoryV2CommandEnabled(): boolean {
  return handlers !== null
}

export function isSessionHistoryCommand(args: string): boolean {
  const normalized = args.trim()
  return normalized === 'delete-history' || normalized === 'reset --delete-history'
}

export async function executeForgetCommand(args: string): Promise<string> {
  const current = handlers
  if (!current) throw new MemoryV2CommandUnavailableError()
  const selector = args.trim()
  if (!selector) throw new MemoryV2CommandUsageError()
  await current.forgetMemory(selector)
  clearSystemPromptSections()
  return MEMORY_ONLY_FORGET_MESSAGE
}

export async function executeSessionHistoryCommand(args: string): Promise<string> {
  const current = handlers
  if (!current) throw new MemoryV2CommandUnavailableError()
  const normalized = args.trim()
  const command: SessionHistoryCommand = normalized === 'delete-history'
    ? 'delete-history'
    : normalized === 'reset --delete-history'
      ? 'reset'
      : (() => { throw new MemoryV2CommandUsageError() })()
  await current.deleteSessionHistory(command)
  clearSystemPromptSections()
  return command === 'reset' ? 'Session reset with history deletion completed.' : 'Session history deletion completed.'
}
