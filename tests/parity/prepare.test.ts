import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { UnexpectedTreeStateError } from '../../src/journal/errors.js'
// Importações dos módulos da story (a implementar na fase 2)
import { prepareStory } from '../../src/engine/prepare.js'

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

// Cada prova deste arquivo dispara dezenas de subprocessos do Git; no Windows, com a suíte
// inteira em paralelo, isso passa dos 5s padrão. Opção de timeout em describe() não é herdada
// pelas provas no vitest 2.x, por isso o ajuste vale para o arquivo.
vi.setConfig({ testTimeout: 30_000 })

describe('prepare parity', () => {
  // AC1: Dado um repositório base com arquivo modificado fora de .ade/, quando prepareStory roda,
  // então devolve recusa com motivo de árvore suja, código de saída 2 e a lista dos caminhos sujos,
  // sem criar worktree.
  test('dirty_worktree_before_story_stops', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'committed.txt'), 'conteúdo commitado\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    // Exemplo: a.txt modificado no repositório base -> {status:'refused', reason:'dirty_worktree', exitCode:2, paths:['a.txt']}
    // e existsSync('<repo>/.ade/wt/s1') -> false
    writeFileSync(path.join(repo.dir, 'a.txt'), 'conteúdo sujo\n')

    const resDirty = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(resDirty).toEqual({
      status: 'refused',
      reason: 'dirty_worktree',
      exitCode: 2,
      paths: ['a.txt'],
    })

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    expect(existsSync(wtDir)).toBe(false)

    // Exemplo: arquivo sujo apenas em .ade/tmp.json -> resultado ready (o prefixo .ade/ é ignorado)
    rmSync(path.join(repo.dir, 'a.txt'))
    mkdirSync(path.join(repo.dir, '.ade'), { recursive: true })
    writeFileSync(path.join(repo.dir, '.ade', 'tmp.json'), '{"temp": true}\n')

    const resClean = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(resClean.status).toBe('ready')
    expect(existsSync(wtDir)).toBe(true)
  })

  // AC2: Dado um worktree da story já existente e com arquivo modificado dentro dele, quando prepareStory
  // roda de novo, então devolve recusa com motivo de sujeira na branch da unidade e código de saída 2.
  test('pre_existing_dirt_on_the_unit_branch_is_refused', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base commit'])

    // Primeiro preparo inicial: caminho limpo
    const res1 = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })
    expect(res1.status).toBe('ready')

    // Exemplo: worktree da story já criado e com b.txt modificado dentro dele
    // -> {status:'refused', reason:'dirty_unit_branch', exitCode:2, paths:['b.txt']}
    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    writeFileSync(path.join(wtDir, 'b.txt'), 'modificação no worktree\n')

    const res2 = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res2).toEqual({
      status: 'refused',
      reason: 'dirty_unit_branch',
      exitCode: 2,
      paths: ['b.txt'],
    })
  })

  // AC3: Dado um identificador de missão ou de story com barra, ponto duplo ou vazio, quando
  // prepareStory é chamado, então lança erro de tipo antes de tocar no disco.
  test('invalid_identifiers_are_rejected', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    // Exemplos:
    // prepareStory({repoDir, missionId:'m1', storyId:'../x'}) -> lança TypeError
    // prepareStory({repoDir:'', missionId:'m1', storyId:'s1'}) -> lança TypeError

    // storyId inválido (travessia, vazio, caracteres ilegais)
    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: '../x' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: '..' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: '' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: 's/1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: 's 1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: '.s1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm1', storyId: 's..1' })
    ).rejects.toThrow(TypeError)

    // repoDir vazio ou tipo não-string
    await expect(
      prepareStory({ repoDir: '', missionId: 'm1', storyId: 's1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({
        repoDir: 123 as unknown as string,
        missionId: 'm1',
        storyId: 's1',
      })
    ).rejects.toThrow(TypeError)

    // missionId inválido (vazio, barra, travessia, ponto inicial, ponto duplo interno)
    await expect(
      prepareStory({ repoDir: repo.dir, missionId: '', storyId: 's1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm/1', storyId: 's1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: '../m1', storyId: 's1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: '.m1', storyId: 's1' })
    ).rejects.toThrow(TypeError)

    await expect(
      prepareStory({ repoDir: repo.dir, missionId: 'm..1', storyId: 's1' })
    ).rejects.toThrow(TypeError)

    // Validação deve ocorrer antes de tocar no disco: nenhum diretório criado no caminho inexistente
    const nonExistentRepo = path.join(repo.dir, 'does-not-exist')
    await expect(
      prepareStory({ repoDir: nonExistentRepo, missionId: '', storyId: 's1' })
    ).rejects.toThrow(TypeError)
    expect(existsSync(nonExistentRepo)).toBe(false)
  })

  // AC4: Dado um repositório base limpo, quando prepareStory roda, então devolve estado pronto
  // com o diretório .ade/wt/<story> existente, a branch ade/<missão>/<story> criada e a árvore
  // inicial, e .git/info/exclude passa a conter a linha que exclui .ade/.
  test('prepare_creates_the_story_worktree_on_the_unit_branch', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo principal\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])
    const headCommit = repo.git(['rev-parse', 'HEAD']).trim()

    // Exemplo: repositório limpo, prepareStory({repoDir, missionId:'m1', storyId:'s1'})
    // -> {status:'ready', worktreeDir: '<repo>/.ade/wt/s1', branch:'ade/m1/s1', baseCommit:'<40 hex>', treeBefore:'<40 hex>'}
    const result = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    const expectedWtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    expect(result).toEqual({
      status: 'ready',
      worktreeDir: expectedWtDir,
      branch: 'ade/m1/s1',
      baseCommit: headCommit,
      treeBefore: expect.stringMatching(/^[0-9a-f]{40}$/),
      nodeModules: 'absent',
      prepareDependencyMs: expect.any(Number),
    })

    // Diretório .ade/wt/<story> existente
    expect(existsSync(expectedWtDir)).toBe(true)

    // Branch ade/<missionId>/<storyId> criada no git
    const branchList = repo.git(['branch', '--list', 'ade/m1/s1']).trim()
    expect(branchList).toContain('ade/m1/s1')

    // .git/info/exclude passa a conter a linha /.ade/
    const excludePath = path.join(repo.dir, '.git', 'info', 'exclude')
    expect(existsSync(excludePath)).toBe(true)
    const excludeContent = readFileSync(excludePath, 'utf8')
    expect(excludeContent).toContain('/.ade/')
  })

  // Prova para duas missões válidas com o mesmo storyId (revisão rodada 2)
  test('two_valid_missions_with_same_story_id_are_refused_when_worktree_exists', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo principal\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])

    const res1 = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })
    expect(res1.status).toBe('ready')

    // Worktree existente (.ade/wt/s1) pertence à branch ade/m1/s1;
    // chamada para ade/m2/s1 deve recusar com UnexpectedTreeStateError
    await expect(
      prepareStory({
        repoDir: repo.dir,
        missionId: 'm2',
        storyId: 's1',
      })
    ).rejects.toThrow(UnexpectedTreeStateError)
  })

  // AC2: Dado uma branch ade/<missão>/<story> com um commit que não está no HEAD base,
  // quando prepareStory roda, então devolve espera pelo operador com motivo de branch obsoleta
  // e código de saída 3, sem criar o worktree.
  test('stale_unit_branch_with_foreign_commits_waits_for_operator', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])

    repo.git(['branch', 'ade/m1/s1'])
    repo.git(['checkout', 'ade/m1/s1'])
    writeFileSync(path.join(repo.dir, 'foreign.txt'), 'conteúdo estrangeiro\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit na story'])
    repo.git(['checkout', 'main'])

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res).toEqual({
      status: 'awaiting_operator',
      reason: 'stale_branch',
      exitCode: 3,
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
    })
    expect(existsSync(wtDir)).toBe(false)
  })

  // AC4: Dado uma branch ade/<missão>/<story> preexistente, já contida no HEAD base e livre,
  // quando prepareStory roda, então devolve estado pronto reaproveitando essa branch, sem tentar recriá-la.
  test('ancestor_unit_branch_is_reused', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])
    const headCommit = repo.git(['rev-parse', 'HEAD']).trim()

    repo.git(['branch', 'ade/m1/s1'])

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res).toEqual({
      status: 'ready',
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
      baseCommit: headCommit,
      treeBefore: expect.stringMatching(/^[0-9a-f]{40}$/),
      nodeModules: 'absent',
      prepareDependencyMs: expect.any(Number),
    })
    expect(existsSync(wtDir)).toBe(true)

    const wtBranch = repo.git(['-C', wtDir, 'symbolic-ref', '--short', 'HEAD']).trim()
    expect(wtBranch).toBe('ade/m1/s1')
  })

  // AC3: Dado que essa branch já está checkoutada em outro worktree, quando prepareStory roda,
  // então devolve espera pelo operador com motivo de branch em uso e código de saída 3.
  test('unit_branch_checked_out_elsewhere_waits_for_operator', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])

    const other = mkdtempSync(path.join(os.tmpdir(), 'ade-other-'))
    tmpDirs.push(other)
    rmSync(other, { recursive: true, force: true })
    repo.git(['worktree', 'add', '-b', 'ade/m1/s1', other])

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res).toEqual({
      status: 'awaiting_operator',
      reason: 'branch_in_use',
      exitCode: 3,
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
    })
    expect(existsSync(wtDir)).toBe(false)
  })

  // Regressão (rodada 3): uma tag homônima da branch não pode desviar a checagem de
  // ancestralidade nem a escolha da branch usada no `worktree add`.
  test('ancestor_unit_branch_is_reused_despite_homonymous_tag', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])
    const headCommit = repo.git(['rev-parse', 'HEAD']).trim()

    // Cria um commit estrangeiro (não ancestral do HEAD base) e marca uma tag com o
    // mesmo nome que a branch da unidade vai ter.
    repo.git(['checkout', '-b', 'tmp/foreign'])
    writeFileSync(path.join(repo.dir, 'foreign.txt'), 'conteúdo estrangeiro\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit estrangeiro'])
    const foreignCommit = repo.git(['rev-parse', 'HEAD']).trim()
    repo.git(['checkout', 'main'])
    repo.git(['tag', 'ade/m1/s1', foreignCommit])
    repo.git(['branch', '-D', 'tmp/foreign'])

    // Cria a branch local homônima, ancestral do HEAD base (deve ser a única considerada).
    repo.git(['branch', 'ade/m1/s1', headCommit])

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res).toEqual({
      status: 'ready',
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
      baseCommit: headCommit,
      treeBefore: expect.stringMatching(/^[0-9a-f]{40}$/),
      nodeModules: 'absent',
      prepareDependencyMs: expect.any(Number),
    })
    expect(existsSync(wtDir)).toBe(true)

    // Usa a forma completa: com a tag homônima, `--short` fica ambíguo ('heads/ade/m1/s1').
    const wtBranch = repo.git(['-C', wtDir, 'symbolic-ref', 'HEAD']).trim()
    expect(wtBranch).toBe('refs/heads/ade/m1/s1')
    expect(existsSync(path.join(wtDir, 'foreign.txt'))).toBe(false)
  })
})
