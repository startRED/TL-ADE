import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createGitPort } from '../src/git/gitport.ts'
import { applyReviewProofs, makeReviewCopy, readReviewProofs, removeReviewCopy } from '../src/review/scratch.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const dirs: Array<() => void> = []
afterEach(() => {
  for (const drop of dirs.splice(0)) drop()
})

// ADR 0047: o revisor roda comandos numa cópia descartável da árvore revisada, com node_modules, e nunca na worktree
// do maker; a cópia some no fim sem levar o node_modules do projeto junto.
test('copia_do_revisor_tem_a_arvore_revisada_com_node_modules_e_some_sem_tocar_o_projeto', async () => {
  const repo = makeRepo()
  dirs.push(() => removeRepo(repo.dir))
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'base\n')
  fs.writeFileSync(path.join(repo.dir, '.gitignore'), 'node_modules/\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'base'])
  fs.mkdirSync(path.join(repo.dir, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(repo.dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  // trabalho do maker, sem commit: arquivo mudado e arquivo novo
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'mudou\n')
  fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'novo\n')
  const wtPort = createGitPort({ worktreeDir: repo.dir })
  const tree = await wtPort.worktreeTree()

  const tmp = makeTmpDir('ade-review-copy-')
  dirs.push(() => removeTmpDir(tmp))
  const copy = path.join(tmp, 'r1')
  await makeReviewCopy({ wtPort, tree, repoDir: repo.dir, dir: copy })

  expect(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8')).toBe('mudou\n')
  expect(fs.readFileSync(path.join(copy, 'b.txt'), 'utf8')).toBe('novo\n')
  expect(fs.existsSync(path.join(copy, 'node_modules', 'dep', 'index.js'))).toBe(true)
  // o mesmo estado da worktree do maker: mesma árvore e o diff contra o HEAD visível
  const copyPort = createGitPort({ worktreeDir: copy })
  expect(await copyPort.worktreeTree()).toBe(tree)
  expect((await copyPort.dirtyPaths()).sort()).toEqual(['a.txt', 'b.txt'])

  // o revisor escreve na cópia; a worktree do maker não muda
  fs.writeFileSync(path.join(copy, 'a.txt'), 'revisor mexeu\n')
  expect(await wtPort.worktreeTree()).toBe(tree)

  await removeReviewCopy(wtPort, copy)
  expect(fs.existsSync(copy)).toBe(false)
  expect(fs.existsSync(path.join(repo.dir, 'node_modules', 'dep', 'index.js'))).toBe(true)
  expect(repo.git(['worktree', 'list'])).not.toContain('r1')
})

test('achado_que_bloqueia_sem_prova_executavel_e_rebaixado_e_com_prova_leva_o_comando_ao_maker', () => {
  const dir = makeTmpDir('ade-review-proofs-')
  dirs.push(() => removeTmpDir(dir))
  fs.writeFileSync(path.join(dir, 'F1.json'), JSON.stringify({ argv: ['node', 'tests/soma.test.mjs'], exit_code: 1, output: 'esperado 4, veio 5' }))
  fs.writeFileSync(path.join(dir, 'F3.json'), JSON.stringify({ argv: 'node x', exit_code: 1, output: '' }))
  fs.writeFileSync(path.join(dir, 'soma.test.mjs'), 'throw new Error()\n')
  const { refs, proofs } = readReviewProofs(dir)
  expect(refs).toEqual(['artifact:.ade-review/F1.json', 'artifact:.ade-review/F3.json', 'artifact:.ade-review/soma.test.mjs'])
  // argv que não é lista não é prova
  expect([...proofs.keys()]).toEqual(['artifact:.ade-review/F1.json'])

  const base = { category: 'patch', target_role: 'maker', location: 'src/soma.js', problem: 'soma errada', required_action: 'corrigir' }
  const { findings, demoted } = applyReviewProofs([
    { ...base, id: 'F1', severity: 'critical', evidence_refs: ['artifact:.ade-review/F1.json'] },
    { ...base, id: 'F2', severity: 'high', evidence_refs: ['file:src/soma.js#L1-L3'] },
    { ...base, id: 'F3', severity: 'medium', evidence_refs: ['artifact:.ade-review/F3.json'] },
    { ...base, id: 'F4', severity: 'low', evidence_refs: ['file:src/soma.js#L1-L3'] },
    { ...base, id: 'F5', severity: 'high', target_role: 'planner', evidence_refs: ['file:src/soma.js#L1-L3'] },
  ], proofs, '.ade/review/r1')
  expect(demoted).toEqual([{ id: 'F2', severity: 'high' }, { id: 'F3', severity: 'medium' }])
  expect(findings.map((f) => f.severity)).toEqual(['critical', 'low', 'low', 'low', 'high'])
  expect(findings[0].required_action).toContain('`node tests/soma.test.mjs` saiu 1')
  expect(findings[0].required_action).toContain('esperado 4, veio 5')
  expect(findings[0].required_action).toContain('.ade/review/r1/F1.json')
})
