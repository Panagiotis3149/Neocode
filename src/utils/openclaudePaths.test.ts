import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import * as fsPromises from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { acquireEnvMutex, releaseEnvMutex } from '../entrypoints/sdk/shared.js'

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]

async function importFreshEnvUtils() {
  return import(`./envUtils.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshSettings() {
  return import(`./settings/settings.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshLocalInstaller() {
  return import(`./localInstaller.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshPlans() {
  return import(`./plans.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  try {
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
    mock.restore()
  } finally {
    releaseEnvMutex()
  }
})

describe('Neocode paths', () => {
  test('defaults user config home to ~/.neocode', async () => {
    await acquireEnvMutex()
    delete process.env.CLAUDE_CONFIG_DIR
    const { resolveClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveClaudeConfigHomeDir({
        homeDir: homedir(),
      }),
    ).toBe(join(homedir(), '.neocode'))
  })

  test('hard-cuts user config home to ~/.neocode by default', async () => {
    await acquireEnvMutex()
    delete process.env.CLAUDE_CONFIG_DIR
    const { resolveClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveClaudeConfigHomeDir({
        homeDir: homedir(),
      }),
    ).toBe(join(homedir(), '.neocode'))
  })

  test('migrates legacy config home and global config files to .neocode', async () => {
    await acquireEnvMutex()
    const tempHome = mkdtempSync(join(tmpdir(), 'neocode-paths-test-'))
    try {
      mkdirSync(join(tempHome, '.claude', 'skills', 'legacy-skill'), {
        recursive: true,
      })
      writeFileSync(
        join(tempHome, '.claude', 'skills', 'legacy-skill', 'SKILL.md'),
        'legacy skill',
      )
      writeFileSync(join(tempHome, '.claude', 'settings.json'), '{}')
      writeFileSync(join(tempHome, '.claude.json'), '{"legacy":true}')
      writeFileSync(
        join(tempHome, '.claude-custom-oauth.json'),
        '{"custom":true}',
      )

      const { migrateLegacyClaudeConfigHome } = await importFreshEnvUtils()

      expect(migrateLegacyClaudeConfigHome({ homeDir: tempHome })).toBe(true)
      expect(
        readFileSync(
          join(tempHome, '.neocode', 'skills', 'legacy-skill', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('legacy skill')
      expect(existsSync(join(tempHome, '.neocode', 'settings.json'))).toBe(
        true,
      )
      expect(readFileSync(join(tempHome, '.neocode.json'), 'utf8')).toBe(
        '{"legacy":true}',
      )
      expect(
        readFileSync(join(tempHome, '.neocode-custom-oauth.json'), 'utf8'),
      ).toBe('{"custom":true}')
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('migration preserves existing .neocode data while copying missing legacy data', async () => {
    await acquireEnvMutex()
    const tempHome = mkdtempSync(join(tmpdir(), 'neocode-paths-test-'))
    try {
      mkdirSync(join(tempHome, '.claude', 'skills', 'legacy-skill'), {
        recursive: true,
      })
      mkdirSync(join(tempHome, '.neocode', 'skills'), { recursive: true })
      writeFileSync(join(tempHome, '.claude', 'settings.json'), 'legacy')
      writeFileSync(join(tempHome, '.neocode', 'settings.json'), 'current')
      writeFileSync(
        join(tempHome, '.claude', 'skills', 'legacy-skill', 'SKILL.md'),
        'legacy skill',
      )

      const { migrateLegacyClaudeConfigHome } = await importFreshEnvUtils()

      expect(migrateLegacyClaudeConfigHome({ homeDir: tempHome })).toBe(true)
      expect(
        readFileSync(join(tempHome, '.neocode', 'settings.json'), 'utf8'),
      ).toBe('current')
      expect(
        readFileSync(
          join(tempHome, '.neocode', 'skills', 'legacy-skill', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('legacy skill')
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('migration skips explicit CLAUDE_CONFIG_DIR overrides', async () => {
    await acquireEnvMutex()
    const tempHome = mkdtempSync(join(tmpdir(), 'neocode-paths-test-'))
    try {
      mkdirSync(join(tempHome, '.claude'), { recursive: true })
      writeFileSync(join(tempHome, '.claude', 'settings.json'), 'legacy')

      const { migrateLegacyClaudeConfigHome } = await importFreshEnvUtils()

      expect(
        migrateLegacyClaudeConfigHome({
          configDirEnv: join(tempHome, 'custom-config'),
          homeDir: tempHome,
        }),
      ).toBe(true)
      expect(existsSync(join(tempHome, '.neocode'))).toBe(false)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('migration fails closed when .neocode collides with a non-directory', async () => {
    await acquireEnvMutex()
    const tempHome = mkdtempSync(join(tmpdir(), 'neocode-paths-test-'))
    try {
      writeFileSync(join(tempHome, '.neocode'), 'not a directory')
      mkdirSync(join(tempHome, '.claude'), { recursive: true })
      writeFileSync(join(tempHome, '.claude', 'settings.json'), 'legacy')

      const { migrateLegacyClaudeConfigHome } = await importFreshEnvUtils()

      expect(migrateLegacyClaudeConfigHome({ homeDir: tempHome })).toBe(false)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('migration ignores non-directory legacy config homes', async () => {
    await acquireEnvMutex()
    const tempHome = mkdtempSync(join(tmpdir(), 'neocode-paths-test-'))
    try {
      writeFileSync(join(tempHome, '.claude'), 'not a directory')

      const { migrateLegacyClaudeConfigHome } = await importFreshEnvUtils()

      expect(migrateLegacyClaudeConfigHome({ homeDir: tempHome })).toBe(true)
      expect(existsSync(join(tempHome, '.neocode'))).toBe(false)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('config home falls back to legacy when migration fails on a non-directory .neocode collision', async () => {
    await acquireEnvMutex()
    const tempHome = mkdtempSync(join(tmpdir(), 'neocode-paths-test-'))
    try {
      writeFileSync(join(tempHome, '.neocode'), 'not a directory')
      mkdirSync(join(tempHome, '.claude'), { recursive: true })
      mock.module('os', () => ({
        homedir: () => tempHome,
        tmpdir,
      }))
      delete process.env.CLAUDE_CONFIG_DIR

      const { getClaudeConfigHomeDir } = await importFreshEnvUtils()

      expect(getClaudeConfigHomeDir()).toBe(join(tempHome, '.claude'))
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('default plans directory uses ~/.neocode/plans', async () => {
    await acquireEnvMutex()
    delete process.env.CLAUDE_CONFIG_DIR
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(getDefaultPlansDirectory({ homeDir: homedir() })).toBe(
      join(homedir(), '.neocode', 'plans'),
    )
  })

  test('default plans directory respects explicit CLAUDE_CONFIG_DIR', async () => {
    await acquireEnvMutex()
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(
      getDefaultPlansDirectory({ configDirEnv: '/tmp/custom-neocode' }),
    ).toBe(join('/tmp/custom-neocode', 'plans'))
  })

  test('default plans directory normalizes generated path to NFC', async () => {
    await acquireEnvMutex()
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(
      getDefaultPlansDirectory({ homeDir: '/tmp/cafe\u0301' }),
    ).toBe(join('/tmp/caf\u00e9', '.neocode', 'plans'))
  })

  test('default plans directory normalizes explicit CLAUDE_CONFIG_DIR to NFC', async () => {
    await acquireEnvMutex()
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(
      getDefaultPlansDirectory({ configDirEnv: '/tmp/cafe\u0301-neocode' }),
    ).toBe(join('/tmp/caf\u00e9-neocode', 'plans'))
  })

  test('uses CLAUDE_CONFIG_DIR override when provided', async () => {
    await acquireEnvMutex()
    process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-neocode'
    const { getClaudeConfigHomeDir, resolveClaudeConfigHomeDir } =
      await importFreshEnvUtils()

    expect(getClaudeConfigHomeDir()).toBe('/tmp/custom-neocode')
    expect(
      resolveClaudeConfigHomeDir({
        configDirEnv: '/tmp/custom-neocode',
      }),
    ).toBe('/tmp/custom-neocode')
  })

  test('project and local settings paths use .neocode', async () => {
    await acquireEnvMutex()
    const { getRelativeSettingsFilePathForSource } = await importFreshSettings()

    expect(getRelativeSettingsFilePathForSource('projectSettings')).toBe(
      '.neocode/settings.json',
    )
    expect(getRelativeSettingsFilePathForSource('localSettings')).toBe(
      '.neocode/settings.local.json',
    )
  })

  test('local installer uses neocode wrapper path', async () => {
    await acquireEnvMutex()
    // Force .neocode config home so the test doesn't fall back to
    // ~/.claude when ~/.neocode doesn't exist on this machine.
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.neocode')
    const { getLocalClaudePath } = await importFreshLocalInstaller()

    expect(getLocalClaudePath()).toBe(
      join(homedir(), '.neocode', 'local', 'neocode'),
    )
  })

  test('local installation detection matches .neocode path', async () => {
    await acquireEnvMutex()
    const { isManagedLocalInstallationPath } =
      await importFreshLocalInstaller()

    expect(
      isManagedLocalInstallationPath(
        `${join(homedir(), '.neocode', 'local')}/node_modules/.bin/neocode`,
      ),
    ).toBe(true)
  })

  test('local installation detection still matches legacy .claude path', async () => {
    await acquireEnvMutex()
    const { isManagedLocalInstallationPath } =
      await importFreshLocalInstaller()

    expect(
      isManagedLocalInstallationPath(
        `${join(homedir(), '.claude', 'local')}/node_modules/.bin/neocode`,
      ),
    ).toBe(true)
  })

  test('candidate local install dirs include both neocode and legacy claude paths', async () => {
    await acquireEnvMutex()
    const { getCandidateLocalInstallDirs } = await importFreshLocalInstaller()

    expect(
      getCandidateLocalInstallDirs({
        configHomeDir: join(homedir(), '.neocode'),
        homeDir: homedir(),
      }),
    ).toEqual([
      join(homedir(), '.neocode', 'local'),
      join(homedir(), '.claude', 'local'),
    ])
  })

  test('legacy local installs are detected when they still expose the claude binary', async () => {
    await acquireEnvMutex()
    mock.module('fs/promises', () => ({
      ...fsPromises,
      access: async (path: string) => {
        if (
          path === join(homedir(), '.claude', 'local', 'node_modules', '.bin', 'claude')
        ) {
          return
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    }))

    const { getDetectedLocalInstallDir, localInstallationExists } =
      await importFreshLocalInstaller()

    expect(await localInstallationExists()).toBe(true)
    expect(await getDetectedLocalInstallDir()).toBe(
      join(homedir(), '.claude', 'local'),
    )
  })
})
