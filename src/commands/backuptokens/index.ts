import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'

export type BackupTokenCallContext = ToolUseContext & LocalJSXCommandContext

const backuptokens = {
  type: 'local-jsx',
  name: 'backuptokens',
  description: 'Manage backup API keys and rate-limit rotation status',
  load: () => import('./backuptokens.js'),
} satisfies Command

export default backuptokens

export type { LocalJSXCommandOnDone, ToolUseContext }
