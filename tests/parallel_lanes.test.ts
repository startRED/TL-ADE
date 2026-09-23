import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createGitPort } from '../src/git/gitport.ts'
import { prepareStory } from '../src/engine/prepare.ts'
import { laneCandidates, laneLimit, lanesDir, overlaps } from '../src/engine/lanes.ts'
import { runUnattendedBatch } from '../src/engine/loop.ts'
import { openJournal } from '../src/journal/journal.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeRepo(d)
})
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}

const story = (id: string, scope: string[], depends_on: string[] = []) => ({
  id,
  depends_on,
  contract: { guardrails: { scope_paths: scope } },
})

describe('trilhos paralelos em cópias isoladas', () => {
  test('independent_disjoint_stories_dispatch_together_up_to_limit', () => {
    const stories = [
      story('S1', ['src/a/**', 'tests/a.test.ts']),
      story('S2', ['src/b/**', 'tests/b.test.ts']),
      story('S3', ['src/c/**', 'tests/c.test.ts']),
    ]
    expect(laneCandidates(stories, {}, [], 2).map((s) => s.id)).toEqual(['S1', 'S2'])
    expect(laneCandidates(stories, {}, [], 3).map((s) => s.id)).toEqual(['S1', 'S2', 'S3'])
    // um trilho ocupado conta contra o limite e sai da escolha
    expect(laneCandidates(stories, {}, [stories[0]], 2).map((s) => s.id)).toEqual(['S2'])
    // dependência não concluída segura a parte
    const dep = [story('S1', ['src/a/**']), story('S2', ['src/b/**'], ['S1'])]
    expect(laneCandidates(dep, {}, [], 2).map((s) => s.id)).toEqual(['S1'])
    expect(laneCandidates(dep, { S1: { status: 'completed' } }, [], 2).map((s) => s.id)).toEqual(['S2'])
  })

  test('overlapping_scope_or_same_test_file_runs_serially', () => {
    expect(overlaps(['src/engine/**'], ['src/engine/lanes.ts'])).toBe(true)
    expect(overlaps(['src/a.ts', 'tests/x.test.ts'], ['src/b.ts', 'tests/x.test.ts'])).toBe(true)
    expect(overlaps(['**/*.ts'], ['docs/a.md'])).toBe(true)
    expect(overlaps(['src/a/**'], ['src/b/**'])).toBe(false)

    const shared = [story('S1', ['src/a.ts', 'tests/x.test.ts']), story('S2', ['src/b.ts', 'tests/x.test.ts'])]
    expect(laneCandidates(shared, {}, [], 2).map((s) => s.id)).toEqual(['S1'])
    expect(laneCandidates(shared, {}, [shared[0]], 2)).toEqual([])
    // parte sem escopo declarado nunca divide trilho
    const bare = [story('S1', ['src/a.ts']), { id: 'S2', contract: {} }]
    expect(laneCandidates(bare, {}, [], 2).map((s) => s.id)).toEqual(['S1'])
    expect(() => laneCandidates(bare, {}, [], 0)).toThrow()
  })

  test('discarding_one_lane_tree_leaves_other_lane_worktree_untouched', async () => {
    const repo = makeRepo()
    dirs.push(repo.dir)
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'b\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base'])
    const env = { ADE_HOME: tmp('ade-home-') }
    const worktreesDir = lanesDir(repo.dir, env)

    const l1 = await prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: 'S1', worktreesDir })
    const l2 = await prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: 'S2', worktreesDir })
    if (l1.status !== 'ready' || l2.status !== 'ready') throw new Error('trilho não preparado')
    expect(path.dirname(l1.worktreeDir)).toBe(worktreesDir)
    expect(path.dirname(l2.worktreeDir)).toBe(worktreesDir)

    fs.writeFileSync(path.join(l1.worktreeDir, 'a.txt'), 'a1\n')
    fs.writeFileSync(path.join(l2.worktreeDir, 'b.txt'), 'b2\n')
    fs.writeFileSync(path.join(l2.worktreeDir, 'novo.txt'), 'n\n')
    const p2 = createGitPort({ worktreeDir: l2.worktreeDir })
    const tree2 = await p2.worktreeTree()

    const p1 = createGitPort({ worktreeDir: l1.worktreeDir })
    const restored = await p1.restoreTree(l1.treeBefore, { label: 'S1' })
    expect(restored.discardedRef).toMatch(/^refs\/ade\/discarded\/S1\//)
    expect(fs.readFileSync(path.join(l1.worktreeDir, 'a.txt'), 'utf8')).toBe('a\n')

    expect(await p2.worktreeTree()).toBe(tree2)
    expect(fs.readFileSync(path.join(l2.worktreeDir, 'b.txt'), 'utf8')).toBe('b2\n')
    expect(fs.readFileSync(path.join(l2.worktreeDir, 'novo.txt'), 'utf8')).toBe('n\n')
    expect(repo.git(['status', '--porcelain'])).toBe('')
    for (const l of [l1, l2]) repo.git(['worktree', 'remove', '--force', l.worktreeDir])
  })

  test('engine_code_never_invokes_git_stash', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|js|mjs)$/.test(e.name) && !p.includes('vendor')) {
          if (/git\s+stash|['"`]stash['"`]/.test(fs.readFileSync(p, 'utf8'))) hits.push(p)
        }
      }
    }
    walk(path.join(import.meta.dirname, '..', 'src'))
    expect(hits).toEqual([])
    expect(typeof laneCandidates).toBe('function')
  })

  test('lanes_state_dir_resolves_outside_project_root_and_served_folders', () => {
    const home = tmp('ade-home-')
    const repoDir = tmp('ade-proj-')
    const dir = lanesDir(repoDir, { ADE_HOME: home })
    expect(dir.startsWith(path.join(home, '.ade', 'lanes') + path.sep)).toBe(true)
    const rel = path.relative(repoDir, dir)
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true)
    // pasta servida do painel mora dentro da raiz: fora da raiz é fora dela também
    expect(path.relative(path.join(repoDir, 'packages', 'web'), dir).startsWith('..')).toBe(true)
    // projetos distintos não dividem pasta de trilhos
    expect(lanesDir(tmp('ade-proj-'), { ADE_HOME: home })).not.toBe(dir)
    // ADE_HOME dentro do projeto poria os trilhos sob o dev server: recusa
    expect(() => lanesDir(repoDir, { ADE_HOME: repoDir })).toThrow()
  })

  test('lane_limit_defaults_to_one_and_rejects_invalid_values', () => {
    expect(laneLimit({})).toBe(1)
    expect(laneLimit({ ADE_MAX_LANES: '3' })).toBe(3)
    for (const bad of ['0', '-1', '1.5', 'dois', '']) expect(() => laneLimit({ ADE_MAX_LANES: bad })).toThrow()
  })

  test('unattended_batch_runs_disjoint_stories_concurrently_in_lanes_dir', async () => {
    const repoDir = tmp('ade-proj-')
    const missionDir = path.join(repoDir, '.ade', 'missions', 'm1')
    fs.mkdirSync(missionDir, { recursive: true })
    const journal = openJournal({ missionDir, runtimeStamp: '1:abc123:def456' })
    const env = { ADE_HOME: tmp('ade-home-'), ADE_MAX_LANES: '2' }
    const stories = [story('S1', ['src/a/**']), story('S2', ['src/b/**']), story('S3', ['src/a/x.ts'])]
    let active = 0
    let peak = 0
    const order: string[] = []
    const worktreesDirs: Array<string | undefined> = []
    const prepareStory = async (o: { worktreesDir?: string }) => { worktreesDirs.push(o.worktreesDir); return {} }
    const runStory = async (deps: { prepareStory: typeof prepareStory }, { story: s }: { story: { id: string } }) => {
      active++
      peak = Math.max(peak, active)
      order.push(`start:${s.id}`)
      await deps.prepareStory({})
      await new Promise((r) => setTimeout(r, 20))
      active--
      order.push(`end:${s.id}`)
      return { status: 'committed', exitCode: 0, reason: null, commit: 'c' }
    }
    const loaded = { stories, missionBudget: {}, plan: {} } as never
    const res = await runUnattendedBatch({ journal, runStory, prepareStory, env }, { loaded, repoDir, missionDir })
    await journal.close()
    expect(res.completedStories.sort()).toEqual(['S1', 'S2', 'S3'])
    expect(peak).toBe(2)
    // S3 divide escopo com S1: só começa depois que S1 termina
    expect(order.indexOf('start:S3')).toBeGreaterThan(order.indexOf('end:S1'))
    expect(worktreesDirs).toEqual([lanesDir(repoDir, env), lanesDir(repoDir, env), lanesDir(repoDir, env)])
  })
})
