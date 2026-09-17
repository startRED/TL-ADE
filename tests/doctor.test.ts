import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'
import {
  ARGV_MAX_CHARS,
  assertArgvLimit,
  buildArgv,
  resolveBinary,
} from '../src/runner/resolve-binary.js'
import { AdeError } from '../src/journal/errors.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

describe('doctor - BinaryResolver', () => {
  // AC1: Dado um shim .cmd no padrão npm cujo executável do Node e script existem em disco,
  // quando a resolução roda, então devolve modo de shim npm apontando para o executável real e o script como primeiro argumento.
  test('doctor_resolves_npm_shim_to_real_exe_on_windows', () => {
    const dir = makeTmpDir('ade-shim-')
    tmpDirs.push(dir)

    const claudeCmdText =
      '@ECHO off\r\n' +
      'SETLOCAL\r\n' +
      'IF EXIST "%dp0%\\node.exe" (\r\n' +
      '  SET "_prog=%dp0%\\node.exe"\r\n' +
      ')\r\n' +
      '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n'

    const claudeCmd = path.join(dir, 'claude.cmd')
    writeFileSync(claudeCmd, claudeCmdText, 'utf8')

    const nodeExe = path.join(dir, 'node.exe')
    writeFileSync(nodeExe, 'x', 'utf8')

    const scriptDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
    mkdirSync(scriptDir, { recursive: true })
    const scriptJs = path.join(scriptDir, 'cli.js')
    writeFileSync(scriptJs, '//', 'utf8')

    const resolved = resolveBinary('claude', { platform: 'win32', pathEnv: dir })
    expect(resolved).toEqual({
      exe: nodeExe,
      prefixArgs: [scriptJs],
      mode: 'npm_shim',
      shim: claudeCmd,
    })

    const argv = buildArgv(resolved, ['--version'])
    expect(argv).toEqual([scriptJs, '--version'])

    // Exemplo 3: binário .exe nativo no PATH usa direto sem prefixArgs
    const toolExe = path.join(dir, 'tool.exe')
    writeFileSync(toolExe, 'binary', 'utf8')
    const resolvedNative = resolveBinary('tool', { platform: 'win32', pathEnv: dir })
    expect(resolvedNative).toEqual({
      exe: toolExe,
      prefixArgs: [],
      mode: 'native',
      shim: null,
    })
  })

  // AC2: Dado um .cmd sem nenhum caminho reconhecível do diretório do shim,
  // quando a resolução roda, então devolve a rota de fallback pelo interpretador de comandos com o próprio .cmd como argumento.
  test('doctor_falls_back_to_cmd_wrapper_on_unknown_shim_format', () => {
    const dir = makeTmpDir('ade-shim-')
    tmpDirs.push(dir)

    const weirdCmd = path.join(dir, 'weird.cmd')
    writeFileSync(weirdCmd, '@echo off\r\nrem sem dp0\r\n', 'utf8')

    const resolved = resolveBinary('weird', {
      platform: 'win32',
      pathEnv: dir,
      comspec: 'cmd.exe',
    })

    expect(resolved).toEqual({
      exe: 'cmd.exe',
      prefixArgs: ['/c', weirdCmd],
      mode: 'cmd_fallback',
      shim: weirdCmd,
    })

    const argv = buildArgv(resolved, ['status'])
    expect(argv).toEqual(['/c', weirdCmd, 'status'])
  })

  // AC3: Dado um comando que não existe em nenhum diretório do PATH informado,
  // quando a resolução roda, então lança erro do runtime com código de saída 2 e código binary_not_found.
  test('doctor_throws_binary_not_found_when_missing_from_path', () => {
    const dir = makeTmpDir('ade-shim-')
    tmpDirs.push(dir)

    // Exemplo 4: resolveBinary('nao-existe', {platform:'win32', pathEnv:'<dir>'})
    expect(() => {
      resolveBinary('nao-existe', { platform: 'win32', pathEnv: dir })
    }).toThrowError(AdeError)

    try {
      resolveBinary('nao-existe', { platform: 'win32', pathEnv: dir })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('binary_not_found')
      expect(adeErr.exitCode).toBe(2)
      expect(adeErr.details).toEqual({ command: 'nao-existe' })
    }

    // Validação defensiva: comando vazio ou inválido lança TypeError
    expect(() => {
      resolveBinary('', { platform: 'win32', pathEnv: dir })
    }).toThrowError(TypeError)
    expect(() => {
      resolveBinary(null as unknown as string, { platform: 'win32', pathEnv: dir })
    }).toThrowError(TypeError)
  })

  // AC4: Dado um conjunto de argumentos cuja soma passa do teto de caracteres,
  // quando a validação de tamanho roda, então lança argv_too_long antes de qualquer execução.
  test('doctor_enforces_argv_limit_under_thirty_thousand_chars', () => {
    expect(ARGV_MAX_CHARS).toBe(30000)

    // Dentro do limite: assertArgvLimit('node', ['a']) -> undefined
    expect(() => {
      assertArgvLimit('node', ['a'])
    }).not.toThrow()

    // Fronteira exata de 30000 caracteres ('node' + ' ' + 29995 chars = 30000): não deve lançar
    expect(() => {
      assertArgvLimit('node', ['a'.repeat(29995)])
    }).not.toThrow()

    // Exemplo 5: assertArgvLimit('node', ['a'.repeat(29999)]) -> lança AdeError 'argv_too_long'
    expect(() => {
      assertArgvLimit('node', ['a'.repeat(29999)])
    }).toThrowError(AdeError)

    try {
      assertArgvLimit('node', ['a'.repeat(29999)])
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('argv_too_long')
      expect(adeErr.exitCode).toBe(2)
      expect(adeErr.details?.limit).toBe(30000)
      expect(typeof adeErr.details?.total).toBe('number')
      expect((adeErr.details?.total as number) >= 30000).toBe(true)
    }
  })
})
