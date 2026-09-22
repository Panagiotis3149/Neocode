import { getIsRemoteMode } from '../../bootstrap/state.js'
import { isMemoryV2CommandEnabled } from '../../services/memoryV2/commandHandlers.js'
import type { Command } from '../../commands.js'

const session = {
  type: 'local-jsx',
  name: 'session',
  aliases: ['remote'],
  description: 'Show remote session URL and QR code',
  isEnabled: () => getIsRemoteMode() || isMemoryV2CommandEnabled(),
  get isHidden() {
    return !getIsRemoteMode() && !isMemoryV2CommandEnabled()
  },
  load: () => import('./session.js'),
} satisfies Command

export default session
