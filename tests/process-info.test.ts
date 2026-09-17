import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.js'
import { getProcessStartTime, isProcessAlive } from '../src/lease/process-info.js'

type GetProcessStartTimeFn = (
  pid: number,
  deps?: {
    platform?: string
    readFile?: (path: string) => Promise<string>
    execFile?: (file: string, args: string[]) => Promise<string>
  },
) => Promise<string | null>

type IsProcessAliveFn = (
  pid: number,
  killImpl?: (pid: number, signal: number) => unknown,
) => boolean

const getStartTime = getProcessStartTime as unknown as GetProcessStartTimeFn
const checkAlive = isProcessAlive as unknown as IsProcessAliveFn

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

function _createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-process-info-'))
  tmpDirs.push(dir)
  return dir
}

describe('process info', () => {
  // AC1: Linux extrai o campo 22 após o último ')' e junta com boot_id
  test('linux_start_time_is_boot_id_plus_field_22', async () => {
    // Caso com nome de processo contendo espaços e parênteses estranhos
    const readFileWeird = async (p: string): Promise<string> => {
      if (p.endsWith('/stat')) {
        return '1234 (my (weird) proc) S 1 1234 1234 0 -1 4194304 500 0 0 0 10 5 0 0 20 0 1 0 987654 1000000 200'
      }
      if (p.endsWith('boot_id')) {
        return 'abc-123\n'
      }
      throw new Error(`caminho inesperado: ${p}`)
    }

    const resultWeird = await getStartTime(1234, {
      platform: 'linux',
      readFile: readFileWeird,
    })
    expect(resultWeird).toBe('abc-123:987654')

    // Caso padrão com stat típico de node
    const readFileStandard = async (p: string): Promise<string> => {
      if (p.endsWith('/stat')) {
        return '1234 (node) S 1 1234 1234 0 -1 4194304 500 0 0 0 10 5 0 0 20 0 1 0 987654 1000000 200'
      }
      if (p.endsWith('boot_id')) {
        return 'abc-123\n'
      }
      throw new Error(`caminho inesperado: ${p}`)
    }

    const resultStandard = await getStartTime(1234, {
      platform: 'linux',
      readFile: readFileStandard,
    })
    expect(resultStandard).toBe('abc-123:987654')
  })

  // AC1: Processo inexistente no Linux (ENOENT ou ESRCH) devolve null
  test('linux_missing_process_is_null', async () => {
    const readFileEnoent = async (p: string): Promise<string> => {
      if (p.endsWith('/stat')) {
        throw Object.assign(new Error('Processo inexistente'), { code: 'ENOENT' })
      }
      return 'boot-id-ok'
    }
    const resultEnoent = await getStartTime(1234, {
      platform: 'linux',
      readFile: readFileEnoent,
    })
    expect(resultEnoent).toBeNull()

    const readFileEsrch = async (p: string): Promise<string> => {
      if (p.endsWith('/stat')) {
        throw Object.assign(new Error('Processo inexistente'), { code: 'ESRCH' })
      }
      return 'boot-id-ok'
    }
    const resultEsrch = await getStartTime(1234, {
      platform: 'linux',
      readFile: readFileEsrch,
    })
    expect(resultEsrch).toBeNull()
  })

  // AC3: Falha ao ler boot_id no Linux rejeita com o erro original
  test('linux_boot_id_failure_rejects', async () => {
    const bootIdError = Object.assign(new Error('Permissão negada para boot_id'), {
      code: 'EACCES',
    })
    const readFile = async (p: string): Promise<string> => {
      if (p.endsWith('/stat')) {
        return '1234 (node) S 1 1234 1234 0 -1 4194304 500 0 0 0 10 5 0 0 20 0 1 0 987654 1000000 200'
      }
      if (p.endsWith('boot_id')) {
        throw bootIdError
      }
      throw new Error(`caminho inesperado: ${p}`)
    }

    let caught: unknown = null
    try {
      await getStartTime(1234, { platform: 'linux', readFile })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(bootIdError)
  })

  // AC2: Windows chama powershell com Win32_Process e extrai CreationDate em ISO UTC
  test('windows_start_time_comes_from_cim_creation_date', async () => {
    let capturedFile = ''
    let capturedArgs: string[] = []

    const execFile = async (file: string, args: string[]): Promise<string> => {
      capturedFile = file
      capturedArgs = args
      return '2026-09-17T11:59:58.1234567Z\r\n'
    }

    const result = await getStartTime(1234, {
      platform: 'win32',
      execFile,
    })

    expect(result).toBe('2026-09-17T11:59:58.1234567Z')
    expect(capturedFile).toBe('powershell.exe')
    expect(capturedArgs).toContain('-NoProfile')
    expect(capturedArgs).toContain('-NonInteractive')
    expect(capturedArgs).toContain('-Command')
    expect(capturedArgs.some((arg) => arg.includes('ProcessId=1234'))).toBe(true)
  })

  // AC2: Processo inexistente no Windows (saída vazia) devolve null
  test('windows_missing_process_is_null', async () => {
    const execFileEmpty = async (): Promise<string> => ''
    const resultEmpty = await getStartTime(1234, {
      platform: 'win32',
      execFile: execFileEmpty,
    })
    expect(resultEmpty).toBeNull()

    const execFileWhitespace = async (): Promise<string> => '   \r\n  '
    const resultWhitespace = await getStartTime(1234, {
      platform: 'win32',
      execFile: execFileWhitespace,
    })
    expect(resultWhitespace).toBeNull()
  })

  // AC3: Falhas de leitura operacionais rejeitam e não viram null
  test('read_failures_reject_instead_of_returning_null', async () => {
    // Falha operacional no Windows (ex: EACCES) rejeita com o erro original
    const winError = Object.assign(new Error('Acesso negado no Windows'), { code: 'EACCES' })
    let caughtWin: unknown = null
    try {
      await getStartTime(1234, {
        platform: 'win32',
        execFile: async () => {
          throw winError
        },
      })
    } catch (err) {
      caughtWin = err
    }
    expect(caughtWin).toBe(winError)

    // Falha operacional no Linux ao ler stat (ex: EACCES, não ENOENT/ESRCH) rejeita com o erro original
    const linuxError = Object.assign(new Error('Acesso negado no stat'), { code: 'EACCES' })
    let caughtLinux: unknown = null
    try {
      await getStartTime(1234, {
        platform: 'linux',
        readFile: async () => {
          throw linuxError
        },
      })
    } catch (err) {
      caughtLinux = err
    }
    expect(caughtLinux).toBe(linuxError)

    // Stat com ticks corrompidos rejeita com AdeError 'process_info_unavailable' e exitCode 3
    const readFileCorrupted = async (p: string): Promise<string> => {
      if (p.endsWith('/stat')) {
        return '1234 (node) S 1 1234 1234 0 -1 4194304 500 0 0 0 10 5 0 0 20 0 1 0 NOT_NUMERIC 1000000 200'
      }
      return 'boot-id-ok'
    }
    let caughtCorrupt: unknown = null
    try {
      await getStartTime(1234, {
        platform: 'linux',
        readFile: readFileCorrupted,
      })
    } catch (err) {
      caughtCorrupt = err
    }
    expect(caughtCorrupt).toBeInstanceOf(AdeError)
    const adeCorrupt = caughtCorrupt as AdeError
    expect(adeCorrupt.code).toBe('process_info_unavailable')
    expect(adeCorrupt.exitCode).toBe(3)
  })

  // AC3: Plataforma sem suporte rejeita com AdeError 'unsupported_platform' e exitCode 2
  test('unsupported_platform_is_refused', async () => {
    let caught: unknown = null
    try {
      await getStartTime(1234, { platform: 'darwin' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AdeError)
    const adeErr = caught as AdeError
    expect(adeErr.code).toBe('unsupported_platform')
    expect(adeErr.exitCode).toBe(2)
  })

  // AC4: isProcessAlive mapeia ESRCH para false, EPERM para true e passa (pid, 0)
  test('is_process_alive_maps_esrch_and_eperm', () => {
    let killCalls: Array<{ pid: number; signal: number }> = []

    // Caso 1: processo existe e responde ao sinal 0 sem erro
    const killOk = (pid: number, sig: number): void => {
      killCalls.push({ pid, signal: sig })
    }
    const aliveOk = checkAlive(1234, killOk)
    expect(aliveOk).toBe(true)
    expect(killCalls).toEqual([{ pid: 1234, signal: 0 }])

    // Caso 2: processo inexistente (ESRCH) devolve false
    killCalls = []
    const killEsrch = (pid: number, sig: number): void => {
      killCalls.push({ pid, signal: sig })
      throw Object.assign(new Error('Processo não encontrado'), { code: 'ESRCH' })
    }
    const aliveEsrch = checkAlive(1234, killEsrch)
    expect(aliveEsrch).toBe(false)
    expect(killCalls).toEqual([{ pid: 1234, signal: 0 }])

    // Caso 3: permissão negada (EPERM) indica que o processo existe
    killCalls = []
    const killEperm = (pid: number, sig: number): void => {
      killCalls.push({ pid, signal: sig })
      throw Object.assign(new Error('Permissão negada'), { code: 'EPERM' })
    }
    const aliveEperm = checkAlive(1234, killEperm)
    expect(aliveEperm).toBe(true)
    expect(killCalls).toEqual([{ pid: 1234, signal: 0 }])

    // Caso 4: erro inesperado (ex: EINVAL) relança o erro original
    const unexpectedErr = Object.assign(new Error('Sinal inválido'), { code: 'EINVAL' })
    const killUnexpected = (): void => {
      throw unexpectedErr
    }
    expect(() => checkAlive(1234, killUnexpected)).toThrow(unexpectedErr)
  })

  // AC4: PID inválido (não inteiro positivo) lança TypeError nas duas funções
  test('invalid_pid_is_a_type_error', async () => {
    const invalidPids = [0, -1, -100, 1.5, NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]

    for (const badPid of invalidPids) {
      // isProcessAlive síncrono
      expect(() => checkAlive(badPid)).toThrow(TypeError)
      expect(() => checkAlive(badPid)).toThrow(`pid inválido: ${badPid}`)

      // getProcessStartTime assíncrono
      let caught: unknown = null
      try {
        await getStartTime(badPid)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(TypeError)
      expect((caught as TypeError).message).toBe(`pid inválido: ${badPid}`)
    }
  })

  // Teste de fumaça real no próprio processo
  test.skipIf(process.platform !== 'win32' && process.platform !== 'linux')(
    'own_process_has_a_stable_start_time',
    async () => {
      const t1 = await getStartTime(process.pid)
      const t2 = await getStartTime(process.pid)
      expect(typeof t1).toBe('string')
      expect(t1!.length).toBeGreaterThan(0)
      expect(t1).toBe(t2)
      expect(checkAlive(process.pid)).toBe(true)
    },
    30000,
  )
})
