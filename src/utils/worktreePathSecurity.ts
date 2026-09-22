import { lstatSync, realpathSync } from 'fs'
import { realpath } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  for (const segment of slug.split('/')) {
    if (
      segment === '.' ||
      segment === '..' ||
      segment.toLowerCase() === '.git'
    ) {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain reserved Git path segments`,
      )
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and ` +
          'contain only letters, digits, dots, underscores, and dashes',
      )
    }
  }
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

async function resolveWithExistingAncestor(path: string): Promise<string> {
  const unresolved: string[] = []
  let current = resolve(path)

  while (true) {
    try {
      const resolved = await realpath(current)
      return unresolved.reduceRight(
        (parent, segment) => resolve(parent, segment),
        resolved,
      )
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        throw new Error(`Unable to resolve path: ${path}`)
      }
      unresolved.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

export async function assertWorktreePathForCreation(
  repoRoot: string,
  worktreePath: string,
): Promise<string> {
  const canonicalRepoRoot = await realpath(repoRoot)
  const worktreesRoot = resolve(repoRoot, '.claude', 'worktrees')
  const canonicalWorktreesRoot = await resolveWithExistingAncestor(worktreesRoot)
  const canonicalWorktreePath = await resolveWithExistingAncestor(worktreePath)

  if (
    !isPathWithinRoot(canonicalRepoRoot, canonicalWorktreesRoot) ||
    !isPathWithinRoot(canonicalWorktreesRoot, canonicalWorktreePath) ||
    canonicalWorktreePath === canonicalWorktreesRoot
  ) {
    throw new Error(
      `Refusing worktree path outside the repository worktree directory: ${worktreePath}`,
    )
  }

  try {
    if (lstatSync(worktreePath).isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link worktree path: ${worktreePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return resolve(worktreePath)
}

export async function assertPathWithinRoot(
  path: string,
  allowedRoot: string,
): Promise<string> {
  const canonicalRoot = await realpath(allowedRoot)
  const canonicalPath = await resolveWithExistingAncestor(path)
  if (!isPathWithinRoot(canonicalRoot, canonicalPath)) {
    throw new Error(`Refusing path outside the project directory: ${path}`)
  }
  return resolve(path)
}

export function assertExistingPathWithinRoot(
  path: string,
  allowedRoot: string,
): string {
  const canonicalRoot = realpathSync(allowedRoot)
  const canonicalPath = realpathSync(path)
  const stats = lstatSync(path)
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !isPathWithinRoot(canonicalRoot, canonicalPath)
  ) {
    throw new Error(`Refusing path outside the project directory: ${path}`)
  }
  return canonicalPath
}

export function assertExistingWorktreePath(
  worktreePath: string,
  allowedRoot: string,
): string {
  if (!isAbsolute(worktreePath) || worktreePath.includes('\0')) {
    throw new Error(`Invalid worktree path: ${worktreePath}`)
  }

  const canonicalRoot = realpathSync(allowedRoot)
  const canonicalWorktreePath = realpathSync(worktreePath)
  const stats = lstatSync(worktreePath)

  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    canonicalWorktreePath === canonicalRoot ||
    !isPathWithinRoot(canonicalRoot, canonicalWorktreePath)
  ) {
    throw new Error(
      `Refusing worktree path outside the project directory: ${worktreePath}`,
    )
  }

  return canonicalWorktreePath
}

export function isPathWithin(root: string, candidate: string): boolean {
  return isPathWithinRoot(root, candidate)
}
