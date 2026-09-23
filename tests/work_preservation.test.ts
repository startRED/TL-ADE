import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createGitPort } from '../src/git/gitport.ts'
import { preserveInterruptedTree, removeWorktreeKept, treeBelongs } from '../src/engine/preserve.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeRepo(d)
})

function repoWithBase() {
  const repo = makeRepo()
  dirs.push(repo.dir)
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, rel), body)
  }
  write('src/a.ts', 'export const a = 1\n')
  write('proto/demo.mjs', 'demo\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'base'])
  const base = repo.git(['rev-parse', 'HEAD']).trim()
  const baseTree = repo.git(['rev-parse', 'HEAD^{tree}']).trim()
  return { repo, write, base, baseTree, port: createGitPort({ worktreeDir: repo.dir }) }
}

const refTree = (repo: { git(args: string[]): string }, ref: string) => repo.git(['rev-parse', `${ref}^{tree}`]).trim()

describe('trabalho de uma parte nunca se perde', () => {
  test('diff_against_commit_base_includes_staged_unstaged_and_committed', async () => {
    const { repo, write, base, port } = repoWithBase()
    // quem escreve commitou no meio: HEAD andou, o commit-base da parte não
    write('src/committed.ts', 'export const c = 1\n')
    repo.git(['add', 'src/committed.ts'])
    repo.git(['commit', '-m', 'maker'])
    write('src/staged.ts', 'export const s = 1\n')
    repo.git(['add', 'src/staged.ts'])
    write('src/a.ts', 'export const a = 2\n')

    expect(await port.dirtyPaths(base)).toEqual(['src/a.ts', 'src/committed.ts', 'src/staged.ts'])
    // contra HEAD o commit do meio some: é por isso que a parte mede contra o commit-base
    expect(await port.dirtyPaths()).toEqual(['src/a.ts', 'src/staged.ts'])
  })

  test('diff_with_invalid_base_fails_closed', async () => {
    const { port } = repoWithBase()
    await expect(port.dirtyPaths('--output=x')).rejects.toThrow()
    await expect(port.dirtyPaths('0000000000000000000000000000000000000000')).rejects.toThrow()
  })

  test('restoring_discarded_tree_resets_index_without_extra_staged_files', async () => {
    const { repo, write, baseTree, port } = repoWithBase()
    write('src/a.ts', 'export const a = 2\n')
    write('src/novo.ts', 'export const n = 1\n')
    const discarded = await port.worktreeTree()
    await port.restoreTree(baseTree, { label: 'r1' })

    write('src/extra.ts', 'export const x = 1\n')
    repo.git(['add', 'src/extra.ts'])
    await port.restoreTree(discarded, { label: 'recover' })

    expect(repo.git(['write-tree']).trim()).toBe(discarded)
    expect(repo.git(['ls-files']).trim().split('\n')).toEqual(['proto/demo.mjs', 'src/a.ts', 'src/novo.ts'])
    expect(repo.git(['diff', '--name-only']).trim()).toBe('')
    expect(fs.existsSync(path.join(repo.dir, 'src/extra.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(repo.dir, 'src/novo.ts'), 'utf8')).toBe('export const n = 1\n')
  })

  test('every_path_that_cleans_the_worktree_keeps_previous_tree_under_refs_ade', async () => {
    // rodada rejeitada
    {
      const { repo, write, baseTree, port } = repoWithBase()
      write('src/a.ts', 'export const a = 9\n')
      const before = await port.worktreeTree()
      const { discardedRef } = await port.restoreTree(baseTree, { label: 'gate-g1' })
      expect(discardedRef.startsWith('refs/ade/')).toBe(true)
      expect(refTree(repo, discardedRef)).toBe(before)

      // gc: a ref segura os objetos depois de `git gc --prune=now`
      repo.git(['gc', '--prune=now', '--quiet'])
      expect(refTree(repo, discardedRef)).toBe(before)
      expect(repo.git(['show', `${discardedRef}:src/a.ts`])).toBe('export const a = 9\n')
    }
    // retomada com árvore alheia (arquivo proibido)
    {
      const { repo, write, baseTree, port } = repoWithBase()
      write('proto/demo.mjs', 'mexido\n')
      const before = await port.worktreeTree()
      const kept = await preserveInterruptedTree({
        gitPort: port, treeBefore: baseTree, label: 'interrupted/S1', scope: ['src/**'], blocked: ['proto/**'],
      })
      expect(kept.ref?.startsWith('refs/ade/')).toBe(true)
      expect(refTree(repo, kept.ref as string)).toBe(before)
    }
    // falha: worktree da parte removida
    {
      const { repo, port } = repoWithBase()
      const wtDir = path.join(repo.dir, '.ade', 'wt', 'S2')
      repo.git(['worktree', 'add', '-b', 'ade/m/S2', wtDir, 'HEAD'])
      fs.writeFileSync(path.join(wtDir, 'src', 'a.ts'), 'export const a = 7\n')
      fs.writeFileSync(path.join(wtDir, 'src', 'b.ts'), 'export const b = 1\n')
      const wtPort = createGitPort({ worktreeDir: wtDir })
      const before = await wtPort.worktreeTree()
      const ref = await removeWorktreeKept({ gitPort: port, wtPort, worktreeDir: wtDir, label: 'removed/S2' })
      expect(fs.existsSync(wtDir)).toBe(false)
      expect(ref.startsWith('refs/ade/')).toBe(true)
      expect(refTree(repo, ref)).toBe(before)
    }
  }, 60_000)

  test('interrupted_part_keeps_scoped_tree_and_only_stores_do_not_touch_changes', async () => {
    // só dentro de scope_paths: guardada e reaplicada
    {
      const { repo, write, baseTree, port } = repoWithBase()
      write('src/a.ts', 'export const a = 3\n')
      write('src/novo.ts', 'export const n = 1\n')
      repo.git(['add', 'src/novo.ts'])
      const before = await port.worktreeTree()
      const kept = await preserveInterruptedTree({
        gitPort: port, treeBefore: baseTree, label: 'interrupted/S3', scope: ['src/**'], blocked: ['proto/**'],
      })
      expect(kept).toMatchObject({ reapplied: true, files: ['src/a.ts', 'src/novo.ts'] })
      expect(refTree(repo, kept.ref as string)).toBe(before)
      expect(await port.worktreeTree()).toBe(before)
      expect(fs.readFileSync(path.join(repo.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 3\n')
    }
    // toca do_not_touch: guardada numa ref, não reaplicada
    {
      const { repo, write, baseTree, port } = repoWithBase()
      write('src/a.ts', 'export const a = 4\n')
      write('proto/demo.mjs', 'mexido\n')
      const before = await port.worktreeTree()
      const kept = await preserveInterruptedTree({
        gitPort: port, treeBefore: baseTree, label: 'interrupted/S4', scope: ['src/**'], blocked: ['proto/**'],
      })
      expect(kept.reapplied).toBe(false)
      expect(refTree(repo, kept.ref as string)).toBe(before)
      expect(await port.worktreeTree()).toBe(baseTree)
      expect(fs.readFileSync(path.join(repo.dir, 'proto/demo.mjs'), 'utf8')).toBe('demo\n')
    }
    // árvore limpa: nada a guardar
    {
      const { baseTree, port } = repoWithBase()
      const kept = await preserveInterruptedTree({
        gitPort: port, treeBefore: baseTree, label: 'interrupted/S5', scope: ['src/**'], blocked: [],
      })
      expect(kept).toEqual({ files: [], ref: null, reapplied: false })
    }
  }, 60_000)

  test('tree_belongs_rules', () => {
    const scope = ['src/intent/**'], blocked = ['proto/**']
    expect(treeBelongs(['src/intent/a.ts'], { scope, blocked })).toBe(true)
    expect(treeBelongs(['src/intent/a.ts', 'src/mission/b.ts'], { scope, blocked })).toBe(false)
    expect(treeBelongs(['src/intent/a.ts', 'src/mission/b.ts'], { scope, blocked, interrupted: true })).toBe(true)
    expect(treeBelongs(['src/intent/a.ts', 'proto/server.mjs'], { scope, blocked, interrupted: true })).toBe(false)
    expect(treeBelongs(['x.ts'], { scope: [] })).toBe(false)
  })
})
