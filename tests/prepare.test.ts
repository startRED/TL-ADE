import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { prepareStory } from '../src/engine/prepare.ts'

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

// Provas que criam repositório e worktree de verdade disparam dezenas de subprocessos do Git;
// no Windows, com a suíte em paralelo, elas passam dos 5s padrão. O teto maior vale só para
// essas provas (opção de timeout em describe() não é herdada no vitest 2.x), não para o arquivo.
const slowTest = (name: string, fn: () => Promise<void>) => test(name, fn, 30_000)

describe('prepare', () => {
  // AC1: Dado um worktree da story contendo .ade/takeover.json, quando prepareStory roda,
  // então devolve espera pelo operador com motivo de takeover aberto e código de saída 3,
  // sem despachar nada.
  slowTest('dispatch_into_open_takeover_is_refused', async () => {
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

  // AC1: Dado repositório base e worktree com package-lock.json idênticos e node_modules
  // presente só na base, quando prepareStory roda, então o worktree passa a enxergar os
  // arquivos de node_modules da base, o resultado diz que o vínculo foi criado e traz a duração em milissegundos.
  slowTest('prepare_links_node_modules_when_lockfile_matches', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, '.gitignore'), 'node_modules/\n')
    const lockContent = JSON.stringify({ name: 'test-pkg', lockfileVersion: 3 })
    writeFileSync(path.join(repo.dir, 'package-lock.json'), lockContent)
    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo principal\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base com lockfile'])

    mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'node_modules', 'marker.txt'), 'ok')

    try {
      const res = await prepareStory({
        repoDir: repo.dir,
        missionId: 'm1',
        storyId: 's1',
      })

      expect(res.status).toBe('ready')
      if (res.status === 'ready') {
        expect(res.nodeModules).toBe('linked')
        expect(typeof res.prepareDependencyMs).toBe('number')
        expect(res.prepareDependencyMs).toBeGreaterThanOrEqual(0)

        const markerPath = path.join(res.worktreeDir, 'node_modules', 'marker.txt')
        expect(existsSync(markerPath)).toBe(true)
        expect(readFileSync(markerPath, 'utf8')).toBe('ok')

        const excludePath = path.join(repo.dir, '.git', 'info', 'exclude')
        expect(existsSync(excludePath)).toBe(true)
        const excludeContent = readFileSync(excludePath, 'utf8')
        expect(excludeContent).toContain('/node_modules')
      }
    } catch (err: any) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        throw new Error(
          `Falha de privilégio do sistema de arquivos ao criar junção/symlink: ${err.message}`,
        )
      }
      throw err
    }
  })

  // AC2: Dado um package-lock.json que existe só no repositório base (commitado depois da branch da unidade),
  // quando prepareStory roda, então devolve espera pelo operador com motivo de ambiente e código de saída 3,
  // sem instalar nada e sem criar vínculo.
  slowTest('divergent_lockfile_waits_for_operator', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, '.gitignore'), 'node_modules/\n')
    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo inicial sem lockfile\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base sem lockfile'])

    // Branch da unidade criada quando o repositório ainda não tinha lockfile
    repo.git(['branch', 'ade/m1/s1'])

    // package-lock.json commitado depois só no repositório base (main)
    writeFileSync(
      path.join(repo.dir, 'package-lock.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0' }),
    )
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit lockfile só na main'])

    // node_modules existe na base com arquivo marcador
    mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'node_modules', 'base-only.txt'), 'base\n')

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res).toEqual({
      status: 'awaiting_operator',
      reason: 'environment',
      exitCode: 3,
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
    })

    // Nenhum vínculo ou instalação de dependências criado no worktree
    expect(existsSync(path.join(wtDir, 'node_modules'))).toBe(false)
  })

  // Lockfiles com conteúdos divergentes em ambos os lados
  slowTest('different_lockfile_contents_waits_for_operator', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, '.gitignore'), 'node_modules/\n')
    writeFileSync(
      path.join(repo.dir, 'package-lock.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0' }),
    )
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit lockfile A'])

    repo.git(['branch', 'ade/m1/s1'])

    writeFileSync(
      path.join(repo.dir, 'package-lock.json'),
      JSON.stringify({ name: 'test-pkg', version: '2.0.0' }),
    )
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit lockfile B na main'])

    mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'node_modules', 'base-only.txt'), 'base\n')

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(res).toEqual({
      status: 'awaiting_operator',
      reason: 'environment',
      exitCode: 3,
      worktreeDir: wtDir,
      branch: 'ade/m1/s1',
    })
    expect(existsSync(path.join(wtDir, 'node_modules'))).toBe(false)
  })

  // AC3: Dado nenhum package-lock.json nos dois lados, quando prepareStory roda,
  // então devolve estado pronto informando ausência de dependências vinculadas,
  // mesmo que já exista um node_modules no worktree.
  slowTest('no_lockfile_reports_absent_even_if_node_modules_exists_in_worktree', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, '.gitignore'), 'node_modules/\n')
    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo sem lockfile\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial sem lockfile'])

    const first = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })
    expect(first.status).toBe('ready')

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    mkdirSync(path.join(wtDir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(wtDir, 'node_modules', 'local.txt'), 'conteúdo local\n')

    const second = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(second.status).toBe('ready')
    if (second.status === 'ready') {
      expect(second.nodeModules).toBe('absent')
      expect(typeof second.prepareDependencyMs).toBe('number')
      expect(readFileSync(path.join(wtDir, 'node_modules', 'local.txt'), 'utf8')).toBe(
        'conteúdo local\n',
      )
    }
  })

  // AC4: Dado lockfiles iguais e um node_modules real já existente dentro do worktree,
  // quando prepareStory roda, então o conteúdo desse diretório permanece intacto,
  // nada é acrescentado ao exclude e o resultado informa que ele já estava presente.
  slowTest('pre_existing_node_modules_in_worktree_is_preserved_when_lockfiles_match', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, '.gitignore'), 'node_modules/\n')
    const lockContent = JSON.stringify({ name: 'test-pkg', lockfileVersion: 3 })
    writeFileSync(path.join(repo.dir, 'package-lock.json'), lockContent)
    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit com lockfile'])

    const first = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })
    expect(first.status).toBe('ready')

    const wtDir = path.join(repo.dir, '.ade', 'wt', 's1')
    mkdirSync(path.join(wtDir, 'node_modules'), { recursive: true })
    writeFileSync(
      path.join(wtDir, 'node_modules', 'local.txt'),
      'conteúdo do worktree preservado\n',
    )

    mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'node_modules', 'base.txt'), 'conteúdo da base\n')

    const second = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
    })

    expect(second.status).toBe('ready')
    if (second.status === 'ready') {
      expect(second.nodeModules).toBe('already_present')
      expect(typeof second.prepareDependencyMs).toBe('number')

      expect(
        readFileSync(path.join(wtDir, 'node_modules', 'local.txt'), 'utf8'),
      ).toBe('conteúdo do worktree preservado\n')
      expect(existsSync(path.join(wtDir, 'node_modules', 'base.txt'))).toBe(false)

      const excludePath = path.join(repo.dir, '.git', 'info', 'exclude')
      const excludeContent = readFileSync(excludePath, 'utf8')
      expect(excludeContent).not.toContain('/node_modules')
    }
  })

  slowTest('prepare_reserva_uma_rodada_para_fqe_e_para_quando_esgotado', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const res = await prepareStory({
      repoDir: repo.dir,
      missionId: 'm1',
      storyId: 's1',
      contract: {
        needs_ui: true,
        budget: { max_rework_rounds: 0 },
      },
    } as any)

    expect(res.status).toBe('awaiting_operator')
    expect((res as any).reason).toBe('visual_rework_budget_exhausted')
  })
})
