import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { getInvokedSkillsForAgent } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { count } from '../array.js'
import { getCwd } from '../cwd.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import {
  createUserMessage,
  extractTag,
  extractTextContent,
} from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { jsonParse } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  GeneratedSkillNotFoundError,
  GeneratedSkillStore,
  isVerifiedGeneratedSkillMutationCapability,
  resolveGeneratedSkillStoreOptions,
  type GeneratedSkillStoreOptions,
} from '../../services/generatedSkills/store.js'
import { isFeatureGateEnabled, type FeatureGateRequest } from '../../services/memoryV2/featureGates.js'
import { REVIEWER_PLACEHOLDER_INSTRUCTIONS, sanitizeReviewerPayload, validateReviewerOutput } from '../../services/memoryV2/reviewer.js'
import { getMemoryV2SkillRuntimeConfig } from '../../services/memoryV2/skillRuntimeConfig.js'
import {
  type ApiQueryHookConfig,
  createApiQueryHook,
} from './apiQueryHookHelper.js'
import { registerPostSamplingHook } from './postSamplingHooks.js'

const TURN_BATCH_SIZE = 5

export type SkillUpdate = {
  section: string
  change: string
  reason: string
}

function formatRecentMessages(messages: Message[]): string {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      const role = m.type === 'user' ? 'User' : 'Assistant'
      const content = m.message.content
      if (typeof content === 'string')
        return `${role}: ${content.slice(0, 500)}`
      const text = content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
      return `${role}: ${text.slice(0, 500)}`
    })
    .join('\n\n')
}

function findProjectSkill() {
  const skills = getInvokedSkillsForAgent(null)
  for (const [, info] of skills) {
    if (info.skillPath.startsWith('projectSettings:')) {
      return info
    }
  }
  return undefined
}

function createSkillImprovementHook() {
  let lastAnalyzedCount = 0
  let lastAnalyzedIndex = 0

  const config: ApiQueryHookConfig<SkillUpdate[]> = {
    name: 'skill_improvement',

    async shouldRun(context) {
      if (context.querySource !== 'repl_main_thread') {
        return false
      }

      if (!findProjectSkill()) {
        return false
      }

      // Only run every TURN_BATCH_SIZE user messages
      const userCount = count(context.messages, m => m.type === 'user')
      if (userCount - lastAnalyzedCount < TURN_BATCH_SIZE) {
        return false
      }

      lastAnalyzedCount = userCount
      return true
    },

    buildMessages(context) {
      const projectSkill = findProjectSkill()!
      // Only analyze messages since the last check — the skill definition
      // provides enough context for the classifier to understand corrections
      const newMessages = context.messages.slice(lastAnalyzedIndex)
      lastAnalyzedIndex = context.messages.length

      return [
        createUserMessage({
          content: `You are analyzing a conversation where a user is executing a skill (a repeatable process).
Your job: identify if the user's recent messages contain preferences, requests, or corrections that should be permanently added to the skill definition for future runs.

<skill_definition>
${projectSkill.content}
</skill_definition>

<recent_messages>
${formatRecentMessages(newMessages)}
</recent_messages>

Look for:
- Requests to add, change, or remove steps: "can you also ask me X", "please do Y too", "don't do Z"
- Preferences about how steps should work: "ask me about energy levels", "note the time", "use a casual tone"
- Corrections: "no, do X instead", "always use Y", "make sure to..."

Ignore:
- Routine conversation that doesn't generalize (one-time answers, chitchat)
- Things the skill already does

Output a JSON array inside <updates> tags. Each item: {"section": "which step/section to modify or 'new step'", "change": "what to add/modify", "reason": "which user message prompted this"}.
Output <updates>[]</updates> if no updates are needed.`,
        }),
      ]
    },

    systemPrompt:
      'You detect user preferences and process improvements during skill execution. Flag anything the user asks for that should be remembered for next time.',

    useTools: false,

    parseResponse(content) {
      const updatesStr = extractTag(content, 'updates')
      if (!updatesStr) {
        return []
      }
      try {
        return jsonParse(updatesStr) as SkillUpdate[]
      } catch {
        return []
      }
    },

    logResult(result, context) {
      if (result.type === 'success' && result.result.length > 0) {
        const projectSkill = findProjectSkill()
        const skillName = projectSkill?.skillName ?? 'unknown'

        logEvent('tengu_skill_improvement_detected', {
          updateCount: result.result
            .length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          uuid: result.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          // _PROTO_skill_name routes to the privileged skill_name BQ column.
          _PROTO_skill_name:
            skillName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        })

        context.toolUseContext.setAppState(prev => ({
          ...prev,
          skillImprovement: {
            suggestion: { skillName, updates: result.result },
          },
        }))
      }
    },

    getModel: getSmallFastModel,
  }

  return createApiQueryHook(config)
}

export function initSkillImprovement(): void {
  const runtimeConfig = getMemoryV2SkillRuntimeConfig()
  if (runtimeConfig.gateResolution?.AUTO_SKILL_GENERATION.requested && !runtimeConfig.gateResolution.AUTO_SKILL_GENERATION.effective) {
    return
  }
  if (
    feature('SKILL_IMPROVEMENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_copper_panda', false)
  ) {
    registerPostSamplingHook(createSkillImprovementHook())
  }
}

/**
 * Apply skill improvements by calling a side-channel LLM to rewrite the skill file.
 * Fire-and-forget — does not block the main conversation.
 */
