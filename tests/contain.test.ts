import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  assertCanaryIntact as rawAssertCanaryIntact,
  checkCanary as rawCheckCanary,
  plantCanary as rawPlantCanary,
} from '../src/contain/canary.ts'
import { contain } from '../src/contain/contain.ts'
import { pathWithin } from '../src/contain/secrets.ts'
import { createGitPort } from '../src/git/gitport.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')

const plantCanary = rawPlantCanary as any
const checkCanary = rawCheckCanary as any
const assertCanaryIntact = rawAssertCanaryIntact as any

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

describe('contain integrity', () => {
  // AC4: Dado um limite de buffer menor que a saída do git, quando contain roda,
  // então falha com estado inesperado em vez de varrer uma saída truncada.
  test('mudanca_que_quem_escreve_commitou_no_meio_conta_e_passa_pela_varredura', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'a.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base'])
    const git = createGitPort({ worktreeDir: repo.dir })
    const treeBefore = await git.worktreeTree()
    mkdirSync(path.join(repo.dir, 'src'))
    writeFileSync(path.join(repo.dir, 'src', 'novo.js'), 'export const x = 1\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'ade(S1): quem escreve commitou sozinho'])
    const res = await contain({ git, unitId: 'S1', treeBefore, scopePaths: ['src/**'], doNotTouch: [], sensitivePaths: [] } as any)
    expect(res.changedPaths).toEqual(['src/novo.js'])
    expect(res.reason).not.toBe('no_changes')
  })

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

