import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeRepo, removeRepo } from './helpers/git-repo.js'
import { prepareStory } from '../src/engine/prepare.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      removeRepo(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

describe('prepare', () => {
  // AC1: Dado um worktree da story contendo .ade/takeover.json, quando prepareStory roda,
  // então devolve espera pelo operador com motivo de takeover aberto e código de saída 3,
  // sem despachar nada.
  test('dispatch_into_open_takeover_is_refused', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo principal\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])

    const first = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })
    expect(first.status).toBe('ready')

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    expect(existsSync(wtDir)).toBe(true)

    // Grava takeover.json dentro do worktree
    mkdirSync(path.join(wtDir, '.ade'), { recursive: true })
    writeFileSync(
      path.join(wtDir, '.ade', 'takeover.json'),
      JSON.stringify({ reason: 'human takeover' }),
      'utf8',
    )

    // Exemplo: worktree com .ade/takeover.json -> {status:'awaiting_operator', reason:'takeover_open', exitCode:3, worktreeDir:'<repo>/.ade/wt/s1', branch:'ade/m1/s1'}
    const second = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(second).toEqual({
      status: 'awaiting_operator',
      reason: 'takeover_open',
      exitCode: 3,
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
    })

    // Exemplo de precedência: repositório base sujo e worktree com takeover.json ao mesmo tempo
    // -> vence a precedência: {status:'refused', reason:'dirty_worktree', exitCode:2, paths:['dirty.txt']}
    writeFileSync(path.join(repo.dir, 'dirty.txt'), 'conteúdo sujo\n')

    const third = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(third).toEqual({
      status: 'refused',
      reason: 'dirty_worktree',
      exitCode: 2,
      paths: ['dirty.txt'],
    })
  })
})
