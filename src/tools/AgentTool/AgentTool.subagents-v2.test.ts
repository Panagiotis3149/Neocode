import { describe, expect, test } from 'bun:test'
import { inputSchema } from './AgentTool.js'

const baseInput = {
  description: 'Inspect the repository',
  prompt: 'Find the authentication flow',
  subagent_type: 'general-purpose',
}

describe('AgentTool Subagents V2 input', () => {
  test('accepts V2 identity, model, verbosity, mode, and benchmark fields', () => {
    const result = inputSchema().safeParse({
      ...baseInput,
      subagent_name: 'researcher',
      model_overrides: {
        model: 'gpt-5.5',
        provider: 'local-profile',
        temperature: 0.2,
        reasoning_effort: 'high',
      },
      verbosity: 'outputs_and_calls',
      mode: 'async',
      lookup_benchmarks: true,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subagent_name).toBe('researcher')
      expect(result.data.model_overrides?.reasoning_effort).toBe('high')
      expect(result.data.mode).toBe('async')
    }
  })

  test('keeps the existing team permission mode values valid', () => {
    expect(
      inputSchema().safeParse({ ...baseInput, mode: 'plan' }).success,
    ).toBe(true)
  })
})
