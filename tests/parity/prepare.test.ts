import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
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
})
