import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { contain } from '../src/contain/contain.js'
import { createGitPort } from '../src/git/gitport.js'
import { makeRepo, removeRepo } from './helpers/git-repo.js'

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

describe('contain integrity', () => {
  // AC4: Dado um limite de buffer menor que a saída do git, quando contain roda,
  // então falha com estado inesperado em vez de varrer uma saída truncada.
  test('contain_treats_maxbuffer_truncation_as_state_integrity', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    const targetFile = path.join(srcDir, 'payload.txt')

    // Commit base inicial
    writeFileSync(targetFile, 'base line 0\n')
    const initialCommit = await port.commit({ message: 'commit base' })

    // Gera um diff de aproximadamente 5.000 bytes
    const fillerLines = Array.from(
      { length: 100 },
      (_, i) => `linha modificada para preenchimento de teste ${String(i).padStart(4, '0')} texto longo de preenchimento\n`,
    ).join('')
    writeFileSync(targetFile, fillerLines)

    // contain({ ..., diffMaxBuffer: 1024 }) com diff de ~5.000 bytes -> rejeita com código 'unexpected_tree_state'
    await expect(
      contain({
        git: port,
        unitId: 'S10',
        treeBefore: initialCommit.tree,
        scopePaths: ['src/**'],
        diffMaxBuffer: 1024,
      }),
    ).rejects.toMatchObject({
      code: 'unexpected_tree_state',
    })
  })
})
