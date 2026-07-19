/**
 * Category classifier for the Auto (New) permission mode.
 *
 * Maps a bash command + cwd into one of the per-category policy buckets used by
 * `getAutoNewModeConfig()` (delete, tempRead, tempWrite, systemRead, systemWrite,
 * onlineRead, onlineWrite, other). The actual allow/think/ask decision is made
 * downstream in `bashPermissions.ts` based on the policy for the returned category.
 *
 * This classifier is intentionally simple and keyword/regex based. It reuses a few
 * safe-read signals from the legacy read-only validation machinery but does NOT
 * depend on the TRANSCRIPT_CLASSIFIER feature being enabled.
 */

import { containsVulnerableUncPath } from '../shell/readOnlyCommandValidation.js'
import { getAutoNewModeConfig } from '../settings/settings.js'

export type AutoNewCategory =
  | 'recycleBin'
  | 'shiftDelete'
  | 'tempRead'
  | 'tempWrite'
  | 'systemRead'
  | 'systemWrite'
  | 'onlineRead'
  | 'onlineWrite'
  | 'safeDev'
  | 'runScript'
  | 'runExecutable'
  | 'other'

// Script interpreters — a command launched via one of these (with a script
// argument) routes to the `runScript` policy. These are distinct from the
// build/runner tooling that `classifySafeDev` already claims (node, bun, deno,
// npm, gradle, mvn, cargo, etc.), so build commands keep their `safeDev`
// classification while `bash script.sh` / `python x.py` become `runScript`.
export const RUN_SCRIPT_INTERPRETERS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'python',
  'python3',
  'python2',
  'py',
  'ruby',
  'rb',
  'perl',
  'pl',
  'php',
  'php5',
  'php7',
  'php8',
  'lua',
  'luajit',
  'groovy',
  'tclsh',
  'wish',
  'racket',
  'guile',
  'Rscript',
  'julia',
])

// Git subcommands that are purely read-only (network or local) => onlineRead / systemRead.
const GIT_READONLY_SUBCOMMANDS = new Set([
  'fetch',
  'clone',
  'ls-remote',
  'remote',
  'status',
  'log',
  'show',
  'branch',
  'tag',
  'rev-parse',
  'rev-list',
  'cat-file',
  'diff',
  'grep',
  'stash',
  'config',
])

// Git subcommands that mutate remote or local state => onlineWrite / systemWrite.
// push is remote-mutating (onlineWrite); the rest are local mutations (systemWrite).
const GIT_WRITE_SUBCOMMANDS = new Set([
  'commit',
  'add',
  'rm',
  'mv',
  'checkout',
  'reset',
  'merge',
  'rebase',
  'cherry-pick',
  'am',
  'apply',
  'tag -d',
  'branch -d',
  'branch -D',
  'stage',
  'unstage',
])

// Permanent / force deletes (shiftDelete): these cannot be undone.
const SHIFT_DELETE_COMMANDS = [
  'rm -rf',
  'rm -r -f',
  'rm -fr',
  'rmdir /s',
  'rd /s',
  'del /f',
  'del /q /f',
  'rm -f',
  'remove-item -force',
  'erase /f',
]

// Soft deletes / move-to-recycle (recycleBin): generally recoverable.
const RECYCLE_BIN_COMMANDS = [
  'trash',
  'rm',
  'del',
  'rd',
  'rmdir',
  'remove-item',
  'erase',
]

const SYSTEM_WRITE_COMMANDS = [
  'kill',
  'taskkill',
  'pkill',
  'shutdown',
  'systemctl',
  'service',
  'taskmgr',
  'net stop',
  'net start',
  'sc ',
]

const SYSTEM_READ_COMMANDS = [
  'tasklist',
  'ps',
  'get-process',
  'ls /proc',
  'ls /sys',
  'wmic',
  'top',
  'htop',
]