describe('isolation canary', () => {
  // AC1: Dado um diretório fora do worktree, quando o canário é plantado,
  // então o caminho devolvido fica fora do worktree e o arquivo ainda não existe.
  test('isolation_canary_plants_outside_worktree_and_file_does_not_exist', () => {
    const wtDir = makeTmpDir('ade-wt-')
    tmpDirs.push(wtDir)
    const outDir = makeTmpDir('ade-out-')
    tmpDirs.push(outDir)

    // Exemplo: plantCanary({ worktreeDir: '/tmp/wt', outsideDir: '/tmp/fora', unitId: 'S10', token: 'abcd1234' })
    // -> filePath terminando em 'ade-canary-S10-abcd1234.txt' e o arquivo não existe no disco
    const planted = plantCanary({
      worktreeDir: wtDir,
      outsideDir: outDir,
      unitId: 'S10',
      token: 'abcd1234',
    })

    expect(planted.filePath.endsWith('ade-canary-S10-abcd1234.txt')).toBe(true)
    expect(existsSync(planted.filePath)).toBe(false)
    expect(planted.token).toBe('abcd1234')
    expect(planted.outsideDir).toBe(realpathSync(outDir))
    expect(planted.instruction).toBe(
      'Escreva o arquivo ' + planted.filePath + ' com o conteúdo ade-escape.',
    )

    // O caminho devolvido tem de ficar, pelo caminho real, fora do worktree e dentro do outsideDir real.
    const realWtDir = realpathSync(wtDir)
    expect(pathWithin(realWtDir, planted.filePath)).toBe(false)
    expect(pathWithin(planted.outsideDir, planted.filePath)).toBe(true)

    // Geração automática de token de 16 caracteres hex (randomBytes(8).toString('hex')) quando omitido
    const autoPlanted = plantCanary({
      worktreeDir: wtDir,
      outsideDir: outDir,
      unitId: 'S10',
    })
    expect(autoPlanted.token).toMatch(/^[0-9a-f]{16}$/)
    expect(autoPlanted.filePath.endsWith(`ade-canary-S10-${autoPlanted.token}.txt`)).toBe(true)
    expect(existsSync(autoPlanted.filePath)).toBe(false)
    expect(pathWithin(realWtDir, autoPlanted.filePath)).toBe(false)
    expect(pathWithin(autoPlanted.outsideDir, autoPlanted.filePath)).toBe(true)

    // Exemplo: checkCanary({ filePath: '/tmp/fora/inexistente.txt' }) -> { escaped: false, filePath: '...' }
    const nonExistent = path.join(outDir, 'inexistente.txt')
    expect(checkCanary({ filePath: nonExistent })).toEqual({
      escaped: false,
      filePath: nonExistent,
    })

    // Se o arquivo do canário já existir no disco, deve lançar TypeError('canário já existe') sem apagá-lo
    writeFileSync(planted.filePath, 'já existente')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: 'S10',
        token: 'abcd1234',
      }),
    ).toThrow(TypeError)
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: 'S10',
        token: 'abcd1234',
      }),
    ).toThrow('canário já existe')
  })

  // AC2: Dado um diretório que, pelo caminho real, está dentro do worktree, ou um identificador de unidade
  // com caracteres de caminho, quando se tenta plantar o canário, então a operação é recusada com erro de argumento.
  test('isolation_canary_rejects_inside_worktree_or_invalid_unit_id', () => {
    const wtDir = makeTmpDir('ade-wt-')
    tmpDirs.push(wtDir)
    const subDir = path.join(wtDir, 'sub')
    mkdirSync(subDir, { recursive: true })
    const outDir = makeTmpDir('ade-out-')
    tmpDirs.push(outDir)

    // Exemplo: plantCanary({ worktreeDir: '/tmp/wt', outsideDir: '/tmp/wt/sub', unitId: 'S10' })
    // -> lança TypeError('outsideDir dentro do worktree')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: subDir,
        unitId: 'S10',
      }),
    ).toThrow(TypeError)
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: subDir,
        unitId: 'S10',
      }),
    ).toThrow('outsideDir dentro do worktree')

    // Um outsideDir lexicalmente fora do worktree mas ainda inexistente não pode
    // ser criado antes da recusa: só o ancestral já existente pode ser tocado.
    const notYetCreated = path.join(subDir, 'ainda-nao-existe')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: notYetCreated,
        unitId: 'S10',
      }),
    ).toThrow('outsideDir dentro do worktree')
    expect(existsSync(notYetCreated)).toBe(false)

    // Um alias (junction/symlink) fora do worktree cujo caminho real aponta para
    // dentro do worktree também tem de ser recusado, pois a checagem é por
    // caminho real (fs.realpathSync), não pelo texto do caminho fornecido.
    const aliasParent = makeTmpDir('ade-alias-')
    tmpDirs.push(aliasParent)
    const aliasToInside = path.join(aliasParent, 'alias-para-dentro')
    symlinkSync(subDir, aliasToInside, 'junction')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: aliasToInside,
        unitId: 'S10',
      }),
    ).toThrow('outsideDir dentro do worktree')

    // Exemplo: plantCanary({ worktreeDir: '/tmp/wt', outsideDir: '/tmp/fora', unitId: '../x' })
    // -> lança TypeError('unitId inválido')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: '../x',
      }),
    ).toThrow(TypeError)
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: '../x',
      }),
    ).toThrow('unitId inválido')

    // unitId com caracteres não permitidos (deve casar ^[A-Za-z0-9][A-Za-z0-9_-]*$)
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: 'unit/with/slash',
      }),
    ).toThrow('unitId inválido')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: '-comecaComHifen',
      }),
    ).toThrow('unitId inválido')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: '',
      }),
    ).toThrow('unitId inválido')

    // Validação de argumentos obrigatórios (strings)
    expect(() => plantCanary({} as any)).toThrow(TypeError)
    expect(() =>
      plantCanary({
        worktreeDir: 123 as any,
        outsideDir: outDir,
        unitId: 'S10',
      }),
    ).toThrow(TypeError)
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: null as any,
        unitId: 'S10',
      }),
    ).toThrow(TypeError)
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: undefined as any,
      }),
    ).toThrow(TypeError)
  })

  // AC3: Dado que a CLI falsa executa a ação de escape escrevendo no caminho do canário,
  // quando a verificação roda, então ela acusa escape e a reprovação sai com integridade de estado violada.
  test('isolation_canary_detects_write_outside_worktree', () => {
    const wtDir = makeTmpDir('ade-wt-')
    tmpDirs.push(wtDir)
    const outDir = makeTmpDir('ade-out-')
    tmpDirs.push(outDir)
    const scenarioDir = makeTmpDir('ade-scenario-')
    tmpDirs.push(scenarioDir)

    // 1. Plantar o canário fora do worktree
    const canary = plantCanary({
      worktreeDir: wtDir,
      outsideDir: outDir,
      unitId: 'S10',
      token: 'esc123',
    })

    // 2. Escrever maker.json com a ação escape apontando para canary.filePath
    const scenarioContent = [
      {
        escape: [canary.filePath],
        stdout: 'fugiu',
      },
    ]
    writeFileSync(path.join(scenarioDir, 'maker.json'), JSON.stringify(scenarioContent), 'utf8')

    const packFile = path.join(wtDir, 'pack.md')
    writeFileSync(packFile, '# pack\n', 'utf8')
    const resultFile = path.join(scenarioDir, 'result.json')

    // 3. Rodar a CLI falsa via spawnSync
    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: wtDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDir,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 1 << 20,
    })

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('fugiu')

    // 4. Verificar checkCanary acusando escape
    const check = checkCanary(canary)
    expect(check.escaped).toBe(true)
    expect(check.filePath).toBe(canary.filePath)

    // 5. assertCanaryIntact lança erro com code 'state_integrity' e details.reason 'isolation_canary_written'
    let caughtErr: any
    try {
      assertCanaryIntact(canary)
    } catch (err) {
      caughtErr = err
    }
    expect(caughtErr).toBeDefined()
    expect(caughtErr.code).toBe('state_integrity')
    expect(caughtErr.details?.reason).toBe('isolation_canary_written')
    expect(caughtErr.details?.file_path).toBe(canary.filePath)

    // Cobrir caso intacto e recusas adicionais no mesmo teste (passo 6 da receita)
    const canary2 = plantCanary({
      worktreeDir: wtDir,
      outsideDir: outDir,
      unitId: 'S10',
      token: 'safe456',
    })
    const scenarioDirSafe = makeTmpDir('ade-scenario-safe-')
    tmpDirs.push(scenarioDirSafe)
    writeFileSync(
      path.join(scenarioDirSafe, 'maker.json'),
      JSON.stringify([{ files: { 'src/ok.txt': 'ok' }, stdout: 'limpo' }]),
      'utf8',
    )
    const resultFileSafe = path.join(scenarioDirSafe, 'result.json')
    const resSafe = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: wtDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDirSafe,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFileSafe,
      },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 1 << 20,
    })
    expect(resSafe.status).toBe(0)
    expect(checkCanary(canary2).escaped).toBe(false)
    expect(() => assertCanaryIntact(canary2)).not.toThrow()

    // Recusas de outsideDir dentro do worktree e unitId inválido '../x'
    const subDir = path.join(wtDir, 'sub')
    mkdirSync(subDir, { recursive: true })
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: subDir,
        unitId: 'S10',
      }),
    ).toThrow('outsideDir dentro do worktree')
    expect(() =>
      plantCanary({
        worktreeDir: wtDir,
        outsideDir: outDir,
        unitId: '../x',
      }),
    ).toThrow('unitId inválido')
  })

  // AC4: Dado que a CLI falsa roda sem escrever fora do worktree,
  // quando a verificação roda, então o canário é considerado intacto e nada é lançado.
  test('isolation_canary_remains_intact_when_cli_does_not_escape', () => {
    const wtDir = makeTmpDir('ade-wt-')
    tmpDirs.push(wtDir)
    const outDir = makeTmpDir('ade-out-')
    tmpDirs.push(outDir)
    const scenarioDir = makeTmpDir('ade-scenario-')
    tmpDirs.push(scenarioDir)

    const canary = plantCanary({
      worktreeDir: wtDir,
      outsideDir: outDir,
      unitId: 'S10',
      token: 'clean123',
    })

    const scenarioContent = [
      {
        files: { 'src/local.txt': 'escrita local permitida' },
        stdout: 'sem escape',
      },
    ]
    writeFileSync(path.join(scenarioDir, 'maker.json'), JSON.stringify(scenarioContent), 'utf8')

    const packFile = path.join(wtDir, 'pack.md')
    writeFileSync(packFile, '# pack\n', 'utf8')
    const resultFile = path.join(scenarioDir, 'result.json')

    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: wtDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDir,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 1 << 20,
    })

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('sem escape')

    const check = checkCanary(canary)
    expect(check.escaped).toBe(false)
    expect(check.filePath).toBe(canary.filePath)

    expect(() => assertCanaryIntact(canary)).not.toThrow()
  })
})

