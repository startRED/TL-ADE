import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createGitPort } from '../src/git/gitport.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

const repos: string[] = []
afterEach(() => {
  for (const d of repos.splice(0)) removeRepo(d)
})

// 25/09, missão real de anexos: o maker commitou o próprio trabalho, o commit do motor não tinha nada a gravar e o
// git commit saiu com 1; a parte aprovada caiu com crash. Sem nada novo, a entrega fica no HEAD que ele deixou.
test('commit_sem_nada_novo_entrega_o_head_em_vez_de_falhar', async () => {
  const repo = makeRepo()
  repos.push(repo.dir)
  writeFileSync(path.join(repo.dir, 'a.txt'), 'um\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'feito pelo maker'])
  const head = repo.git(['rev-parse', 'HEAD']).trim()

  const res = await createGitPort({ worktreeDir: repo.dir }).commit({ message: 'ade(S1): parte' })
  expect(res.commit).toBe(head)

  writeFileSync(path.join(repo.dir, 'b.txt'), 'dois\n')
  const next = await createGitPort({ worktreeDir: repo.dir }).commit({ message: 'ade(S2): parte' })
  expect(next.commit).not.toBe(head)
  expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('ade(S2): parte')
})