const HTTP_METHOD_FLAGS = [
  '-X',
  '--request',
  '-d',
  '--data',
  '--data-raw',
  '--data-urlencode',
  '--data-binary',
  '-F',
  '--form',
  '-T',
  '--upload-file',
  '-u',
  '--user',
]

function tokenize(cmd: string): string[] {
  // Strip inline comments and split on whitespace-ish boundaries.
  const noComment = cmd.replace(/#.*$/, '')
  return noComment
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
}

function firstCommandToken(tokens: string[]): string {
  // Skip common shell prefixes / env assignments.
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i].toLowerCase()
    if (t === 'sudo' || t === 'doas' || t === 'time' || t === 'env') {
      i++
      continue
    }
    // env assignment like FOO=bar
    if (/^[a-z0-9_]+=/.test(tokens[i])) {
      i++
      continue
    }
    break
  }
  return (tokens[i] ?? '').toLowerCase()
}

function hasAnyToken(tokens: string[], candidates: string[]): boolean {
  return tokens.some(t => {
    const lower = t.toLowerCase()
    return candidates.some(c => lower === c || lower.startsWith(c))
  })
}

// Multi-word phrases (e.g. "rm -rf") never match as a single token, so test
// them as substrings of the normalized command.
function hasAnyPhrase(cmd: string, phrases: string[]): boolean {
  const lower = cmd.toLowerCase()
  return phrases.some(p => lower.includes(p))
}

function getGitSubcommand(cmd: string): string | null {
  const tokens = tokenize(cmd)
  const idx = tokens.findIndex(t => t.toLowerCase() === 'git')
  if (idx === -1) return null
  // Find the next token that is not a global flag.
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('-')) continue
    return t.toLowerCase()
  }
  return null
}

function looksTempPath(path: string, cwd: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const cwdNorm = (cwd || '').replace(/\\/g, '/').toLowerCase()
  // Any segment named "temp" (or temp\...) anywhere in the path.
  if (/(^|\/)temp(\/|$)/.test(normalized)) return true
  // Path directly under cwd/temp.
  if (cwdNorm && normalized.startsWith(cwdNorm.replace(/\/$/, '') + '/temp/'))
    return true
  return false
}

function commandMutates(cmd: string): boolean {
  // Heuristic: presence of redirect-append, pipe-to-write, or known mutating
  // verbs implies a write rather than a read. Used to split tempRead/tempWrite
  // and identify read-only network commands.
  return (
    />\s*/.test(cmd) ||
    /\btee\b/.test(cmd) ||
    /\bwrite\b/i.test(cmd) ||
    /\bcp\b/.test(cmd) ||
    /\bmv\b/.test(cmd)
  )
}

// Multi-token prefixes that identify safe dev commands (first two tokens).
const SAFE_DEV_MULTI_TOKEN: Array<[string, string]> = [
  // npm/yarn/pnpm run <script> — local task runner, no network/mutate by default.
  ['npm', 'run'],
  ['yarn', 'run'],
  ['pnpm', 'run'],
  ['bun', 'run'],
  ['bunx', 'run'],
  ['go', 'test'],
  ['go', 'build'],
  ['go', 'vet'],
  ['go', 'generate'],
  ['go', 'list'],
  ['go', 'fmt'],
  ['go', 'mod'],
  ['cargo', 'build'],
  ['cargo', 'test'],
  ['cargo', 'run'],
  ['cargo', 'check'],
  ['cargo', 'tree'],
  ['cargo', 'clippy'],
  ['cargo', 'fmt'],
  ['dotnet', 'build'],
  ['dotnet', 'test'],
  ['dotnet', 'run'],
  ['docker', 'inspect'],
  ['docker', 'image'],
  ['docker', 'ps'],
  ['docker', 'logs'],
  ['docker', 'compose'],
  ['npm', 'ci'],
  ['npm', 'install'],
  ['yarn', 'install'],
  ['pnpm', 'install'],
  ['bun', 'install'],
  ['mvn', 'test'],
  ['mvn', 'dependency:tree'],
  ['gradle', 'test'],
  ['npm', 'ls'],
  ['npm', 'view'],
  ['yarn', 'list'],
  ['pip', 'show'],
  ['pip', 'list'],
  ['gem', 'list'],
  ['apt-cache', 'search'],
  ['apt-cache', 'show'],
  ['yum', 'info'],
  ['brew', 'info'],
  ['brew', 'list'],
]

