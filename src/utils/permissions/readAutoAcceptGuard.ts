import { homedir } from 'os'
import { join } from 'path'
import { getCwd, getOriginalCwd } from '../cwd.ts'
import { getPlatform } from '../platform.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { SETTING_SOURCES } from '../settings/constants.js'

const SENSITIVE_FILENAME_PATTERNS = [
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /\.secret$/i,
  /credentials\.json$/i,
  /credentials\.xml$/i,
  /token\.json$/i,
  /htpasswd$/i,
  /\.env$/i,
  /\.env\./i,
  /known_hosts$/i,
  /authorized_keys$/i,
] as const

export interface AutoAcceptSettings {
  readGlobGrep?: boolean
  bashPrefixes?: boolean
  customBashPrefixes?: string[]
  excludedPaths?: string[]
}

let cachedSettings: AutoAcceptSettings | null = null

function isWindowsPlatform(): boolean {
  return getPlatform() === 'windows'
}

function getNativeSeparator(): string {
  return isWindowsPlatform() ? '\\' : '/'
}

function normalizeForComparison(value: string): string {
  if (isWindowsPlatform()) {
    return value.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase()
  }
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function getBasenameForPlatform(value: string): string {
  const separator = getNativeSeparator()
  const index = value.lastIndexOf(separator)
  return index === -1 ? value : value.slice(index + 1)
}

function getAutoAcceptSettings(): AutoAcceptSettings {
  if (cachedSettings !== null) {
    return cachedSettings
  }

  for (const source of SETTING_SOURCES) {
    if (source === 'policySettings' || source === 'flagSettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) continue

    try {
      const fs = require('fs')
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(content)
        const settings = parsed.readAutoAccept ?? parsed.autoAccept
        if (settings) {
          cachedSettings = settings
          return cachedSettings as AutoAcceptSettings
        }
      }
    } catch {
    }
  }

  cachedSettings = {}
  return cachedSettings
}

function getBlockedRoots(): string[] {
  const platform = getPlatform()
  const home = homedir()

  if (platform === 'windows') {
    const userProfile = process.env.USERPROFILE || home
    const appData = process.env.APPDATA || join(userProfile, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(userProfile, 'AppData', 'Local')

    return [
      'C:\\Windows',
      'C:\\ProgramData',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\$Recycle.Bin',
      join(appData, 'Microsoft', 'Credentials'),
      join(localAppData, 'Microsoft', 'Credentials'),
      join(localAppData, 'Microsoft.PowerShell.Security', 'Credential'),
      join(userProfile, '.ssh'),
      join(userProfile, '.gnupg'),
      join(userProfile, '.aws'),
      join(userProfile, '.azure'),
      join(userProfile, '.kube'),
      join(userProfile, '.docker'),
      join(userProfile, '.config'),
      join(userProfile, 'AppData'),
    ]
  }

  return [
    '/etc',
    '/sys',
    '/proc',
    '/dev',
    '/var',
    '/usr',
    '/boot',
    '/root',
    '/lib',
    '/lib64',
    '/sbin',
    '/bin',
    '/opt',
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.azure'),
    join(home, '.kube'),
    join(home, '.docker'),
    join(home, '.config'),
    '/run/secrets',
    '/run/user',
  ]
}

function isPathUnderBlockedRoot(absPath: string, blockedRoots: string[]): boolean {
  const normalizedPath = normalizeForComparison(absPath)
  const boundary = getNativeSeparator()

  for (const root of blockedRoots) {
    const normalizedRoot = normalizeForComparison(root)

    if (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(normalizedRoot + boundary)
    ) {
      return true
    }
  }

  return false
}

function isSensitiveFilename(fileName: string): boolean {
  return SENSITIVE_FILENAME_PATTERNS.some(pattern => pattern.test(fileName))
}

export function isAutoAcceptSafeGlobPattern(pattern: string): boolean {
  const normalizedPattern = normalizeForComparison(pattern)

  if (pattern.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pattern)) {
    const cwd = normalizeForComparison(getCwd())
    const originalCwd = normalizeForComparison(getOriginalCwd())
    if (!normalizedPattern.startsWith(cwd) && !normalizedPattern.startsWith(originalCwd)) {
      return false
    }
  }

  const blockedRoots = getBlockedRoots()
  for (const root of blockedRoots) {
    const normalizedRoot = normalizeForComparison(root)
    const boundary = getNativeSeparator()

    if (
      normalizedPattern === normalizedRoot ||
      normalizedPattern.startsWith(normalizedRoot + boundary) ||
      normalizedPattern.includes(`*/${normalizedRoot}`)
    ) {
      return false
    }
  }

  return true
}

export function isAutoAcceptBlockedPath(absPath: string): boolean {
  const settings = getAutoAcceptSettings()
  const customExcludedPaths = settings.excludedPaths ?? []
  const normalizedPath = normalizeForComparison(absPath)

  for (const excluded of customExcludedPaths) {
    const cleanExcluded = excluded.trim()
    if (!cleanExcluded) continue

    const normalizedExcluded = normalizeForComparison(cleanExcluded)
    const boundary = getNativeSeparator()

    if (
      normalizedPath === normalizedExcluded ||
      normalizedPath.startsWith(normalizedExcluded + boundary)
    ) {
      return true
    }
  }

  const blockedRoots = getBlockedRoots()
  if (isPathUnderBlockedRoot(absPath, blockedRoots)) {
    return true
  }

  const fileName = getBasenameForPlatform(absPath)
  if (isSensitiveFilename(fileName)) {
    return true
  }

  return false
}

/**
 * The OS "temp" locations that `autoNew` mode is allowed to read/search without
 * prompting, in addition to the workspace's own `temp/` directory. On Windows
 * this is the AppData temp dir (`%LOCALAPPDATA%/Temp`, `%TEMP%`, `%TMP%`);
 * on posix it is `$TMPDIR`/ `/tmp`. Kept separate from `getBlockedRoots` so the
 * seed list stays narrowly scoped to temp scratch space (not all of AppData).
 */
function getAppDataTempPaths(): string[] {
  const paths: string[] = []

  if (isWindowsPlatform()) {
    const userProfile = process.env.USERPROFILE || homedir()
    const localAppData =
      process.env.LOCALAPPDATA || join(userProfile, 'AppData', 'Local')
    const temp = process.env.TEMP || process.env.TMP || join(localAppData, 'Temp')
    paths.push(temp)
  } else {
    paths.push(process.env.TMPDIR || '/tmp')
  }

  return paths
    .filter(Boolean)
    .map(p => normalizeForComparison(p as string).replace(/[\\/]+$/, ''))
}

/**
 * In `autoNew` mode, read/search access should be scoped to *specific* paths
 * (the workspace's `temp/` and `.claude` directories, plus the OS temp/AppData
 * temp directory) — not a blanket waiver of the sensitive-path guard for
 * everything. Returns true when `absPath` lives under one of those seeded
 * directories, so the caller can skip the sensitive-path block for exactly those
 * paths and let every other path fall through to the normal (workspace-gated)
 * permission policy.
 */
export function isAutoNewSeededReadPath(absPath: string, cwd: string): boolean {
  if (!absPath || !cwd) return false
  const normPath = normalizeForComparison(absPath)
  const sep = getNativeSeparator()

  // Workspace-scoped seed dirs: <cwd>/temp and <cwd>/.claude
  const normCwd = normalizeForComparison(cwd).replace(/[\\/]+$/, '')
  for (const subdir of ['temp', '.claude']) {
    const prefix = `${normCwd}${sep}${subdir}`
    if (normPath === prefix || normPath.startsWith(prefix + sep)) {
      return true
    }
  }

  // OS temp / AppData temp seed dir
  for (const appDataTemp of getAppDataTempPaths()) {
    if (normPath === appDataTemp || normPath.startsWith(appDataTemp + sep)) {
      return true
    }
  }

  return false
}

export function hasSuspiciousShellSyntax(command: string): boolean {
  const trimmed = command.trim()

  if (/\$\(/.test(trimmed)) return true
  if (/`[^`]*`/.test(trimmed)) return true
  if (/<\(/.test(trimmed)) return true
  if (/>\(/.test(trimmed)) return true
  if (/;\s*\S/.test(trimmed)) return true
  if (/&&\s*\S/.test(trimmed)) return true
  if (/\|\|\s*\S/.test(trimmed)) return true
  if (/\|\s*\S/.test(trimmed)) return true
  if (/\\\s*[\n\r]/.test(trimmed)) return true
  if (/[\n\r]/.test(trimmed)) return true
  if (/<<[^'"]/.test(trimmed)) return true

  const dangerousPatterns = [
    /\beval\b/,
    /\bexec\b/,
    /\bbase64\s+-d\b/,
    /\bbase64\s+--decode\b/,
    /\bsh\s+-c\b/,
    /\bbash\s+-c\b/,
    /\bpython\s+-c\b/,
    /\bperl\s+-e\b/,
    /\bruby\s+-e\b/,
    /\bnode\s+-e\b/,
    /\bdeno\s+eval\b/,
    /\bpowershell\s+-c\b/,
    /\bpwsh\s+-c\b/,
    /\bosascript\s+-e\b/,
  ]

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) return true
  }

  return false
}

export function isAutoAcceptSafeBashPrefix(command: string, customPrefixes: string[] = []): boolean {
  const trimmed = command.trim()
  const allPrefixes = [...STATIC_SAFE_BASH_PREFIXES_LOCAL, ...customPrefixes]

  for (const prefix of allPrefixes) {
    if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
      return true
    }
  }

  return false
}

const STATIC_SAFE_BASH_PREFIXES_LOCAL: readonly string[] = [
  'unzip -l',
  'unzip -t',
  'jar tf',
  'jar -tf',
  'jar --list',
  'tar -tf',
  'tar --list',
  'python -m zipfile -l',
  'npm view',
  'npm info',
  'npm ls',
  'npm list',
  'pip show',
  'pip show -f',
  'pip list',
  'pip freeze',
  'cargo metadata',
  'cargo tree',
  'cargo search',
  'go list',
  'go mod graph',
  'go mod verify',
  'git log',
  'git status',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git rev-parse',
  'git ls-files',
  'git ls-remote',
  'git config --get',
  'git config --list',
  'git reflog',
  'git shortlog',
  'git stash list',
  'git tag',
  'git describe',
  'git blame',
  'git cat-file',
  'git for-each-ref',
  'git grep',
  'git merge-base',
  'git rev-list',
  'git worktree list',
  'bun run build',
  'ls ',
  'find ',
  'tree',
  'file ',
  'wc ',
  'head',
  'tail',
  'cat',
  'echo',
  'pwd',
  'which ',
  'where ',
  'jq ',
  'python -c',
  'python -m json.tool',
  'tree -L',
  'du ',
  'df ',
  'ps ',
  'date',
  'hexdump ',
  'od ',
  'strings ',
  'gh ',
  'gh pr view',
  'gh pr list',
  'gh pr diff',
  'gh pr checks',
  'gh issue view',
  'gh issue list',
  'gh repo view',
  'gh run list',
  'gh run view',
  'gh auth status',
  'gh pr status',
  'gh issue status',
  'gh release list',
  'gh release view',
  'gh workflow list',
  'gh workflow view',
  'gh label list',
  'gh search repos',
  'gh search issues',
  'gh search prs',
  'gh search commits',
  'gh search code',

  // Gradle build (local build / test / task-listing commands)
  'gradle help',
  'gradle tasks',
  'gradle build',
  'gradle assemble',
  'gradle test',
  'gradle check',
  'gradle compileJava',
  'gradle compileTestJava',
  'gradle classes',
  'gradle dependencies',
  'gradle lint',
  'gradle --version',
  'gradle -version',
  './gradlew help',
  './gradlew tasks',
  './gradlew build',
  './gradlew assemble',
  './gradlew test',
  './gradlew check',
  './gradlew compileJava',
  './gradlew compileTestJava',
  './gradlew classes',
  './gradlew dependencies',
  './gradlew lint',
  './gradlew --version',
  'gradlew help',
  'gradlew build',
  'gradlew test',
  'gradlew --version',
]

export function isReadGlobGrepAutoAcceptEnabled(): boolean {
  const settings = getAutoAcceptSettings()
  return settings.readGlobGrep !== false
}

export function isBashPrefixAutoAcceptEnabled(): boolean {
  const settings = getAutoAcceptSettings()
  return settings.bashPrefixes !== false
}

export function getCustomBashPrefixes(): string[] {
  const settings = getAutoAcceptSettings()
  return settings.customBashPrefixes ?? []
}