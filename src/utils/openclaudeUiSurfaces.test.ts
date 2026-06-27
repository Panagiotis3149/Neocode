import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

import { isInGlobalClaudeFolder } from '../components/permissions/FilePermissionDialog/permissionOptions.tsx'
import { optionForPermissionSaveDestination } from '../components/permissions/rules/AddPermissionRules.tsx'
import { getDefaultPermissionModeOptions } from './permissions/defaultPermissionModeOptions.ts'
import {
  getClaudeSkillScope,
  isClaudeSettingsPath,
} from './permissions/filesystem.ts'
import { getValidationTip } from './settings/validationTips.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  await acquireSharedMutationLock('neocodeUiSurfaces.test.ts')
})

afterEach(() => {
  try {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('Neocode settings path surfaces', () => {
  test('isClaudeSettingsPath recognizes project .neocode settings files', () => {
    expect(
      isClaudeSettingsPath(
        join(process.cwd(), '.neocode', 'settings.json'),
      ),
    ).toBe(true)

    expect(
      isClaudeSettingsPath(
        join(process.cwd(), '.neocode', 'settings.local.json'),
      ),
    ).toBe(true)
  })

  test('permission save destinations point user settings to ~/.neocode', () => {
    expect(optionForPermissionSaveDestination('userSettings')).toEqual({
      label: 'User settings',
      description: 'Saved in ~/.neocode/settings.json',
      value: 'userSettings',
    })
  })

  test('permission save destinations point project settings to .neocode', () => {
    expect(optionForPermissionSaveDestination('projectSettings')).toEqual({
      label: 'Project settings',
      description: 'Checked in at .neocode/settings.json',
      value: 'projectSettings',
    })

    expect(optionForPermissionSaveDestination('localSettings')).toEqual({
      label: 'Project settings (local)',
      description: 'Saved in .neocode/settings.local.json',
      value: 'localSettings',
    })
  })

  test('permission dialog treats ~/.neocode as the global Claude folder', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.neocode')

    expect(
      isInGlobalClaudeFolder(
        join(homedir(), '.neocode', 'settings.json'),
      ),
    ).toBe(true)
    expect(
      isInGlobalClaudeFolder(join(homedir(), '.claude', 'settings.json')),
    ).toBe(true)
  })

  test('permission dialog does not treat arbitrary CLAUDE_CONFIG_DIR as the global Claude folder', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), 'custom-neocode')

    expect(
      isInGlobalClaudeFolder(
        join(homedir(), 'custom-neocode', 'settings.json'),
      ),
    ).toBe(false)
  })

  test('global skill scope recognizes ~/.neocode and legacy ~/.claude skills', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.neocode')

    expect(
      getClaudeSkillScope(
        join(homedir(), '.neocode', 'skills', 'demo', 'SKILL.md'),
      ),
    ).toEqual({
      skillName: 'demo',
      pattern: '~/.neocode/skills/demo/**',
    })

    expect(
      getClaudeSkillScope(
        join(homedir(), '.claude', 'skills', 'legacy', 'SKILL.md'),
      ),
    ).toEqual({
      skillName: 'legacy',
      pattern: '~/.claude/skills/legacy/**',
    })
  })

  test('global skill scope does not emit fixed rules for arbitrary CLAUDE_CONFIG_DIR skills', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), 'custom-neocode')

    expect(
      getClaudeSkillScope(
        join(homedir(), 'custom-neocode', 'skills', 'demo', 'SKILL.md'),
      ),
    ).toBe(null)
  })
})

describe('Neocode validation tips', () => {
  test('permissions.defaultMode invalid value keeps suggestion but no Claude docs link', () => {
    const tip = getValidationTip({
      path: 'permissions.defaultMode',
      code: 'invalid_value',
      enumValues: [
        'acceptEdits',
        'bypassPermissions',
        'default',
        'dontAsk',
        'fullAccess',
        'plan',
      ],
    })

    expect(tip).toEqual({
      suggestion:
        'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only), "bypassPermissions" (auto-accept prompts), "fullAccess" (skip even hard safety-check prompts), or "default" (standard behavior)',
    })
  })
})

describe('Neocode permission mode surfaces', () => {
  test('default permission mode picker excludes dangerous persisted modes', () => {
    const options = getDefaultPermissionModeOptions(true)

    expect(options).not.toContain('bypassPermissions')
    expect(options).not.toContain('fullAccess')
  })
})