// Single-token safe dev commands (first token match, case-insensitive).
const SAFE_DEV_SINGLE_TOKEN = new Set([
  // Build systems / task runners.
  'gradle',
  'mvn',
  'make',
  'cmake',
  'ninja',
  'bazel',
  'ant',
  'sbt',
  'rake',
  'mix',
  'phpunit',
  'rspec',
  'jest',
  'vitest',
  'tsc',
  'eslint',
  'prettier',
  'tox',
  // Test runners.
  'pytest',
  'pytest-3',
  'node',
  'bun',
  'bunx',
  'node',
  'deno',
  'julia',
  // Compilers / linkers / analysis.
  'gcc',
  'g++',
  'clang',
  'clang++',
  'cc',
  'cc1',
  'rustc',
  'javac',
  'go',
  'dotnet',
  'cargo',
  'tsc',
  // Archive / container / artifact read-only inspection.
  'jar',
  'unzip',
  'tar',
  'zipinfo',
  'zcat',
  'gzcat',
  'bzip2',
  'xz',
  '7z',
  'rpm',
  'dpkg',
  'ar',
  'cabextract',
  'plutil',
  // Decompilers / bytecode & binary viewers (read-only).
  'javap',
  'jadx',
  'procyon',
  'jd-cli',
  'cfr',
  'ghidra',
  'objdump',
  'readelf',
  'strings',
  'nm',
  'gdb',
  'lldb',
  'xxd',
  'hexdump',
  'od',
  'file',
  'otool',
  'dumpbin',
  'nm',
  'size',
  'demumble',
  // Package / dependency read-only info. NOTE: npm/yarn/pnpm/docker are handled
  // via SAFE_DEV_MULTI_TOKEN (their safe subcommands) and the online/system
  // branches (publish/push) below, so they are intentionally NOT single-token
  // matches here — a bare `npm`/`docker` word must not blanket-classify as safeDev.
  'pip',
  'pip3',
  'gem',
  'cargo',
  'go',
  'apt-cache',
  'yum',
  'brew',
  'apm',
  'composer',
  'nuget',
  'pod',
  'bundle',
  // Generic read-only / informational.
  'which',
  'where',
  'type',
  'echo',
  'printf',
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'awk',
  'sed',
  'sort',
  'uniq',
  'wc',
  'cut',
  'tr',
  'base64',
  'sha256sum',
  'md5sum',
  'diff',
  'cmp',
  'true',
  'false',
  'test',
  'pwd',
  'env',
  'printenv',
  'date',
  'uname',
  'hostname',
  'id',
  'whoami',
])

/**
 * Route a command to the `safeDev` category when it is routine, non-destructive
 * developer tooling: build systems, test runners, archive/container inspection,
 * decompilers/bytecode viewers, and read-only package/dependency info. Returns
 * `null` when the command does not match — callers then fall through to the
 * remaining classifiers. Dangerous / destructive checks in `classifyAutoNewCategory`
 * already ran, so reaching here means the command is safe to auto-permit.
 */
