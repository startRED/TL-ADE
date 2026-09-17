import fs, { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  MAX_FINDINGS,
  SECRET_PATTERNS,
  pathWithin,
  scanBytes,
  scanFile,
  scanText,
} from '../../src/contain/secrets.js'
import {
  DEFAULT_SENSITIVE_PATHS,
  PRECEDENCE,
  contain,
  matchesGlob,
} from '../../src/contain/contain.js'
import { createGitPort } from '../../src/git/gitport.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { makeTmpDir } from '../helpers/tmp-dir.js'

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

describe('contain parity', () => {
  // AC1: Dado um texto com uma chave sintética de acesso da AWS, quando scanText roda,
  // então devolve um achado com pattern igual a aws_access_key_id e o deslocamento do casamento.
  // AC3: Dado um caminho que sobe de diretório com .. ou com separador do Windows, quando
  // pathWithin avalia contra a raiz, então devolve falso; para um caminho realmente dentro da raiz devolve verdadeiro.
  // AC4: Dado texto vazio ou arquivo inexistente, quando a varredura roda, então devolve lista vazia sem lançar.
  test('path_within_and_secret_scan', async () => {
    // Validação de SECRET_PATTERNS e MAX_FINDINGS
    expect(MAX_FINDINGS).toBe(50)
    expect(SECRET_PATTERNS).toHaveLength(5)
    const patternIds = SECRET_PATTERNS.map((p) => p.id)
    expect(patternIds).toEqual([
      'aws_access_key_id',
      'openai_api_key',
      'github_token',
      'pem_private_key',
      'dotenv_secret',
    ])
    for (const p of SECRET_PATTERNS) {
      expect(p.re.global).toBe(true)
    }

    // AC1 e Exemplos de scanText:
    // scanText('AKIA' + 'ABCDEFGHIJ234567') -> [{ pattern: 'aws_access_key_id', offset: 0, preview: 'AKIA…' }]
    const awsKey = 'AKIA' + 'ABCDEFGHIJ234567'
    const awsFindings = scanText(awsKey)
    expect(awsFindings).toEqual([
      { pattern: 'aws_access_key_id', offset: 0, preview: 'AKIA…' },
    ])

    // AC4: scanText('') -> []
    expect(scanText('')).toEqual([])

    // Outros padrões de segredo montados por concatenação em runtime
    const openaiKey = 'sk-' + '12345678901234567890'
    const openaiFindings = scanText('key: ' + openaiKey)
    expect(openaiFindings).toEqual([
      { pattern: 'openai_api_key', offset: 5, preview: 'sk-1…' },
    ])

    const githubToken = 'gh' + 'p_' + 'a'.repeat(36)
    const githubFindings = scanText('token="' + githubToken + '"')
    expect(githubFindings).toEqual([
      { pattern: 'github_token', offset: 7, preview: 'ghp_…' },
    ])

    const pemKey = '-----BEGIN ' + 'PRIVATE KEY-----\nfake\n-----END ' + 'PRIVATE KEY-----'
    const pemFindings = scanText(pemKey)
    expect(pemFindings).toHaveLength(1)
    expect(pemFindings[0].pattern).toBe('pem_private_key')
    expect(pemFindings[0].offset).toBe(0)

    const dotenvSecret = 'export ' + 'SECRET_TOKEN=my_secret_token_123'
    const dotenvFindings = scanText(dotenvSecret)
    expect(dotenvFindings).toHaveLength(1)
    expect(dotenvFindings[0].pattern).toBe('dotenv_secret')

    // Linha de diff com prefixo '+'
    const diffLine = '+ ' + 'API_' + 'KEY=abcdef12345'
    const diffFindings = scanText(diffLine)
    expect(diffFindings).toHaveLength(1)
    expect(diffFindings[0].pattern).toBe('dotenv_secret')

    // scanText clona regex para não compartilhar lastIndex entre chamadas consecutivas
    const firstScan = scanText(awsKey)
    const secondScan = scanText(awsKey)
    expect(firstScan).toEqual(secondScan)

    // Ordenação por offset e depois por pattern
    const multiSecret = 'sk-' + '12345678901234567890' + ' and ' + 'AKIA' + '1234567890ABCDEF'
    const multiFindings = scanText(multiSecret)
    expect(multiFindings).toHaveLength(2)
    expect(multiFindings[0].offset).toBeLessThan(multiFindings[1].offset)

    // Corte em MAX_FINDINGS (50 achados no máximo)
    const manySecrets = Array.from({ length: 60 }, () => 'AKIA' + '1234567890ABCDEF').join(' ')
    const cappedFindings = scanText(manySecrets)
    expect(cappedFindings).toHaveLength(50)

    // scanText lança TypeError para entrada que não seja string
    expect(() => scanText(123 as unknown as string)).toThrow(TypeError)
    expect(() => scanText(null as unknown as string)).toThrow(TypeError)
    expect(() => scanText(undefined as unknown as string)).toThrow(TypeError)

    // AC3 e Exemplos de pathWithin:
    // pathWithin('/repo', '/repo/src/a.js') -> true
    // pathWithin('/repo', '/repo/../fora.txt') -> false
    // pathWithin('/repo', '..\\fora.txt') -> false
    // pathWithin('/repo', '/repo') -> true
    expect(pathWithin('/repo', '/repo/src/a.js')).toBe(true)
    expect(pathWithin('/repo', '/repo/../fora.txt')).toBe(false)
    expect(pathWithin('/repo', '..\\fora.txt')).toBe(false)
    expect(pathWithin('/repo', '/repo')).toBe(true)
    expect(pathWithin('/repo', 'src/a.js')).toBe(true)
    expect(pathWithin('/repo', '../fora.txt')).toBe(false)

    // pathWithin lança TypeError para argumentos inválidos (não string ou string vazia)
    expect(() => pathWithin('', '/repo/src')).toThrow(TypeError)
    expect(() => pathWithin('/repo', '')).toThrow(TypeError)
    expect(() => pathWithin(null as unknown as string, '/repo')).toThrow(TypeError)
    expect(() => pathWithin('/repo', 42 as unknown as string)).toThrow(TypeError)

    // AC4: scanFile devolve lista vazia para arquivo inexistente ou diretório, sem lançar
    expect(scanFile('/caminho/absoluto/que/certamente/nao/existe.txt')).toEqual([])
    expect(scanFile(process.cwd())).toEqual([])

    // Exemplos de matchesGlob:
    // matchesGlob('tests/**/contain*.ts', 'tests/contain.test.ts') -> true
    // matchesGlob('src/**', 'outro/b.txt') -> false
    expect(matchesGlob('tests/**/contain*.ts', 'tests/contain.test.ts')).toBe(true)
    expect(matchesGlob('src/**', 'outro/b.txt')).toBe(false)
    expect(matchesGlob('src/**', 'src\\sub\\modulo.js')).toBe(true)
    expect(matchesGlob('**/.env', 'src/sub/.env')).toBe(true)

    // Constantes do módulo contain
    expect(PRECEDENCE).toEqual(['secret', 'sensitive_path', 'scope', 'no_changes'])
    expect(DEFAULT_SENSITIVE_PATHS).toEqual([
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/id_rsa',
      '**/.ssh/**',
      '**/.aws/**',
      '**/secrets/**',
    ])

    // contain() valida entrada obrigatória e lança TypeError
    await expect(contain({})).rejects.toThrow(TypeError)
  })

  // AC2: Dado um buffer com bytes binários e um token sintético ghp_ no meio, quando scanBytes roda,
  // então o token é encontrado mesmo com bytes não textuais em volta.
  test('secret_inside_a_binary_file_is_caught', async () => {
    // Exemplo: scanBytes(Buffer.concat([Buffer.from([0, 159, 146, 150]), Buffer.from('gh' + 'p_' + 'a'.repeat(36))]))
    // -> 1 achado com pattern 'github_token'
    const prefixBytes = Buffer.from([0, 159, 146, 150])
    const syntheticToken = Buffer.from('gh' + 'p_' + 'a'.repeat(36))
    const binaryBuf = Buffer.concat([prefixBytes, syntheticToken])

    const findings = scanBytes(binaryBuf)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      pattern: 'github_token',
      offset: 4,
      preview: 'ghp_…',
    })

    // Buffer binário com bytes não textuais antes e depois de uma chave AWS
    const binaryWithAws = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
      Buffer.from('AKIA' + 'ABCDEFGHIJ234567'),
      Buffer.from([0x00, 0x7f, 0x80, 0x90]),
    ])
    const awsFindings = scanBytes(binaryWithAws)
    expect(awsFindings).toHaveLength(1)
    expect(awsFindings[0]).toEqual({
      pattern: 'aws_access_key_id',
      offset: 4,
      preview: 'AKIA…',
    })

    // Gravação e varredura de arquivo binário em disco via scanFile
    const tmpDir = makeTmpDir('ade-contain-')
    tmpDirs.push(tmpDir)

    const binFilePath = path.join(tmpDir, 'secret_payload.bin')
    writeFileSync(binFilePath, binaryBuf)

    const fileFindings = scanFile(binFilePath)
    expect(fileFindings).toHaveLength(1)
    expect(fileFindings[0]).toEqual({
      pattern: 'github_token',
      offset: 4,
      preview: 'ghp_…',
    })
  })

  // AC1: Dado um diff maior que 1 MiB com o segredo no último trecho e, ao mesmo tempo, um arquivo fora do escopo,
  // quando contain roda, então o resultado reprova por segurança, registra também a violação de escopo e não cria nenhum commit de entrega.
  // AC3: Dado um segredo detectado, quando contain termina, então a referência de quarentena aponta para a árvore do worktree de antes da parada e o HEAD do repositório continua o mesmo.
  // AC4: Dado um worktree sem nenhuma alteração, quando contain roda, então o resultado é reprovado como falha semântica, não como sucesso.
  test('secret_in_diff_stops_batch', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    // Validação de entrada: unitId inválido lança TypeError('unitId inválido')
    await expect(
      contain({
        git: port,
        unitId: '../evil',
        scopePaths: ['src/**'],
      }),
    ).rejects.toThrow(new TypeError('unitId inválido'))

    // Cria commit inicial no repositório com um arquivo em src/
    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    const bigFilePath = path.join(srcDir, 'big.txt')

    // Gerar arquivo base com ~30.000 linhas (~1.2 MiB)
    const initialLines = Array.from(
      { length: 30000 },
      (_, i) => `linha original de conteudo do arquivo ${i}\n`,
    ).join('')
    writeFileSync(bigFilePath, initialLines)

    const initialCommit = await port.commit({ message: 'commit inicial' })
    const headInitial = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text

    // AC4 e Exemplo: worktree limpo -> falha semântica com action rework
    const cleanRes = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
    })
    expect(cleanRes).toEqual({
      ok: false,
      reason: 'no_changes',
      failureClass: 'semantic',
      action: 'rework',
      violations: [{ kind: 'no_changes', path: null, pattern: null, source: null }],
      changedPaths: [],
      quarantineRef: null,
      restoredTree: null,
    })

    // Reescreve todas as ~30.000 linhas gerando um diff de ~2 MiB,
    // e adiciona o segredo na última linha
    const secretKey = 'sk-' + 'a'.repeat(24)
    const modifiedLines =
      Array.from(
        { length: 30000 },
        (_, i) => `linha modificada de conteudo do arquivo ${i}\n`,
      ).join('') +
      secretKey +
      '\n'
    writeFileSync(bigFilePath, modifiedLines)

    // Adiciona arquivo fora do escopo ('fora/b.txt')
    const foraDir = path.join(repo.dir, 'fora')
    mkdirSync(foraDir, { recursive: true })
    writeFileSync(path.join(foraDir, 'b.txt'), 'conteudo fora do escopo\n')

    // Guarda HEAD e árvore do worktree antes da chamada
    const treeBeforeContain = await port.worktreeTree()
    const headBefore = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text

    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
    })

    // AC1 e Exemplo: diff ~2 MiB com segredo no final e arquivo fora do escopo
    // Reprova por segurança, action stop_batch, violação de escopo registrada
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('secret')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')

    const scopeViolation = result.violations.find(
      (v) => v.kind === 'scope' && v.path === 'fora/b.txt',
    )
    expect(scopeViolation).toBeDefined()

    const secretViolation = result.violations.find((v) => v.kind === 'secret')
    expect(secretViolation).toBeDefined()
    expect(secretViolation?.path).toBe('src/big.txt')

    // AC3 e Exemplo: quarantineRef === 'refs/ade/quarantine/S10/1',
    // aponta para a árvore de antes da parada e HEAD continua o inicial (sem commit de entrega)
    expect(result.quarantineRef).toBe('refs/ade/quarantine/S10/1')

    const quarantineTree = (
      await port.run(['rev-parse', `${result.quarantineRef}^{tree}`], { maxBuffer: 1 << 20 })
    ).text
    expect(quarantineTree).toBe(treeBeforeContain)

    const headAfter = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text
    expect(headAfter).toBe(headBefore)
    expect(headAfter).toBe(headInitial)
  }, 30_000)

  // AC2: Dado um segredo posicionado além de 60 000 bytes do diff, quando contain roda,
  // então o segredo continua sendo encontrado.
  test('secret_beyond_the_pack_diff_cap_is_still_caught', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    const targetFile = path.join(srcDir, 'big_diff.txt')

    // Cria arquivo inicial com 2.000 linhas (~90 KB)
    const initialContent = Array.from(
      { length: 2000 },
      (_, i) => `linha original de preenchimento para teste ${String(i).padStart(4, '0')}\n`,
    ).join('')
    writeFileSync(targetFile, initialContent)

    const initialCommit = await port.commit({ message: 'commit base filler' })

    // Modifica as primeiras 1.500 linhas (> 60.000 bytes no diff) e insere o segredo AWS
    const awsKey = 'AKIA' + 'ABCDEFGHIJ234567'
    const modifiedContent =
      Array.from(
        { length: 1500 },
        (_, i) => `linha modificada de preenchimento para teste ${String(i).padStart(4, '0')}\n`,
      ).join('') +
      awsKey +
      '\n' +
      Array.from(
        { length: 500 },
        (_, i) => `linha original de preenchimento para teste ${String(i + 1500).padStart(4, '0')}\n`,
      ).join('')
    writeFileSync(targetFile, modifiedContent)

    const resultPromise = contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
    })
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      reason: 'secret',
      failureClass: 'security',
      action: 'stop_batch',
    })
    const result = await resultPromise

    // AC2 e Exemplo: segredo escrito após o byte 60.000 do diff é capturado com source: 'diff'
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('secret')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')

    const diffSecretViolation = result.violations.find(
      (v) => v.kind === 'secret' && v.source === 'diff',
    )
    expect(diffSecretViolation).toBeDefined()
    expect(diffSecretViolation?.pattern).toBe('aws_access_key_id')
    expect(diffSecretViolation?.path).toBe('src/big_diff.txt')
  }, 30_000)

  // Dublê de git na fronteira do processo filho: registra cada chamada de `run` (com as
  // opções recebidas) e cada chamada de método de restauração, sem tocar em git de verdade.
  interface FakeRunCall {
    args: string[]
    options: { maxBuffer?: number }
  }

  function makeFakeGit(opts: { worktreeDir: string; dirtyPaths: string[]; diff: string }) {
    const runCalls: FakeRunCall[] = []
    const restoreCalls: Array<{ tree: string; options: { label?: string } }> = []
    const legacyRestoreCalls: string[] = []
    const quarantineTree = 'b'.repeat(40)
    const quarantineCommit = 'c'.repeat(40)
    const restoredTree = 'd'.repeat(40)

    // `stdout` é a fonte integral (bytes Latin-1); `text` é o campo UTF-8 já degradado.
    // Para o diff os dois divergem de propósito: `text` vem truncado no cabeçalho, sem
    // nenhum segredo, então uma implementação que varresse `text` em vez de
    // `stdout.toString('latin1')` não acharia nada e as provas ficariam vermelhas.
    const reply = (out: string, text: string = out) => ({
      code: 0,
      stdout: Buffer.from(out, 'latin1'),
      stderr: '',
      text,
    })

    /** Recorte do diff que sobra no campo `text`: só o primeiro cabeçalho. */
    const truncatedDiffText = opts.diff.slice(0, opts.diff.indexOf('\n') + 1)

    return {
      worktreeDir: opts.worktreeDir,
      runCalls,
      restoreCalls,
      legacyRestoreCalls,
      restoredTree,
      truncatedDiffText,
      async headInfo() {
        return { commit: 'a'.repeat(40), branch: 'main', detached: false }
      },
      async dirtyPaths() {
        return [...opts.dirtyPaths]
      },
      async worktreeTree() {
        return quarantineTree
      },
      async run(args: string[], options: { maxBuffer?: number } = {}) {
        runCalls.push({ args: [...args], options: { ...options } })
        if (args.includes('diff')) {
          return reply(opts.diff, truncatedDiffText)
        }
        if (args[0] === 'commit-tree') {
          return reply(quarantineCommit)
        }
        return reply('')
      },
      async restore(tree: string, options: { label?: string }) {
        restoreCalls.push({ tree, options: { ...options } })
        return { tree: restoredTree, discardedRef: 'refs/ade/discarded/S10/1' }
      },
      // Método de restauração alternativo: existe só para provar que o contain NÃO o usa.
      async restoreTree(tree: string) {
        legacyRestoreCalls.push(tree)
        return { tree, discardedRef: 'refs/ade/discarded/legacy' }
      },
    }
  }

  // AC1: Dado um diff com segredos dentro de arquivos, quando contain roda, então cada achado
  // traz o caminho relativo do arquivo (nunca null) e os achados saem ordenados por caminho.
  test('secret_findings_from_the_diff_carry_the_relative_path_and_are_sorted_by_path', async () => {
    const worktreeDir = makeTmpDir('ade-contain-fake-')
    tmpDirs.push(worktreeDir)

    const awsKey = 'AKIA' + 'ABCDEFGHIJ234567'
    const githubToken = 'gh' + 'p_' + 'a'.repeat(36)
    const openaiKey = 'sk-' + '12345678901234567890'

    // Seções na ordem inversa da alfabética; a última é um arquivo apagado,
    // cujo caminho só aparece no cabeçalho `--- a/...` (o `+++` é /dev/null).
    const diff = [
      'diff --git a/src/z.js b/src/z.js',
      'index 1111111..2222222 100644',
      '--- a/src/z.js',
      '+++ b/src/z.js',
      '@@ -1,0 +1,1 @@',
      '+const chave = "' + awsKey + '"',
      'diff --git a/src/a.js b/src/a.js',
      'index 3333333..4444444 100644',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,0 +1,1 @@',
      '+const token = "' + githubToken + '"',
      'diff --git a/src/m.txt b/src/m.txt',
      'deleted file mode 100644',
      'index 5555555..0000000',
      '--- a/src/m.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-valor antigo: ' + openaiKey,
      '',
    ].join('\n')

    const git = makeFakeGit({
      worktreeDir,
      dirtyPaths: ['src/z.js', 'src/a.js', 'src/m.txt'],
      diff,
    })

    // O campo `text` do dublê não tem nenhum dos segredos: o achado só pode vir de
    // `stdout.toString('latin1')`, a fonte integral exigida pela decisão do plano.
    expect(git.truncatedDiffText).not.toBe(diff)
    for (const segredo of [awsKey, githubToken, openaiKey]) {
      expect(git.truncatedDiffText).not.toContain(segredo)
    }

    const result = await contain({
      git,
      unitId: 'S10',
      treeBefore: 'e'.repeat(40),
      scopePaths: ['src/**'],
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('secret')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')

    const secretViolations = result.violations.filter((v) => v.kind === 'secret')
    expect(secretViolations).toEqual([
      { kind: 'secret', path: 'src/a.js', pattern: 'github_token', source: 'diff' },
      { kind: 'secret', path: 'src/m.txt', pattern: 'openai_api_key', source: 'diff' },
      { kind: 'secret', path: 'src/z.js', pattern: 'aws_access_key_id', source: 'diff' },
    ])
    expect(secretViolations.every((v) => v.path !== null)).toBe(true)
    expect(result.quarantineRef).toBe('refs/ade/quarantine/S10/1')
  })

  // AC2: Por padrão, o diff roda com o buffer integral maxBuffer = 2 ** 31; quando diffMaxBuffer é informado, ele é respeitado.
  test('the_diff_runs_with_the_full_max_buffer_by_default_and_respects_explicit_limit', async () => {
    const worktreeDir = makeTmpDir('ade-contain-fake-')
    tmpDirs.push(worktreeDir)

    const diff = [
      'diff --git a/src/ok.js b/src/ok.js',
      'index 1111111..2222222 100644',
      '--- a/src/ok.js',
      '+++ b/src/ok.js',
      '@@ -1,0 +1,1 @@',
      '+const valor = 1',
      '',
    ].join('\n')

    const git = makeFakeGit({ worktreeDir, dirtyPaths: ['src/ok.js'], diff })

    // Por padrão (sem diffMaxBuffer), maxBuffer usado é 2 ** 31
    const result = await contain({
      git,
      unitId: 'S10',
      treeBefore: 'e'.repeat(40),
      scopePaths: ['src/**'],
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('continue')

    const diffCalls = git.runCalls.filter((c) => c.args.includes('diff'))
    expect(diffCalls).toHaveLength(1)
    expect(diffCalls[0].args).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--text',
      'HEAD',
      '--',
    ])
    expect(diffCalls[0].options.maxBuffer).toBe(2 ** 31)

    // Quando diffMaxBuffer explícito é informado, é repassado ao git.run
    const gitWithLimit = makeFakeGit({ worktreeDir, dirtyPaths: ['src/ok.js'], diff })
    const resultWithLimit = await contain({
      git: gitWithLimit,
      unitId: 'S10',
      treeBefore: 'e'.repeat(40),
      scopePaths: ['src/**'],
      diffMaxBuffer: 1024,
    })
    expect(resultWithLimit.ok).toBe(true)
    const limitDiffCalls = gitWithLimit.runCalls.filter((c) => c.args.includes('diff'))
    expect(limitDiffCalls).toHaveLength(1)
    expect(limitDiffCalls[0].options.maxBuffer).toBe(1024)
  })

  // AC3: Dado que contain precisa restaurar, então chama git.restore(treeBefore, { label: unitId })
  // e nenhum outro método de restauração; sem restauração, nenhum deles é chamado.
  test('restore_uses_only_git_restore_with_tree_before_and_the_unit_label', async () => {
    const worktreeDir = makeTmpDir('ade-contain-fake-')
    tmpDirs.push(worktreeDir)

    const cleanDiff = [
      'diff --git a/fora/b.txt b/fora/b.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/fora/b.txt',
      '@@ -0,0 +1,1 @@',
      '+conteudo fora do escopo',
      '',
    ].join('\n')
    const treeBefore = 'e'.repeat(40)

    // Primeira violação de escopo: restaura a árvore pelo único método aceito.
    const git = makeFakeGit({ worktreeDir, dirtyPaths: ['fora/b.txt'], diff: cleanDiff })
    const restored = await contain({
      git,
      unitId: 'S10',
      treeBefore,
      scopePaths: ['src/**'],
    })

    expect(restored.reason).toBe('scope')
    expect(restored.action).toBe('restore')
    expect(restored.restoredTree).toBe(git.restoredTree)
    expect(git.restoreCalls).toEqual([{ tree: treeBefore, options: { label: 'S10' } }])
    expect(git.legacyRestoreCalls).toEqual([])

    // Repetição: estaciona sem chamar nenhum método de restauração.
    const gitRepeat = makeFakeGit({ worktreeDir, dirtyPaths: ['fora/b.txt'], diff: cleanDiff })
    const parked = await contain({
      git: gitRepeat,
      unitId: 'S10',
      treeBefore,
      scopePaths: ['src/**'],
      scopeViolationCount: 1,
    })
    expect(parked.action).toBe('park')
    expect(parked.restoredTree).toBe(null)
    expect(gitRepeat.restoreCalls).toEqual([])
    expect(gitRepeat.legacyRestoreCalls).toEqual([])

    // Segredo: para o lote sem restaurar nada.
    const secretDiff = [
      'diff --git a/src/a.js b/src/a.js',
      'index 1111111..2222222 100644',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,0 +1,1 @@',
      '+const chave = "' + 'AKIA' + 'ABCDEFGHIJ234567' + '"',
      '',
    ].join('\n')
    const gitSecret = makeFakeGit({ worktreeDir, dirtyPaths: ['src/a.js'], diff: secretDiff })
    const stopped = await contain({
      git: gitSecret,
      unitId: 'S10',
      treeBefore,
      scopePaths: ['src/**'],
    })
    expect(stopped.reason).toBe('secret')
    expect(stopped.action).toBe('stop_batch')
    expect(stopped.restoredTree).toBe(null)
    expect(gitSecret.restoreCalls).toEqual([])
    expect(gitSecret.legacyRestoreCalls).toEqual([])
  })

  // AC1: Dado um arquivo alterado que casa a lista de caminhos sensíveis, quando contain roda,
  // então o lote é parado por segurança com o motivo de caminho sensível.
  test('sensitive_path_stops_batch', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    // Repositório com src/a.js commitado
    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })

    // Escrever .env com PORT=3000 (inofensivo, sem segredo)
    writeFileSync(path.join(repo.dir, '.env'), 'PORT=3000\n')

    // Chamar contain com scopePaths: ['**']
    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['**'],
    })

    // Exemplo 1: .env alterado com PORT=3000 e scopePaths: ['**']
    // -> { ok: false, reason: 'sensitive_path', failureClass: 'security', action: 'stop_batch' } com quarantineRef preenchido
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('sensitive_path')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')
    expect(result.quarantineRef).toBe('refs/ade/quarantine/S10/1')

    // Exemplo 3: arquivo deploy/chave.pem alterado sem conteúdo de chave -> reason === 'sensitive_path'
    const deployDir = path.join(repo.dir, 'deploy')
    mkdirSync(deployDir, { recursive: true })
    writeFileSync(path.join(deployDir, 'chave.pem'), 'conteudo publico sem chave privada\n')

    const resPem = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['**'],
    })
    expect(resPem.ok).toBe(false)
    expect(resPem.reason).toBe('sensitive_path')
    expect(resPem.failureClass).toBe('security')
    expect(resPem.action).toBe('stop_batch')

    // Exemplo 4: contain com sensitivePaths: [] e apenas .env alterado dentro do escopo -> { ok: true, action: 'continue' }
    unlinkSync(path.join(deployDir, 'chave.pem'))
    const resEmpty = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['**'],
      sensitivePaths: [],
    })
    expect(resEmpty.ok).toBe(true)
    expect(resEmpty.reason).toBe(null)
    expect(resEmpty.action).toBe('continue')
  })

  // AC2: Dado esse mesmo caso, quando contain termina, então existe uma referência sob
  // refs/ade/quarantine/ apontando para a árvore do worktree.
  test('sensitive_path_creates_quarantine_ref_pointing_to_worktree', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })

    writeFileSync(path.join(repo.dir, '.env'), 'PORT=3000\n')

    const treeBeforeContain = await port.worktreeTree()
    const headBefore = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text

    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['**'],
    })

    // AC2: Referência sob refs/ade/quarantine/ apontando para a árvore do worktree
    expect(result.quarantineRef).toBe('refs/ade/quarantine/S10/1')

    const quarantineTree = (
      await port.run(['rev-parse', `${result.quarantineRef}^{tree}`], { maxBuffer: 1 << 20 })
    ).text
    expect(quarantineTree).toBe(treeBeforeContain)

    // Confere a referência listada sob refs/ade/quarantine
    const forEachRefRes = await port.run(
      ['for-each-ref', '--format=%(refname)', 'refs/ade/quarantine'],
      { maxBuffer: 1 << 20 },
    )
    expect(forEachRefRes.text).toContain('refs/ade/quarantine/S10/1')

    // HEAD permanece o mesmo de antes da chamada (sem commit de entrega)
    const headAfter = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text
    expect(headAfter).toBe(headBefore)
  })

  // AC3: Dado um arquivo sensível sem nenhum segredo dentro e outro arquivo fora do escopo,
  // quando contain roda, então o motivo é caminho sensível e a violação de escopo também aparece na lista.
  test('sensitive_path_with_scope_violation_stops_batch_and_preserves_scope', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })

    // .env alterado e também src/a.js fora do escopo, sem nenhum segredo
    writeFileSync(path.join(repo.dir, '.env'), 'PORT=3000\n')
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 2\n')

    // scopePaths contempla apenas .env; src/a.js fica fora do escopo
    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['.env'],
    })

    // Exemplo 2: reason === 'sensitive_path' e violations contém um item kind 'scope' com path 'src/a.js'
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('sensitive_path')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')

    const scopeViolation = result.violations.find(
      (v) => v.kind === 'scope' && v.path === 'src/a.js',
    )
    expect(scopeViolation).toBeDefined()
    expect(scopeViolation?.path).toBe('src/a.js')

    const sensitiveViolation = result.violations.find(
      (v) => v.kind === 'sensitive_path' && v.path === '.env',
    )
    expect(sensitiveViolation).toBeDefined()
    expect(sensitiveViolation?.path).toBe('.env')

    // Precedência: sensitive_path deve anteceder scope na ordenação de violations
    const sensitiveIdx = result.violations.findIndex((v) => v.kind === 'sensitive_path')
    const scopeIdx = result.violations.findIndex((v) => v.kind === 'scope')
    expect(sensitiveIdx).toBeLessThan(scopeIdx)
  })

  // AC1: Dado um worktree em que só um arquivo dentro do escopo mudou, sem segredo e sem caminho sensível,
  // quando contain roda, então o resultado é aprovado com lista de violações vazia e sem referência de quarentena nem árvore restaurada.
  test('clean_change_passes_without_violations', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const n = 1;\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })
    const headBefore = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text

    // Reescrever src/a.js com export const n = 2;
    writeFileSync(path.join(srcDir, 'a.js'), 'export const n = 2;\n')

    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
      sensitivePaths: [],
    })

    // Exemplo 1: aprovação limpa com changedPaths: ['src/a.js']
    expect(result).toEqual({
      ok: true,
      reason: null,
      failureClass: null,
      action: 'continue',
      violations: [],
      changedPaths: ['src/a.js'],
      quarantineRef: null,
      restoredTree: null,
    })

    // Exemplo 2: saída de for-each-ref sob refs/ade/quarantine vazia e HEAD inalterado
    const forEachRefRes = await port.run(
      ['for-each-ref', '--format=%(refname)', 'refs/ade/quarantine'],
      { maxBuffer: 1 << 20 },
    )
    expect(forEachRefRes.text.trim()).toBe('')

    const headAfter = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text
    expect(headAfter).toBe(headBefore)

    // Exemplo 4: contain com src/a.js alterado e doNotTouch: ['src/a.js'] -> ok === false e reason === 'scope'
    const doNotTouchRes = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
      doNotTouch: ['src/a.js'],
      sensitivePaths: [],
    })
    expect(doNotTouchRes.ok).toBe(false)
    expect(doNotTouchRes.reason).toBe('scope')
  })

  // AC2: Dado esse mesmo caso, quando contain termina, então nenhuma referência sob
  // refs/ade/quarantine/ foi criada e o HEAD continua o mesmo.
  test('clean_change_creates_no_quarantine_ref_and_preserves_head', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const n = 1;\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })
    const headBefore = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text

    writeFileSync(path.join(srcDir, 'a.js'), 'export const n = 2;\n')

    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
      sensitivePaths: [],
    })

    expect(result.quarantineRef).toBeNull()

    const forEachRefRes = await port.run(
      ['for-each-ref', '--format=%(refname)', 'refs/ade/quarantine'],
      { maxBuffer: 1 << 20 },
    )
    expect(forEachRefRes.text.trim()).toBe('')

    const headAfter = (await port.run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text
    expect(headAfter).toBe(headBefore)
  })

  // AC3: Dado esse mesmo caso, quando o resultado é inspecionado, então a lista de
  // arquivos alterados contém exatamente o arquivo que mudou.
  test('clean_change_inspects_changed_paths_matching_diff', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1;\n')
    writeFileSync(path.join(srcDir, 'b.js'), 'export const b = 1;\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })

    // Apenas src/a.js modificado
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 2;\n')

    const singleResult = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
      sensitivePaths: [],
    })

    expect(singleResult.ok).toBe(true)
    expect(singleResult.changedPaths).toEqual(['src/a.js'])

    // Exemplo 3: contain com src/a.js e src/b.js alterados dentro do escopo
    // -> changedPaths === ['src/a.js', 'src/b.js'] e ok === true
    writeFileSync(path.join(srcDir, 'b.js'), 'export const b = 2;\n')

    const multiResult = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
      sensitivePaths: [],
    })

    expect(multiResult.ok).toBe(true)
    expect(multiResult.violations).toEqual([])
    expect(multiResult.changedPaths).toEqual(['src/a.js', 'src/b.js'])
  })

  // AC1: Dado um segredo e uma violação de escopo simultâneos, quando contain roda,
  // então as duas violações aparecem na lista e o motivo é o segredo.
  test('secret_with_scope_violation_still_stops', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1;\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })

    // src/a.js alterado com segredo ('AKIA' + 'ABCDEFGHIJ234567') e fora/b.txt alterado fora do escopo
    const awsKey = 'AKIA' + 'ABCDEFGHIJ234567'
    writeFileSync(path.join(srcDir, 'a.js'), `export const a = "${awsKey}";\n`)

    const foraDir = path.join(repo.dir, 'fora')
    mkdirSync(foraDir, { recursive: true })
    writeFileSync(path.join(foraDir, 'b.txt'), 'conteudo fora do escopo\n')

    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
    })

    // Exemplo: reason === 'secret', violations[0].kind === 'secret' e lista contém 'scope'
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('secret')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')
    expect(result.violations[0].kind).toBe('secret')
    expect(result.violations.map((v) => v.kind)).toContain('scope')

    const scopeViolation = result.violations.find(
      (v) => v.kind === 'scope' && v.path === 'fora/b.txt',
    )
    expect(scopeViolation).toBeDefined()

    // Exemplo: .env com 'AKIA' + 'ABCDEFGHIJ234567' dentro -> reason === 'secret' (segredo vence sensivel) e violations contem sensitive_path
    writeFileSync(path.join(repo.dir, '.env'), `AWS_SECRET=${awsKey}\n`)
    const resEnv = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**', '.env'],
    })
    expect(resEnv.ok).toBe(false)
    expect(resEnv.reason).toBe('secret')
    expect(resEnv.violations[0].kind).toBe('secret')
    expect(resEnv.violations.map((v) => v.kind)).toContain('sensitive_path')

    // Reverter arquivos para testar caminho que resolve para fora do worktree sem diff pendente
    unlinkSync(path.join(repo.dir, '.env'))
    unlinkSync(path.join(foraDir, 'b.txt'))
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1;\n')

    // Exemplo: caminho alterado que resolve para fora do worktree -> não aparece em violations e nenhum arquivo é lido.
    // O arquivo real fora do worktree contém um segredo: se fosse lido, apareceria como violação e
    // fs.readFileSync seria chamado com o caminho dele. Como nenhum dos dois acontece, a leitura foi
    // realmente pulada, não apenas "não encontrou nada por acaso".
    const outsidePath = path.join(repo.dir, '..', 'fora-do-repo-real.txt')
    writeFileSync(outsidePath, 'AKIA' + 'ABCDEFGHIJ234567')
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    try {
      const mockPort = {
        ...port,
        dirtyPaths: async () => ['../fora-do-repo-real.txt'],
      }
      const resOutside = await contain({
        git: mockPort,
        unitId: 'S10',
        treeBefore: initialCommit.tree,
        scopePaths: ['**'],
      })
      expect(resOutside.violations).toEqual([])
      expect(readFileSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('fora-do-repo-real.txt'),
      )
    } finally {
      readFileSyncSpy.mockRestore()
      unlinkSync(outsidePath)
    }
  })

  // AC2: Dado um arquivo novo com acentos e espaço no nome contendo um segredo, quando contain roda, então o segredo é detectado.
  // AC3: Dado esse mesmo arquivo, quando contain termina, então o caminho aparece na lista de arquivos alterados na forma legível, sem aspas nem escapes.
  test('secret_in_a_file_git_would_quote_is_caught', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1;\n')
    const initialCommit = await port.commit({ message: 'commit inicial' })

    // Criar src/acentuação ç.txt com 'gh' + 'p_' + 'a'.repeat(36)
    const specialFile = 'src/acentuação ç.txt'
    const githubToken = 'gh' + 'p_' + 'a'.repeat(36)
    writeFileSync(path.join(repo.dir, specialFile), githubToken)

    const result = await contain({
      git: port,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
    })

    // Exemplo: reason === 'secret' e changedPaths inclui 'src/acentuação ç.txt'
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('secret')
    expect(result.failureClass).toBe('security')
    expect(result.action).toBe('stop_batch')
    expect(result.changedPaths).toContain(specialFile)

    const secretViolation = result.violations.find(
      (v) => v.kind === 'secret' && v.path === specialFile,
    )
    expect(secretViolation).toBeDefined()
    expect(secretViolation?.pattern).toBe('github_token')

    // Exemplo: arquivos src/b.js e src/a.js alterados -> changedPaths === ['src/a.js', 'src/b.js'] (ordem alfabetica estavel).
    // git.dirtyPaths() do GitPort real já devolve os caminhos em ordem alfabética, então essa prova sozinha
    // não distingue um contain que ordena de um que só repassa a ordem do git. Por isso o mock abaixo devolve
    // dirtyPaths deliberadamente fora de ordem (b antes de a): só o .sort() dentro de contain() pode corrigir
    // isso para a ordem alfabética esperada.
    unlinkSync(path.join(repo.dir, specialFile))
    writeFileSync(path.join(srcDir, 'b.js'), 'export const b = 2;\n')
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 2;\n')

    const unorderedPort = {
      ...port,
      dirtyPaths: async () => ['src/b.js', 'src/a.js'],
    }
    const resOrdered = await contain({
      git: unorderedPort,
      unitId: 'S10',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
      sensitivePaths: [],
    })
    expect(resOrdered.changedPaths).toEqual(['src/a.js', 'src/b.js'])
  })

  // AC1: Dado um arquivo alterado fora do escopo e nenhuma violação anterior, quando contain roda,
  // então a árvore volta ao estado anterior e o resultado indica restauração.
  // AC2: Dado que a árvore foi restaurada e nada mais mudou, quando contain roda de novo,
  // então o resultado é falha semântica por ausência de mudanças.
  // AC3: Dado um arquivo fora do escopo e uma violação de escopo já registrada para a unidade,
  // quando contain roda, então a unidade é estacionada e a árvore permanece como estava, sem restauração.
  test('scope_expansion_restores_tree_then_parks_on_repeat', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir })

    // Criar repositório, commitar src/a.js
    const srcDir = path.join(repo.dir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1\n')
    await port.commit({ message: 'commit inicial' })

    // Guardar treeBefore = await git.worktreeTree()
    const treeBefore = await port.worktreeTree()

    // Validação: contain com scopeViolationCount 0 e treeBefore ausente, havendo violação de escopo -> lança TypeError
    const foraDir = path.join(repo.dir, 'fora')
    mkdirSync(foraDir, { recursive: true })
    const foraFile = path.join(foraDir, 'b.txt')
    writeFileSync(foraFile, 'conteudo fora do escopo\n')

    await expect(
      contain({
        git: port,
        unitId: 'S10',
        scopePaths: ['src/**'],
        scopeViolationCount: 0,
      }),
    ).rejects.toThrow(TypeError)

    // Primeira chamada com fora/b.txt fora do escopo e scopeViolationCount 0
    const firstResult = await contain({
      git: port,
      unitId: 'S10',
      treeBefore,
      scopePaths: ['src/**'],
      scopeViolationCount: 0,
    })

    // -> { ok: false, reason: 'scope', failureClass: 'scope', action: 'restore', restoredTree: <tree de treeBefore> }
    // e o arquivo desaparece do worktree
    expect(firstResult.ok).toBe(false)
    expect(firstResult.reason).toBe('scope')
    expect(firstResult.failureClass).toBe('scope')
    expect(firstResult.action).toBe('restore')
    expect(firstResult.restoredTree).toBe(treeBefore)
    expect(existsSync(foraFile)).toBe(false)

    // Segunda chamada logo após a restauração, árvore limpa
    // -> { ok: false, reason: 'no_changes', failureClass: 'semantic', action: 'rework' }
    const secondResult = await contain({
      git: port,
      unitId: 'S10',
      treeBefore,
      scopePaths: ['src/**'],
    })

    expect(secondResult.ok).toBe(false)
    expect(secondResult.reason).toBe('no_changes')
    expect(secondResult.failureClass).toBe('semantic')
    expect(secondResult.action).toBe('rework')

    // Terceira chamada com fora/b.txt recriado e scopeViolationCount 1
    // -> { ok: false, reason: 'scope', action: 'park', restoredTree: null }
    // e o arquivo continua existindo
    mkdirSync(foraDir, { recursive: true })
    writeFileSync(foraFile, 'conteudo fora do escopo\n')

    const thirdResult = await contain({
      git: port,
      unitId: 'S10',
      treeBefore,
      scopePaths: ['src/**'],
      scopeViolationCount: 1,
    })

    expect(thirdResult.ok).toBe(false)
    expect(thirdResult.reason).toBe('scope')
    expect(thirdResult.action).toBe('park')
    expect(thirdResult.restoredTree).toBeNull()
    expect(existsSync(foraFile)).toBe(true)
  })
})


