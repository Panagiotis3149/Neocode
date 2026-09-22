import { isMemoryV2CommandEnabled } from '../../services/memoryV2/commandHandlers.js'
import type { Command } from '../../types/command.js'

const forget = {
  type: 'local',
  name: 'forget',
  description: 'Forget a durable memory without deleting session history',
  supportsNonInteractive: true,
  isEnabled: isMemoryV2CommandEnabled,
  load: () => import('./forget.js'),
} satisfies Command

export default forget