function classifySafeDev(
  cmd: string,
  tokens: string[],
  first: string,
): AutoNewCategory | null {
  if (tokens.length === 0) return null

  // Refining suffixes that would make an otherwise-safe tool destructive.
  // These are checked on the FULL command text so multi-token tools (jar tf,
  // unzip -l, tar tf) still classify as safeDev while destructive siblings
  // (jar xf, tar xf, unzip file.zip) are handled by other branches.
  const lower = cmd.toLowerCase()

  // Archive extractors: `tf`/`-l`/`--list`/`qlp`/`-c` (list contents) are safe.
  const archiveListRegex =
    /\b(jar|zipinfo|7z)\s+(\S*\s+)*(-l|--list|tf|l\b)/.test(lower) ||
    /\btar\s+(\S*\s+)*(-t|--list|tf)/.test(lower) ||
    /\bunzip\s+(\S*\s+)*(-l|--list)/.test(lower) ||
    /\brpm\s+(\S*\s+)*(-q|--query).*(-l|--list|-p)/.test(lower) ||
    /\bunzip\b.*-l\b/.test(lower) ||
    /\bdpkg\s+(\S*\s+)*-c\b/.test(lower)
  if (archiveListRegex) return 'safeDev'

  // Decompiler / binary-viewer flag refinements (read-only modes).
  if (
    /\bgdb\b.*-batch\b/.test(lower) ||
    /\bobjdump\b/.test(lower) ||
    /\breadelf\b/.test(lower) ||
    /\bxxd\b/.test(lower) ||
    /\bhexdump\b/.test(lower) ||
    /\bjavap\b/.test(lower) ||
    /\bjadx\b/.test(lower) ||
    /\bprocyon\b/.test(lower) ||
    /\bstrings\b/.test(lower) ||
    /\bnm\b/.test(lower) ||
    /\bfile\b/.test(lower)
  ) {
    return 'safeDev'
  }

  // Multi-token prefixes (npm run, go test, cargo build, docker inspect, ...).
  for (const [a, b] of SAFE_DEV_MULTI_TOKEN) {
    if (tokens.length >= 2 && tokens[0].toLowerCase() === a && tokens[1].toLowerCase() === b) {
      // Guard: `npm run` with a destructive-looking script name still wins via
      // the destructive verbs checked earlier, so we only return here when the
      // second token is a non-destructive task identifier.
      const second = tokens[1].toLowerCase()
      if (!/[;&|`$<>]/.test(second)) return 'safeDev'
    }
  }

  if (SAFE_DEV_SINGLE_TOKEN.has(first)) {
    // `npm`/`yarn`/`pnpm` publish is onlineWrite (handled earlier); here we
    // capture install/ls/view/build/test etc. Publishing was already routed.
    if (first === 'npm' || first === 'yarn' || first === 'pnpm') {
      const sub = (tokens[1] || '').toLowerCase()
      if (['publish', 'whoami', 'deprecate', 'owner'].includes(sub)) return null
    }
    return 'safeDev'
  }

  return null
}

/**
 * Classify a command into an Auto (New) policy category.
 *
 * `opts` optionally carries the user's `scriptCommands` / `executables`
 * allowlists (resolved from `getAutoNewModeConfig()` by the caller). When
 * provided, a command matching an allowlist entry overrides the heuristic.
 */
export interface ClassifyAutoNewOptions {
  scriptCommands?: readonly string[]
  executables?: readonly string[]
}

export function classifyAutoNewCategory(
  cmd: string,
  cwd: string,
  opts?: ClassifyAutoNewOptions,
): AutoNewCategory {
  const resolvedOpts: ClassifyAutoNewOptions =
    opts ??
    (() => {
      const cfg = getAutoNewModeConfig()
      return {
        scriptCommands: cfg.scriptCommands,
        executables: cfg.executables,
      }
    })()
  if (!cmd || !cmd.trim()) return 'other'

  if (containsVulnerableUncPath(cmd)) {
    // Vulnerable UNC path access is treated as a dangerous cross-machine write.
    return 'onlineWrite'
  }

  const tokens = tokenize(cmd)
  if (tokens.length === 0) return 'other'

  const first = firstCommandToken(tokens)

  // --- Delete categories (split into soft recycle vs permanent shift-delete) ---
  if (hasAnyPhrase(cmd, SHIFT_DELETE_COMMANDS)) return 'shiftDelete'
  // Soft delete verbs: rm (without -rf), del (without /f), trash, rmdir, etc.
  if (hasAnyToken(tokens, RECYCLE_BIN_COMMANDS)) return 'recycleBin'
  if (first === 'git') {
    const sub = getGitSubcommand(cmd)
    if (sub === 'clean') return 'shiftDelete'
    if (sub === 'reset' && tokens.includes('--hard')) return 'shiftDelete'
    // Pushes / publishes touch remote (external, irreversible) => onlineWrite.
    if (sub === 'push' || sub === 'publish') return 'onlineWrite'
    if (sub && GIT_WRITE_SUBCOMMANDS.has(sub)) return 'systemWrite'
    if (sub && GIT_READONLY_SUBCOMMANDS.has(sub)) return 'onlineRead'
  }
  if (first === 'gh') {
    // gh api may be GET (read) or a mutation (write).
    if (tokens.some(t => t.toLowerCase() === 'api')) {
      const methodIdx = tokens.findIndex(
        t => t === '-X' || t === '--request' || t.toLowerCase() === 'mutation',
      )
      const hasMethod = methodIdx !== -1
      const method = hasMethod ? tokens[methodIdx + 1]?.toUpperCase() : ''
      if (
        hasMethod &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      )
        return 'onlineWrite'
      if (tokens.some(t => t.toLowerCase().startsWith('mutation')))
        return 'onlineWrite'
      return 'onlineRead'
    }
    // Other gh read-ish subcommands (pr list, issue list, etc.) are online reads.
    const ghRead = tokens.find(
      t =>
        /^(pr|issue|repo|workflow|release|run|api)$/.test(t.toLowerCase()) &&
        /(list|view|get|ls)$/.test((tokens[tokens.indexOf(t) + 1] || '').toLowerCase()),
    )
    if (ghRead) return 'onlineRead'
    if (tokens.some(t => /^(pr|issue|repo|release|run)$/.test(t.toLowerCase())))
      return 'onlineRead'
  }

  // --- System categories ---
  if (hasAnyToken(tokens, SYSTEM_WRITE_COMMANDS)) return 'systemWrite'
  if (hasAnyToken(tokens, SYSTEM_READ_COMMANDS)) return 'systemRead'

  // --- Online categories ---
  const isCurlWget =
    first === 'curl' || first === 'wget' || first === 'invoke-webrequest' || first === 'iwr'
  if (isCurlWget) {
    // POST/PUT/etc or data-upload flag => write.
    const hasWriteMethod = tokens.some(t =>
      ['-X', '--request', '-T', '--upload-file'].includes(t),
    )
    const method = hasWriteMethod
      ? (tokens[tokens.indexOf('-X') + 1] || tokens[tokens.indexOf('--request') + 1] || '').toUpperCase()
      : ''
    if (hasWriteMethod && ['POST', 'PUT', 'PATCH'].includes(method)) return 'onlineWrite'
    if (tokens.some(t => ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form'].includes(t)))
      return 'onlineWrite'
    return 'onlineRead'
  }
  if (['scp', 'rsync', 'sftp', 'aws', 'gsutil', 'az', 'npm', 'yarn', 'pnpm'].includes(first)) {
    // Directories of these that write to remote.
    if (first === 'npm' && tokens.includes('publish')) return 'onlineWrite'
    if (first === 'yarn' && tokens.includes('publish')) return 'onlineWrite'
    if (first === 'aws' && tokens.includes('s3') && tokens.includes('cp')) return 'onlineWrite'
    if (first === 'gsutil' && tokens.includes('cp')) return 'onlineWrite'
    if (first === 'az' && tokens.includes('upload')) return 'onlineWrite'
    // scp / rsync to remote paths => write; rsync without remote => read-ish copy (allow).
    if (first === 'scp' || first === 'rsync' || first === 'sftp') {
      const looksRemote = tokens.some(t => /:/.test(t))
      return looksRemote ? 'onlineWrite' : 'tempWrite'
    }
    // npm/yarn/pnpm: publish/deprecate is a remote write; all other
    // subcommands (run/test/ci/install/ls/view/build) are safe dev tooling.
    if (first === 'npm' || first === 'yarn' || first === 'pnpm') {
      const sub = (tokens[1] || '').toLowerCase()
      if (sub === 'publish' || sub === 'deprecate') return 'onlineWrite'
      return 'safeDev'
    }
    return 'onlineWrite'
  }

  // --- docker: route network/system mutations to online/system, otherwise
  // read-only inspection (inspect/image/ps/logs/compose) is safe dev tooling. ---
  if (first === 'docker') {
    const dockerSub = (tokens[1] || '').toLowerCase()
    if (['push', 'commit', 'tag', 'save', 'login', 'logout'].includes(dockerSub))
      return 'onlineWrite'
    if (['exec', 'run', 'start', 'stop', 'rm', 'kill', 'restart'].includes(dockerSub))
      return 'systemWrite'
    // inspect/image/ps/logs/compose/etc -> read-only inspection.
    return 'safeDev'
  }

  // --- Temp path inspection (covers cat/cp/ls against temp/) ---
  // Runs BEFORE the safeDev single-token matcher so that e.g. `cat temp/x`
  // classifies as tempRead (governed by tempRead/tempWrite policy), not safeDev.
  const pathish = tokens.filter(t => t.includes('/') || t.includes('\\') || t.startsWith('.'))
  for (const p of pathish) {
    if (looksTempPath(p, cwd)) {
      return commandMutates(cmd) ? 'tempWrite' : 'tempRead'
    }
  }
  // If command references temp/ only in free text.
  if (/(^|\s)temp[\\/]/.test(cmd.toLowerCase()) || /\btemp\b/.test(cmd.toLowerCase())) {
    return commandMutates(cmd) ? 'tempWrite' : 'tempRead'
  }

  // --- Script vs executable (interpreter-based) ---
  // Allowlists override everything: a command matching a `scriptCommands` entry
  // is forced to `runScript`; a command matching an `executables` entry is
  // forced to `runExecutable`. Match is substring (case-insensitive) on the raw
  // command so both `bash build.sh` and `./build.sh` can be pinned.
  const lowerCmd = cmd.toLowerCase()
  const scriptCommands = resolvedOpts.scriptCommands
  if (scriptCommands && scriptCommands.length) {
    if (scriptCommands.some(s => s && lowerCmd.includes(s.toLowerCase()))) {
      return 'runScript'
    }
  }
  const executables = resolvedOpts.executables
  if (executables && executables.length) {
    if (executables.some(e => e && lowerCmd.includes(e.toLowerCase()))) {
      return 'runExecutable'
    }
  }

  // --- Script interpreters vs safe-dev tooling ---
  // A command launched via a script interpreter (bash, python, ruby, perl, ...)
  // is a more specific signal than generic "safe dev tooling", so it routes to
  // `runScript` BEFORE the broad `safeDev` matcher — otherwise `python x.py`
  // would be swallowed into safeDev. Note `node`/`bun`/`deno` are deliberately
  // NOT interpreters here (they are build runners => safeDev), and direct binary
  // paths (have a separator or `./`/`../` prefix) route to `runExecutable`.
  if (RUN_SCRIPT_INTERPRETERS.has(first)) return 'runScript'
  if (first.includes('/') || first.includes('\\') || first.startsWith('./') || first.startsWith('../')) {
    return 'runExecutable'
  }

  // --- Safe dev tooling (build/test/decompile/read-only inspection) ---
  // Resolved after the interpreter/executable heuristics so named build/test
  // runners (gradle, mvn, npm run, bun run build, jest, pytest, cargo, tsc,
  // docker inspect, archive/bytecode inspection, ...) keep their `safeDev`
  // classification.
  const safeDevCategory = classifySafeDev(cmd, tokens, first)
  if (safeDevCategory) return safeDevCategory

  // Genuinely unmatched command (neither a script interpreter, a direct binary
  // path, nor recognized build/inspection tooling) => governed by `other`.
  return 'other'
}

/**
 * Paths that, by their very nature, are never considered "within the workspace"
 * even if they happen to be lexically under the cwd — they represent sensitive,
 * system-wide, or external locations and must always fall through to the
 * per-category policy (where they typically prompt).
 */
const SENSITIVE_PATH_SEGMENTS = [
  'temp',
  '$recycle.bin',
  'recycle.bin',
  'recycler',
  '.trash',
  'system32',
  'windows',
  'win32',
  'proc',
  'sys',
  'boot',
  'etc',
  'var',
  'usr',
  'library',
  'applications',
  '.git',
  '.claude',
]

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isSensitiveSegment(p: string): boolean {
  const norm = normalizePath(p)
  return SENSITIVE_PATH_SEGMENTS.some(
    seg => norm === `/${seg}` || norm.endsWith(`/${seg}`) || norm.split('/').includes(seg),
  )
}

/**
 * True when every path-like token in the command is contained within the
 * workspace tree (the cwd and its descendants) and none of them point at a
 * sensitive system/external location. Commands whose only "paths" are HTTP
 * hosts, UNC shares, or bare command names are treated as NOT within the
 * workspace so they keep going through the normal policy.
 *
 * The caller owns the actual allow/ask decision; this only answers
 * "is this a boring in-tree operation?"
 */
export function isCommandWithinWorkspace(cmd: string, cwd: string): boolean {
  if (!cmd || !cmd.trim() || !cwd) return false
  const cwdNorm = normalizePath(cwd)
  // Already-known sensitive non-cwd locations short-circuit.
  if (isSensitiveSegment(cwdNorm) && !SENSITIVE_PATH_SEGMENTS.some(s => cwdNorm.endsWith(`/${s}`))) {
    // cwd itself is sensitive; don't blanket-allow.
  }

  const tokens = tokenize(cmd)
  const pathTokens = tokens.filter(
    t =>
      (t.includes('/') || t.includes('\\') || t.startsWith('.')) &&
      // Drop obvious remote/host tokens (hosts, urls, UNC).
      !/^https?:\/\//.test(t) &&
      !/^[\w.-]+@/.test(t) &&
      !/^[\w.-]+:/.test(t),
  )

  if (pathTokens.length === 0) {
    // No path arguments at all. Treat as in-tree only when the command does not
    // reference a sensitive segment in free text (e.g. "rm temp/x").
    const freeText = cmd.toLowerCase()
    if (SENSITIVE_PATH_SEGMENTS.some(seg => new RegExp(`(^|\\s)${seg}[\\/\\s]|$`).test(freeText))) {
      return false
    }
    return true
  }

  for (const raw of pathTokens) {
    // Strip shell quotes / trailing punctuation.
    const p = raw.replace(/^['"]|['"]$/g, '')
    const norm = normalizePath(p)
    // Relative path starting with . or .. -> within tree (descendants of cwd).
    const isRelative = norm.startsWith('./') || norm === '.' || norm.startsWith('../') || !/^(\/|[a-z]:)/.test(norm)
    if (isRelative) {
      if (isSensitiveSegment(norm)) return false
      continue
    }
    // Absolute path (posix / or windows C:): must be under cwd and not sensitive.
    if (!norm.startsWith(cwdNorm) || (norm.length > cwdNorm.length && norm[cwdNorm.length] !== '/')) {
      return false
    }
    // cwdNorm already covers the root; check the segment under it.
    const rest = norm.slice(cwdNorm.length)
    if (isSensitiveSegment(rest)) return false
  }
  return true
}

// Categories that are always considered sensitive regardless of path.
export const SENSITIVE_AUTO_NEW_CATEGORIES: ReadonlySet<AutoNewCategory> = new Set<AutoNewCategory>([
  'shiftDelete',
  'recycleBin',
  'systemWrite',
  'onlineWrite',
])
