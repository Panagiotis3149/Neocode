import { describe, expect, test, mock } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { isAutoAcceptBlockedPath, isAutoNewSeededReadPath } from './readAutoAcceptGuard.js'

mock.module('../../settings/settings.js', () => ({
  getSettingsFilePathForSource: () => null,
  SETTING_SOURCES: ['local', 'user', 'global', 'env', 'cli']
}))

mock.module('../cwd.js', () => ({
  getCwd: () => '/home/user/project',
  getOriginalCwd: () => '/home/user/project'
}))

function setPlatform(platform: string) {
  mock.module('../platform.js', () => ({
    getPlatform: () => platform
  }))
}

function runPosixSuite(platform: string) {
  describe(platform, () => {
    test('allows normal project files', () => {
      setPlatform(platform)
      expect(isAutoAcceptBlockedPath('/home/user/project/src/index.ts')).toBe(false)
      expect(isAutoAcceptBlockedPath('/home/user/project/package.json')).toBe(false)
      expect(isAutoAcceptBlockedPath('/home/user/project/README.md')).toBe(false)
    })

    test('blocks sensitive filenames', () => {
      setPlatform(platform)
      expect(isAutoAcceptBlockedPath('/home/user/project/.env')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/.env.local')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/.env.production')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/secrets.key')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/credentials.json')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/token.json')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/app.secret')).toBe(true)
    })

    test('blocks sensitive file extensions', () => {
      setPlatform(platform)
      expect(isAutoAcceptBlockedPath('/home/user/project/cert.pem')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/key.key')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/auth.p12')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/project/build.pfx')).toBe(true)
    })

    test('blocks ssh related files', () => {
      setPlatform(platform)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/id_rsa')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/id_ed25519')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/id_ecdsa')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/id_rsa.bak')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/known_hosts')).toBe(true)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/authorized_keys')).toBe(true)
    })

    test('blocks posix system directories', () => {
      setPlatform(platform)
      expect(isAutoAcceptBlockedPath('/usr/bin/bash')).toBe(true)
      expect(isAutoAcceptBlockedPath('/etc/hosts')).toBe(true)
      expect(isAutoAcceptBlockedPath('/proc/version')).toBe(true)
      expect(isAutoAcceptBlockedPath('/dev/null')).toBe(true)
      expect(isAutoAcceptBlockedPath('/run/secrets/token')).toBe(true)
    })

    test('does not treat windows roots as blocked on posix', () => {
      setPlatform(platform)
      expect(isAutoAcceptBlockedPath('C:\\Windows\\System32\\cmd.exe')).toBe(false)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\id_rsa')).toBe(false)
    })
  })
}

function runWindowsSuite() {
  describe('windows', () => {
    test('allows normal project files', () => {
      setPlatform('windows')
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\src\\index.ts')).toBe(false)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\package.json')).toBe(false)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\README.md')).toBe(false)
    })

    test('blocks sensitive filenames', () => {
      setPlatform('windows')
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\.env')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\.env.local')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\.env.production')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\secrets.key')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\credentials.json')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\token.json')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\app.secret')).toBe(true)
    })

    test('blocks sensitive file extensions', () => {
      setPlatform('windows')
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\cert.pem')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\key.key')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\auth.p12')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\project\\build.pfx')).toBe(true)
    })

    test('blocks ssh related files', () => {
      setPlatform('windows')
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\id_rsa')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\id_ed25519')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\id_ecdsa')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\id_rsa.bak')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\known_hosts')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Users\\user\\.ssh\\authorized_keys')).toBe(true)
    })

    test('blocks windows system directories', () => {
      setPlatform('windows')
      expect(isAutoAcceptBlockedPath('C:\\Windows\\System32\\cmd.exe')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\ProgramData\\file.txt')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Program Files\\app\\run.exe')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\Program Files (x86)\\app\\run.exe')).toBe(true)
      expect(isAutoAcceptBlockedPath('C:\\$Recycle.Bin\\stuff.txt')).toBe(true)
    })

    test('does not treat posix roots as blocked on windows', () => {
      setPlatform('windows')
      expect(isAutoAcceptBlockedPath('/usr/bin/bash')).toBe(false)
      expect(isAutoAcceptBlockedPath('/etc/hosts')).toBe(false)
      expect(isAutoAcceptBlockedPath('/proc/version')).toBe(false)
      expect(isAutoAcceptBlockedPath('/home/user/.ssh/id_rsa')).toBe(false)
    })
  })
}

runPosixSuite('linux')
runPosixSuite('darwin')
runWindowsSuite();

describe('isAutoNewSeededReadPath', () => {
  const cwd = '/home/user/project'

  test('allows the workspace temp/ directory and its descendants', () => {
    expect(isAutoNewSeededReadPath(`${cwd}/temp`, cwd)).toBe(true)
    expect(isAutoNewSeededReadPath(`${cwd}/temp/foo.txt`, cwd)).toBe(true)
    expect(isAutoNewSeededReadPath(`${cwd}/temp/sub/dir/x`, cwd)).toBe(true)
  })

  test('allows the workspace .claude directory and its descendants', () => {
    expect(isAutoNewSeededReadPath(`${cwd}/.claude`, cwd)).toBe(true)
    expect(isAutoNewSeededReadPath(`${cwd}/.claude/settings.json`, cwd)).toBe(true)
  })

  test('does NOT blanket-allow sibling or arbitrary paths', () => {
    expect(isAutoNewSeededReadPath(`${cwd}/src/index.ts`, cwd)).toBe(false)
    expect(isAutoNewSeededReadPath(`${cwd}/.env`, cwd)).toBe(false)
    expect(isAutoNewSeededReadPath(`/home/user/.ssh/id_rsa`, cwd)).toBe(false)
    expect(isAutoNewSeededReadPath(`/usr/bin/bash`, cwd)).toBe(false)
    expect(isAutoNewSeededReadPath(`C:\\Windows\\System32`, cwd)).toBe(false)
    // A temp dir NOT under the cwd must NOT be seeded.
    expect(isAutoNewSeededReadPath(`/other/temp`, cwd)).toBe(false)
  })

  test('windows separators work', () => {
    const wCwd = 'C:\\Users\\user\\project'
    expect(isAutoNewSeededReadPath(`${wCwd}\\temp`, wCwd)).toBe(true)
    expect(isAutoNewSeededReadPath(`${wCwd}\\.claude\\x`, wCwd)).toBe(true)
    expect(isAutoNewSeededReadPath(`${wCwd}\\src\\x`, wCwd)).toBe(false)
  })

  test('allows the OS / AppData temp directory and its descendants', () => {
    // AppData temp (windows) or /tmp (posix) — the scratch location autoNew may read.
    const tempRoot = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Temp')
      : process.env.TEMP || process.env.TMP || (process.env.TMPDIR || '/tmp')
    const normed = tempRoot.replace(/[\\/]+$/, '')
    expect(isAutoNewSeededReadPath(normed, cwd)).toBe(true)
    expect(isAutoNewSeededReadPath(join(normed, 'scratch.log'), cwd)).toBe(true)
    expect(isAutoNewSeededReadPath(join(normed, 'sub', 'nested', 'out.txt'), cwd)).toBe(true)
    // A sibling under AppData (not the Temp subdir) is still NOT seeded.
    const appData = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Other')
      : join(homedir(), '.cache', 'other')
    expect(isAutoNewSeededReadPath(appData, cwd)).toBe(false)
  })
})