import type { LocalCommandCall } from '../../types/command.js'
import { executeForgetCommand } from '../../services/memoryV2/commandHandlers.js'

export const call: LocalCommandCall = async args => {
  return { type: 'text', value: await executeForgetCommand(args) }
}
