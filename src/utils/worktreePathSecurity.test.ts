import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertExistingWorktreePath,
  assertPathWithinRoot,
  assertWorktreePathForCreation,
  validateWorktreeSlug,
} from './worktreePathSecurity.js'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map(path => rm(path, { recursive: true, force: true })),
  )
})

test('rejects reserved Git worktree names', () => {
  expect(() => validateWorktreeSlug('.git')).toThrow()
  expect(() => validateWorktreeSlug('.GIT')).toThrow()
  expect(() => validateWorktreeSlug('feature/.git')).toThrow()
  expect(() => validateWorktreeSlug('feature-branch')).not.toThrow()
})

test('rejects worktree creation outside the repository worktree directory', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'neocode-worktree-'))
  tempDirectories.push(repoRoot)

  await expect(
    assertWorktreePathForCreation(repoRoot, join(repoRoot, '..', 'outside')),
  ).rejects.toThrow()
})

test('rejects existing worktrees outside the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neocode-worktree-'))
  const projectRoot = join(root, 'project')
  const outside = join(root, 'outside')
  await mkdir(projectRoot)
  await mkdir(outside)
  tempDirectories.push(root)

  expect(() => assertExistingWorktreePath(outside, projectRoot)).toThrow()
  await expect(assertPathWithinRoot(outside, projectRoot)).rejects.toThrow()
})