export async function applySkillImprovement(
  skillName: string,
  updates: SkillUpdate[],
  memoryV2Gates: FeatureGateRequest = {},
  generatedSkillOptions: GeneratedSkillStoreOptions = {},
): Promise<void> {
  if (!skillName) return

  const { join } = await import('path')
  const fs = await import('fs/promises')
  const runtimeConfig = getMemoryV2SkillRuntimeConfig()
  const effectiveGates = Object.keys(memoryV2Gates).length > 0 ? memoryV2Gates : runtimeConfig.gates
  const effectiveOptions = Object.keys(generatedSkillOptions).length > 0
    ? generatedSkillOptions
    : runtimeConfig.generatedSkillOptions ?? {}
  const v2StoreEnabled = runtimeConfig.gateResolution && Object.keys(memoryV2Gates).length === 0
    ? runtimeConfig.gateResolution.SKILL_STORE_V2.effective
    : isFeatureGateEnabled('SKILL_STORE_V2', effectiveGates)
  const v2GenerationEnabled = runtimeConfig.gateResolution && Object.keys(memoryV2Gates).length === 0
    ? runtimeConfig.gateResolution.AUTO_SKILL_GENERATION.effective
    : isFeatureGateEnabled('AUTO_SKILL_GENERATION', effectiveGates)
  if (runtimeConfig.gateResolution && Object.keys(memoryV2Gates).length === 0 && runtimeConfig.gateResolution.AUTO_SKILL_GENERATION.requested && !v2GenerationEnabled) {
    throw new Error(`AUTO_SKILL_GENERATION unavailable: blockedBy=${runtimeConfig.gateResolution.AUTO_SKILL_GENERATION.blockedBy.join(',')}`)
  }
  if (v2StoreEnabled && !v2GenerationEnabled) return

  const generatedSkillRoot = join(getCwd(), '.claude', 'skills')
  let effectiveGeneratedSkillOptions = effectiveOptions
  if (v2GenerationEnabled && (!effectiveOptions.attestationKey || !isVerifiedGeneratedSkillMutationCapability(effectiveOptions.mutationCapability))) {
    const resolution = resolveGeneratedSkillStoreOptions(
      generatedSkillRoot,
      `skill-improvement:${randomUUID()}`,
      undefined,
      effectiveOptions.mutationCapability,
    )
    if (!resolution.available) throw new Error(`AUTO_SKILL_GENERATION unavailable: ${resolution.reason}`)
    effectiveGeneratedSkillOptions = { ...resolution.options, ...generatedSkillOptions }
  }

  // Skills live at .claude/skills/<name>/SKILL.md relative to CWD
  const filePath = join(getCwd(), '.claude', 'skills', skillName, 'SKILL.md')

  let currentContent: string
  try {
    currentContent = await fs.readFile(filePath, 'utf-8')
  } catch {
    if (v2StoreEnabled) throw new Error(`Failed to read skill file for improvement: ${filePath}`)
    logError(
      new Error(`Failed to read skill file for improvement: ${filePath}`),
    )
    return
  }

  const updateList = updates.map(u => `- ${u.section}: ${u.change}`).join('\n')
  const remotePayload = v2StoreEnabled
    ? sanitizeReviewerPayload({ current_skill_file: currentContent, improvements: updateList })
    : undefined
  const remoteFields = remotePayload?.sanitized as { current_skill_file: string; improvements: string } | undefined
  const remoteCurrentContent = remoteFields?.current_skill_file ?? currentContent
  const remoteUpdateList = remoteFields?.improvements ?? updateList

  const response = await queryModelWithoutStreaming({
    messages: [
      createUserMessage({
        content: `You are editing a skill definition file. Apply the following improvements to the skill.

<current_skill_file>
${remoteCurrentContent}
</current_skill_file>

<improvements>
${remoteUpdateList}
</improvements>

Rules:
- ${v2StoreEnabled ? REVIEWER_PLACEHOLDER_INSTRUCTIONS : 'Preserve the source content faithfully'}
- Integrate the improvements naturally into the existing structure
- Preserve frontmatter (--- block) exactly as-is
- Preserve the overall format and style
- Do not remove existing content unless an improvement explicitly replaces it
- Output the complete updated file inside <updated_file> tags`,
      }),
    ],
    systemPrompt: asSystemPrompt([
      'You edit skill definition files to incorporate user preferences. Output only the updated file content.',
    ]),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: createAbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: getSmallFastModel(),
      toolChoice: undefined,
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      temperatureOverride: 0,
      agents: [],
      querySource: 'skill_improvement_apply',
      mcpTools: [],
    },
  })

  const responseText = extractTextContent(response.message.content).trim()

  const updatedContent = extractTag(responseText, 'updated_file')
  if (!updatedContent) {
    if (v2StoreEnabled) throw new Error('Skill improvement apply: no updated_file tag in response')
    logError(
      new Error('Skill improvement apply: no updated_file tag in response'),
    )
    return
  }

  if (v2StoreEnabled) {
    try {
      validateReviewerOutput(remotePayload!, updatedContent)
    } catch (error) {
      throw toError(error)
    }
  }

  try {
    if (v2GenerationEnabled) {
      const generatedName = skillName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 128) || 'generated-skill'
      const store = new GeneratedSkillStore(generatedSkillRoot, effectiveGates, effectiveGeneratedSkillOptions)
      try {
        await store.read(generatedName)
        await store.mutate(generatedName, updatedContent)
      } catch (error) {
        if (!(error instanceof GeneratedSkillNotFoundError)) throw error
        await store.create({ name: generatedName, content: updatedContent, evidence: [skillName] })
      }
    } else {
      await fs.writeFile(filePath, updatedContent, 'utf-8')
    }
  } catch (e) {
    if (v2StoreEnabled) throw e
    logError(toError(e))
  }
}
