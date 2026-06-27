import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const originalSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const hadOriginalMacro = Object.hasOwn(globalThis, 'MACRO')

let clearSystemPromptSections: typeof import('./systemPromptSections.js').clearSystemPromptSections
let getSystemPrompt: typeof import('./prompts.js').getSystemPrompt
let DEFAULT_AGENT_PROMPT: typeof import('./prompts.js').DEFAULT_AGENT_PROMPT
let CLI_SYSPROMPT_PREFIXES: typeof import('./system.js').CLI_SYSPROMPT_PREFIXES
let getCLISyspromptPrefix: typeof import('./system.js').getCLISyspromptPrefix
let CLAUDE_CODE_GUIDE_AGENT:
  typeof import('../tools/AgentTool/built-in/neocodeGuideAgent.js').CLAUDE_CODE_GUIDE_AGENT
let GENERAL_PURPOSE_AGENT:
  typeof import('../tools/AgentTool/built-in/generalPurposeAgent.js').GENERAL_PURPOSE_AGENT
let EXPLORE_AGENT:
  typeof import('../tools/AgentTool/built-in/exploreAgent.js').EXPLORE_AGENT
let PLAN_AGENT: typeof import('../tools/AgentTool/built-in/planAgent.js').PLAN_AGENT
let STATUSLINE_SETUP_AGENT:
  typeof import('../tools/AgentTool/built-in/statuslineSetup.js').STATUSLINE_SETUP_AGENT

beforeAll(async () => {
  await acquireSharedMutationLock('constants/promptIdentity.test.ts')

  // MACRO is replaced at build time by Bun.define but not in test mode.
  // Define it globally under the shared lock before importing modules that use it.
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: new Date().toISOString(),
    ISSUES_EXPLAINER:
      'report the issue at https://github.com/Panagiotis3149/neocode/issues',
    PACKAGE_URL: '@Panagiotis3149/neocode',
    NATIVE_PACKAGE_URL: undefined,
  }

  ;({ clearSystemPromptSections } = await import('./systemPromptSections.js'))
  ;({ getSystemPrompt, DEFAULT_AGENT_PROMPT } = await import('./prompts.js'))
  ;({ CLI_SYSPROMPT_PREFIXES, getCLISyspromptPrefix } = await import('./system.js'))
  ;({ CLAUDE_CODE_GUIDE_AGENT } = await import(
    '../tools/AgentTool/built-in/neocodeGuideAgent.js'
  ))
  ;({ GENERAL_PURPOSE_AGENT } = await import(
    '../tools/AgentTool/built-in/generalPurposeAgent.js'
  ))
  ;({ EXPLORE_AGENT } = await import(
    '../tools/AgentTool/built-in/exploreAgent.js'
  ))
  ;({ PLAN_AGENT } = await import('../tools/AgentTool/built-in/planAgent.js'))
  ;({ STATUSLINE_SETUP_AGENT } = await import(
    '../tools/AgentTool/built-in/statuslineSetup.js'
  ))
})

afterAll(() => {
  try {
    if (hadOriginalMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
  } finally {
    releaseSharedMutationLock()
  }
})

afterEach(() => {
  if (originalSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
  }
  clearSystemPromptSections()
})

test('CLI identity prefixes describe Neocode instead of Neocode', () => {
  expect(getCLISyspromptPrefix()).toContain('Neocode')
  expect(getCLISyspromptPrefix()).not.toContain('Neocode')
  expect(getCLISyspromptPrefix()).not.toContain("Anthropic's official CLI for Claude")

  for (const prefix of CLI_SYSPROMPT_PREFIXES) {
    expect(prefix).toContain('Neocode')
    expect(prefix).not.toContain('Neocode')
    expect(prefix).not.toContain("Anthropic's official CLI for Claude")
  }
})

test('simple mode identity describes Neocode instead of Neocode', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'

  const prompt = await getSystemPrompt([], 'gpt-4o')

  expect(prompt[0]).toContain('Neocode')
  expect(prompt[0]).not.toContain('Neocode')
  expect(prompt[0]).not.toContain("Anthropic's official CLI for Claude")
})

test('system prompt model identity updates when model changes mid-session', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  const firstPrompt = await getSystemPrompt([], 'old-test-model')
  const secondPrompt = await getSystemPrompt([], 'new-test-model')

  const firstText = firstPrompt.join('\n')
  const secondText = secondPrompt.join('\n')

  expect(firstText).toContain('You are powered by the model old-test-model.')
  expect(secondText).toContain('You are powered by the model new-test-model.')
  expect(secondText).not.toContain('You are powered by the model old-test-model.')
})

test('built-in agent prompts describe Neocode instead of Neocode', () => {
  expect(DEFAULT_AGENT_PROMPT).toContain('Neocode')
  expect(DEFAULT_AGENT_PROMPT).not.toContain('Neocode')
  expect(DEFAULT_AGENT_PROMPT).not.toContain("Anthropic's official CLI for Claude")

  const generalPrompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(generalPrompt).toContain('Neocode')
  expect(generalPrompt).not.toContain('Neocode')
  expect(generalPrompt).not.toContain("Anthropic's official CLI for Claude")

  const explorePrompt = EXPLORE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(explorePrompt).toContain('Neocode')
  expect(explorePrompt).not.toContain('Neocode')
  expect(explorePrompt).not.toContain("Anthropic's official CLI for Claude")

  const planPrompt = PLAN_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(planPrompt).toContain('Neocode')
  expect(planPrompt).not.toContain('Neocode')

  const statuslinePrompt = STATUSLINE_SETUP_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(statuslinePrompt).toContain('Neocode')
  expect(statuslinePrompt).not.toContain('Neocode')

  const guidePrompt = CLAUDE_CODE_GUIDE_AGENT.getSystemPrompt({
    toolUseContext: {
      options: {
        commands: [],
        agentDefinitions: { activeAgents: [] },
        mcpClients: [],
      } as never,
    },
  })
  expect(guidePrompt).toContain('Neocode')
  expect(guidePrompt).toContain('You are the Neocode guide agent.')
  expect(guidePrompt).toContain('**Neocode** (the CLI tool)')
  expect(guidePrompt).not.toContain('You are the Claude guide agent.')
  expect(guidePrompt).not.toContain('**Neocode** (the CLI tool)')
})
