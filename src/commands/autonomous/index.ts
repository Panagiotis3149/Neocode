import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const COMMAND_DESCRIPTION =
  'Enable or disable Autonomous (Auto New) mode. Configuration lives in its own "Auto (New)" tab under /permissions.'

const USAGE_HINT =
  'Usage: /autonomous [on|off]   (no argument toggles the current state)'

const EXAMPLES = [
  '  /autonomous        toggle Autonomous mode on/off',
  '  /autonomous on     enable Autonomous mode',
  '  /autonomous off    disable Autonomous mode',
  '  /permissions       open the settings UI (Auto New tab holds the policy)',
].join('\n')

export function getCommandMetadata() {
  return {
    description: COMMAND_DESCRIPTION,
    usage: USAGE_HINT,
    examples: EXAMPLES,
  }
}

export function formatSettingsInstructions(): string {
  return `${USAGE_HINT}\n${EXAMPLES}`
}

export default {
  type: 'local-jsx',
  name: 'autonomous',
  description: COMMAND_DESCRIPTION,
  argumentHint: '[on|off]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./autonomous.js'),
} satisfies Command
