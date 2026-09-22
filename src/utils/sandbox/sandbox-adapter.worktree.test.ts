import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectWorktreeMainRepoPath } from './sandbox-adapter.js'

test('does not trust forged worktree metadata when resolving sandbox write roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neocode-sandbox-'))
  const victim = await mkdtemp(join(tmpdir(), 'neocode-victim-'))

  try {
    await writeFile(
      join(root, '.git'),
      `gitdir: ${join(victim, '.git', 'worktrees', 'forged')}\n`,
    )

    await expect(detectWorktreeMainRepoPath(root)).resolves.toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(victim, { recursive: true, force: true })
  }
})
