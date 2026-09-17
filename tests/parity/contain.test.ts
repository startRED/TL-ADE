import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
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
})
