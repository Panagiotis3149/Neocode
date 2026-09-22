import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'goal',
  description: 'Autonomously execute a feature goal until fully completed and verified',
  argumentHint: '<goal description>',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./goal.js'),
} satisfies Command
