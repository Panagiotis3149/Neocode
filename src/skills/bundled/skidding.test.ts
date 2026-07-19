import { afterEach, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerSkidSkill } from './skidding.js'

afterEach(() => {
  clearBundledSkills()
})

test('skid skill is registered with both command names', async () => {
  registerSkidSkill()

  const skill = getBundledSkills().find(command => command.name === 'skid')
  expect(skill).toBeDefined()
  expect(skill?.type).toBe('prompt')
  expect(skill?.aliases).toContain('skidding')
})

test('skid skill has a meaningful description', async () => {
  registerSkidSkill()

  const skill = getBundledSkills().find(command => command.name === 'skid')
  expect(skill?.description).toBeTruthy()
  expect(skill?.description?.toLowerCase()).toContain('implementation')
})

test('skid prompt contains the core workflow terms', async () => {
  registerSkidSkill()

  const skill = getBundledSkills().find(command => command.name === 'skid')
  const blocks = await skill!.getPromptForCommand('', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('WebFetch')
  expect(text).toContain('adapt')
  expect(text).toContain('build')
  expect(text).toContain('wonderland.ac')
  expect(text).toContain('behaviorally equivalent')
})
