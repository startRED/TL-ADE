import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
// Importações da failure-policy a implementar na fase 2
import {
  FAILURE_CLASSES,
  RETRY_LIMITS,
  chargeOfClass,
  classifyFailure,
  movementOf,
  runWithPolicy,
} from '../../src/runner/failure-policy.ts'
import { readReceipt } from '../../src/runner/receipt.ts'
// Importações do runner a implementar na fase 2
import {
  WORKER_ENV_ALLOWLIST,
  buildWorkerEnv,
  killTree,
  runWorker,
} from '../../src/runner/spawn.ts'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')

describe('runner parity', () => {
  let tmpDir: string

  const ORIGINAL_ENV = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    GH_TOKEN: process.env.GH_TOKEN,
    MEU_SEGREDO: process.env.MEU_SEGREDO,
  }

  beforeEach(() => {
    tmpDir = makeTmpDir('ade-runner-')
  })

  afterEach(() => {
    if (ORIGINAL_ENV.ANTHROPIC_BASE_URL === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = ORIGINAL_ENV.ANTHROPIC_BASE_URL
    }

    if (ORIGINAL_ENV.GH_TOKEN === undefined) {
      delete process.env.GH_TOKEN
    } else {
      process.env.GH_TOKEN = ORIGINAL_ENV.GH_TOKEN
    }

    if (ORIGINAL_ENV.MEU_SEGREDO === undefined) {
      delete process.env.MEU_SEGREDO
    } else {
      process.env.MEU_SEGREDO = ORIGINAL_ENV.MEU_SEGREDO
    }

    removeTmpDir(tmpDir)
  })

  // AC1: Dado segredos plantados no ambiente do processo de teste, quando o worker roda e registra as variáveis
  // que recebeu, então só aparecem as da allowlist mais as duas de telemetria desligada, e nenhuma chave de provedor ou token.
  test('worker_env_is_scrubbed', async () => {
    const CONTRACTED_ALLOWLIST = [
      'PATH',
      'Path',
      'SYSTEMROOT',
      'SystemRoot',
      'COMSPEC',
      'ComSpec',
      'PATHEXT',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'LANG',
      'LC_ALL',
    ]
    expect(WORKER_ENV_ALLOWLIST).toEqual(CONTRACTED_ALLOWLIST)

    // Prova de buildWorkerEnv isolada
    const scrubbed = buildWorkerEnv({
      ADE_FAKE_ROLE: 'maker',
      ANTHROPIC_BASE_URL: 'http://x',
    })
    expect(scrubbed.ADE_FAKE_ROLE).toBe('maker')
    expect(scrubbed).not.toHaveProperty('ANTHROPIC_BASE_URL')
    expect(scrubbed.DO_NOT_TRACK).toBe('1')
    expect(scrubbed.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')

    const allowedScrubbedSet = new Set([
      ...CONTRACTED_ALLOWLIST,
      'DO_NOT_TRACK',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'ADE_FAKE_ROLE',
    ])
    for (const key of Object.keys(scrubbed)) {
      expect(allowedScrubbedSet.has(key), `Chave não permitida no buildWorkerEnv: ${key}`).toBe(true)
    }

    // Planta segredos no processo de teste
    process.env.ANTHROPIC_BASE_URL = 'http://x'
    process.env.GH_TOKEN = 'tok'
    process.env.MEU_SEGREDO = 's3cr3t'

    const scriptPath = path.join(tmpDir, 'env-worker.js')
    const outEnvFile = path.join(tmpDir, 'env-keys.json')
    writeFileSync(
      scriptPath,
      'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], JSON.stringify(Object.keys(process.env).sort()));\n',
    )

    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: [process.execPath, scriptPath, outEnvFile],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }

    const res = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [] },
      args: [scriptPath, outEnvFile],
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      env: { ADE_FAKE_ROLE: 'maker', ANTHROPIC_BASE_URL: 'http://x' },
      now: () => '2026-09-17T00:00:00.000Z',
      getStartTime: async () => '2026-09-17T00:00:01.000Z',
    })

    expect(res.state).toBe('exited')
    expect(res.reason).toBe('exit')
    expect(res.exitCode).toBe(0)

    const recordedKeys: string[] = JSON.parse(readFileSync(outEnvFile, 'utf8'))
    expect(recordedKeys).not.toContain('ANTHROPIC_BASE_URL')
    expect(recordedKeys).not.toContain('GH_TOKEN')
    expect(recordedKeys).not.toContain('MEU_SEGREDO')
    expect(recordedKeys).toContain('DO_NOT_TRACK')
    expect(recordedKeys).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY')
    expect(recordedKeys).toContain('ADE_FAKE_ROLE')

    const platformInjected =
      process.platform === 'win32'
        ? [
            'HOMEDRIVE',
            'HOMEPATH',
            'LOGONSERVER',
            'SYSTEMDRIVE',
            'USERDOMAIN',
            'USERNAME',
            'WINDIR',
          ]
        : []

    const allowedRecordedSet = new Set([
      ...CONTRACTED_ALLOWLIST,
      'DO_NOT_TRACK',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'ADE_FAKE_ROLE',
      ...platformInjected,
    ])
    for (const key of recordedKeys) {
      expect(allowedRecordedSet.has(key), `Variável inesperada no ambiente: ${key}`).toBe(true)
    }
  }, 20000)

  // Regressão: runWorker deve repassar maxBuffer: 1 << 26 para o spawnImpl, para não truncar stdout/stderr grandes.
  test('run_worker_passes_max_buffer_to_spawn_impl', async () => {
    const baseRequest = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'script.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }

    let capturedOptions: Record<string, unknown> | null = null

    const listeners: Record<string, (...args: unknown[]) => void> = {}
    const fakeChild = {
      pid: 4242,
      stdout: null,
      stderr: null,
      once(event: string, handler: (...args: unknown[]) => void) {
        listeners[event] = handler
      },
      kill() {},
    }

    const fakeSpawnImpl = (_exe: string, _args: string[], options: Record<string, unknown>) => {
      capturedOptions = options
      queueMicrotask(() => {
        listeners.close?.(0)
      })
      return fakeChild
    }

    const res = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [] },
      args: [],
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId: 's1-maxbuffer',
      request: baseRequest,
      now: () => '2026-09-17T00:00:00.000Z',
      getStartTime: async () => '2026-09-17T00:00:01.000Z',
      spawnImpl: fakeSpawnImpl,
    })

    expect(res.state).toBe('exited')
    expect(res.exitCode).toBe(0)
    expect(capturedOptions).toMatchObject({ maxBuffer: 1 << 26 })
  }, 20000)

  // AC2: Dado um caminho de executável inexistente, quando o worker é disparado, então o resultado é falha de partida,
  // classe de ambiente, chamada não cobrada, e o recibo em disco fica no estado de falha de partida sem identidade de processo.
  test('missing_harness_executable_is_environment_and_not_charged', async () => {
    const nonExistentExe = path.join(tmpDir, 'nao-existe.exe')
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: [nonExistentExe],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }

    const res = await runWorker({
      resolved: { exe: nonExistentExe, prefixArgs: [] },
      args: [],
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
      getStartTime: async () => '2026-09-17T00:00:01.000Z',
    })

    expect(res).toMatchObject({
      state: 'start_failed',
      reason: 'spawn_error',
      exitCode: null,
      pid: null,
      charge: 'released',
      failureClass: 'environment',
    })

    const receipt = readReceipt(res.receiptFile)
    expect(receipt!.state).toBe('start_failed')
    expect(receipt!.process_fingerprint).toBeNull()
    expect(receipt!.reason).toBe('spawn_error')
    expect(receipt!.exit_code).toBeNull()
  }, 20000)

  // AC3: Dado um worker que dorme mais que o teto de tempo, quando o teto estoura, então o processo é morto,
  // o resultado é tempo esgotado e o recibo em disco registra o mesmo estado terminal.
  test('worker_timeout_kills_tree_and_writes_timeout_receipt', async () => {
    expect(typeof killTree).toBe('function')

    // Prova de killTree fora do win32 (chama child.kill('SIGKILL'))
    let killedWith: string | undefined
    killTree(1234, {
      platform: 'linux',
      child: {
        kill: (sig: string) => {
          killedWith = sig
        },
      },
    })
    expect(killedWith).toBe('SIGKILL')

    // Prova de killTree fora do win32 sem child (não lança nem chama process.kill)
    expect(() => killTree(1234, { platform: 'linux' })).not.toThrow()

    // Prova de killTree no win32 (chama taskkill /T /F /PID)
    let execCalls: { file: string; args: string[] }[] = []
    killTree(1234, {
      platform: 'win32',
      execFileSync: (file: string, args: string[]) => {
        execCalls.push({ file, args })
      },
    })
    expect(execCalls).toEqual([
      { file: 'taskkill', args: ['/T', '/F', '/PID', '1234'] },
    ])

    const baseRequest = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'script.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }

    // Exemplo: runWorker com timeoutS: 0 -> lança TypeError('timeoutS inválido') antes de qualquer spawn
    await expect(
      runWorker({
        resolved: { exe: process.execPath, prefixArgs: [] },
        cwd: tmpDir,
        missionDir: tmpDir,
        missionId: 'm1',
        stepId: 's1-inv-timeout',
        request: baseRequest,
        timeoutS: 0,
      }),
    ).rejects.toThrow(new TypeError('timeoutS inválido'))

    // Exemplo: worker que dorme 10s com timeoutS: 1
    const sleepScript = path.join(tmpDir, 'sleep.js')
    writeFileSync(sleepScript, 'setTimeout(() => {}, 10000);\n')

    const timeoutRequest = {
      ...baseRequest,
      argv: [process.execPath, sleepScript],
    }

    const resTimeout = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [] },
      args: [sleepScript],
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId: 's1-timeout',
      request: timeoutRequest,
      timeoutS: 1,
      now: () => '2026-09-17T00:00:00.000Z',
      getStartTime: async () => '2026-09-17T00:00:01.000Z',
    })

    expect(resTimeout.state).toBe('timeout')
    expect(resTimeout.reason).toBe('timeout')
    expect(resTimeout.charge).toBe('charged')

    const receiptTimeout = readReceipt(resTimeout.receiptFile)
    expect(receiptTimeout!.state).toBe('timeout')
    expect(receiptTimeout!.reason).toBe('timeout')

    // Exemplo: worker process.exit(3) sem vigias -> {state:'crashed', reason:'exit', exitCode:3}
    const crashScript = path.join(tmpDir, 'crash.js')
    writeFileSync(crashScript, 'process.exit(3);\n')

    const crashRequest = {
      ...baseRequest,
      argv: [process.execPath, crashScript],
    }

    const resCrash = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [] },
      args: [crashScript],
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId: 's1-crash',
      request: crashRequest,
      now: () => '2026-09-17T00:00:00.000Z',
      getStartTime: async () => '2026-09-17T00:00:01.000Z',
    })

    expect(resCrash.state).toBe('crashed')
    expect(resCrash.reason).toBe('exit')
    expect(resCrash.exitCode).toBe(3)
    expect(resCrash.charge).toBe('charged')

    const receiptCrash = readReceipt(resCrash.receiptFile)
    expect(receiptCrash!.state).toBe('crashed')
    expect(receiptCrash!.exit_code).toBe(3)
  }, 20000)

  // AC4: Dado um worker que nunca atualiza o arquivo de heartbeat além do prazo, quando o vigia dispara,
  // então o processo é morto e o resultado indica encerramento por ausência de sinal de vida.
  test('worker_without_heartbeat_is_killed_by_dead_man_switch', async () => {
    const baseRequest = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'script.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }

    // Exemplo: runWorker com heartbeatTimeoutS: 0 -> lança TypeError('heartbeatTimeoutS inválido')
    await expect(
      runWorker({
        resolved: { exe: process.execPath, prefixArgs: [] },
        cwd: tmpDir,
        missionDir: tmpDir,
        missionId: 'm1',
        stepId: 's1-inv-hb',
        request: baseRequest,
        heartbeatTimeoutS: 0,
      }),
    ).rejects.toThrow(new TypeError('heartbeatTimeoutS inválido'))

    // Exemplo: worker setTimeout(() => {}, 10000) com heartbeatPath nunca tocado e heartbeatTimeoutS 1
    const sleepScript = path.join(tmpDir, 'sleep-dm.js')
    writeFileSync(sleepScript, 'setTimeout(() => {}, 10000);\n')

    const heartbeatPath = path.join(tmpDir, 'heartbeat-never-touched.txt')

    const deadManRequest = {
      ...baseRequest,
      argv: [process.execPath, sleepScript],
    }

    const resDeadMan = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [] },
      args: [sleepScript],
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId: 's1-deadman',
      request: deadManRequest,
      heartbeatPath,
      heartbeatTimeoutS: 1,
      now: () => '2026-09-17T00:00:00.000Z',
      getStartTime: async () => '2026-09-17T00:00:01.000Z',
    })

    expect(resDeadMan.state).toBe('timeout')
    expect(resDeadMan.reason).toBe('dead_man')
    expect(resDeadMan.charge).toBe('charged')

    const receiptDeadMan = readReceipt(resDeadMan.receiptFile)
    expect(receiptDeadMan!.state).toBe('timeout')
    expect(receiptDeadMan!.reason).toBe('dead_man')
  }, 20000)

  // AC1: Dado um harness que cai em toda invocação, quando a política roda,
  // então há exatamente uma repetição, uma única espera de cem milissegundos e o desfecho é estacionado por classe de harness.
  test('harness_crash_retries_once_then_parks', async () => {
    expect(movementOf('harness')).toBe('retry')
    expect(chargeOfClass('harness')).toBe('charged')
    expect(RETRY_LIMITS.harness).toBe(1)

    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/harness-crash')
    const scenarioDest = path.join(tmpDir, 'scenario-harness-crash')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'out.json')
    const packPath = path.join(tmpDir, 'pack.md')
    writeFileSync(packPath, '# pack\n')

    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async (_attempt: number) => {
      return runWorker({
        resolved: { exe: process.execPath, prefixArgs: [] },
        args: [CLI_PATH, packPath],
        cwd: tmpDir,
        missionDir: tmpDir,
        missionId: 'm1',
        stepId: 's1-harness-crash',
        request: {
          unit: 's1',
          authorization: 'd0',
          cwd: tmpDir,
          argv: [process.execPath, CLI_PATH, packPath],
          timeout: 120,
          result_file: resultFile,
        },
        env: {
          ADE_FAKE_SCENARIO: scenarioDest,
          ADE_FAKE_ROLE: 'maker',
          ADE_FAKE_RESULT_FILE: resultFile,
        },
        now: () => '2026-09-17T00:00:00.000Z',
        getStartTime: async () => null,
      })
    }

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'parked',
      attempts: 2,
      delaysMs: [100],
      failureClass: 'harness',
      reason: 'harness_retries_exhausted',
      charge: 'charged',
      batchStopped: false,
    })
    expect(delays).toEqual([100])
  }, 20000)

  // AC2: Dada uma primeira invocação que falha com mensagem de limite de taxa e uma segunda que conclui bem,
  // quando a política roda, então houve uma espera antes da repetição e o desfecho é sucesso na segunda tentativa.
  test('transient_failure_retries_with_backoff_then_succeeds', async () => {
    expect(
      classifyFailure({
        state: 'crashed',
        exitCode: 1,
        stderr: '429 rate limit exceeded',
      }),
    ).toBe('transient')
    expect(movementOf('transient')).toBe('retry')
    expect(chargeOfClass('transient')).toBe('charged')
    expect(RETRY_LIMITS.transient).toBe(3)

    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/transient-then-ok')
    const scenarioDest = path.join(tmpDir, 'scenario-transient-then-ok')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'out.json')
    const packPath = path.join(tmpDir, 'pack.md')
    writeFileSync(packPath, '# pack\n')

    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async (_attempt: number) => {
      return runWorker({
        resolved: { exe: process.execPath, prefixArgs: [] },
        args: [CLI_PATH, packPath],
        cwd: tmpDir,
        missionDir: tmpDir,
        missionId: 'm1',
        stepId: 's1-transient-ok',
        request: {
          unit: 's1',
          authorization: 'd0',
          cwd: tmpDir,
          argv: [process.execPath, CLI_PATH, packPath],
          timeout: 120,
          result_file: resultFile,
        },
        env: {
          ADE_FAKE_SCENARIO: scenarioDest,
          ADE_FAKE_ROLE: 'maker',
          ADE_FAKE_RESULT_FILE: resultFile,
        },
        now: () => '2026-09-17T00:00:00.000Z',
        getStartTime: async () => null,
      })
    }

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'ok',
      attempts: 2,
      delaysMs: [100],
      failureClass: null,
      charge: 'charged',
      batchStopped: false,
      reason: null,
    })
    expect(delays).toEqual([100])
  }, 20000)

  // AC3: Dado um resultado de unidade que declara bloqueio por autorização,
  // quando a política roda, então não há nenhuma repetição, o lote é marcado como parado e o desfecho registra a classe de autorização.
  test('maker_blocked_on_authorization_stops_batch', async () => {
    expect(
      classifyFailure({
        state: 'exited',
        exitCode: 0,
        resultPresent: true,
        unitResult: { outcome: 'blocked', blocker: 'authorization' },
      }),
    ).toBe('authorization')
    expect(movementOf('authorization')).toBe('stop')
    expect(chargeOfClass('authorization')).toBe('charged')

    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/authorization-block')
    const scenarioDest = path.join(tmpDir, 'scenario-authorization-block')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'out.json')
    const packPath = path.join(tmpDir, 'pack.md')
    writeFileSync(packPath, '# pack\n')

    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async (_attempt: number) => {
      return runWorker({
        resolved: { exe: process.execPath, prefixArgs: [] },
        args: [CLI_PATH, packPath],
        cwd: tmpDir,
        missionDir: tmpDir,
        missionId: 'm1',
        stepId: 's1-auth-block',
        request: {
          unit: 's1',
          authorization: 'd0',
          cwd: tmpDir,
          argv: [process.execPath, CLI_PATH, packPath],
          timeout: 120,
          result_file: resultFile,
        },
        env: {
          ADE_FAKE_SCENARIO: scenarioDest,
          ADE_FAKE_ROLE: 'maker',
          ADE_FAKE_RESULT_FILE: resultFile,
        },
        now: () => '2026-09-17T00:00:00.000Z',
        getStartTime: async () => null,
      })
    }

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'stopped',
      attempts: 1,
      delaysMs: [],
      failureClass: 'authorization',
      charge: 'charged',
      batchStopped: true,
      reason: 'authorization',
    })
    expect(delays).toEqual([])
  }, 20000)

  // AC4: Dado um executável ausente, quando a política roda,
  // então o desfecho é estacionado por classe de ambiente, sem nenhuma repetição e com a chamada não cobrada.
  test('missing_executable_parks_as_environment_without_retry', async () => {
    expect(classifyFailure({ state: 'start_failed', exitCode: null })).toBe('environment')
    expect(movementOf('environment')).toBe('park')
    expect(chargeOfClass('environment')).toBe('released')
    expect(FAILURE_CLASSES).toContain('environment')

    const nonExistentExe = path.join(tmpDir, 'nao-existe.exe')
    const resultFile = path.join(tmpDir, 'out.json')
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async (_attempt: number) => {
      return runWorker({
        resolved: { exe: nonExistentExe, prefixArgs: [] },
        args: [],
        cwd: tmpDir,
        missionDir: tmpDir,
        missionId: 'm1',
        stepId: 's1-missing-exe',
        request: {
          unit: 's1',
          authorization: 'd0',
          cwd: tmpDir,
          argv: [nonExistentExe],
          timeout: 120,
          result_file: resultFile,
        },
        now: () => '2026-09-17T00:00:00.000Z',
        getStartTime: async () => null,
      })
    }

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'parked',
      attempts: 1,
      delaysMs: [],
      failureClass: 'environment',
      charge: 'released',
      batchStopped: false,
      reason: 'environment',
    })
    expect(delays).toEqual([])
  }, 20000)

  test('runner_with_budget_failure_class_stops_batch_without_delays', async () => {
    const resultFile = path.join(tmpDir, 'out.json')
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async () => ({
      state: 'crashed',
      exitCode: 1,
      failureClass: 'budget',
    })

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'stopped',
      attempts: 1,
      delaysMs: [],
      failureClass: 'budget',
      charge: 'charged',
      batchStopped: true,
      reason: 'budget',
    })
    expect(delays).toEqual([])
  }, 20000)

  test('runner_with_security_failure_class_stops_batch_without_delays', async () => {
    const resultFile = path.join(tmpDir, 'out.json')
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async () => ({
      state: 'crashed',
      exitCode: 1,
      failureClass: 'security',
    })

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'stopped',
      attempts: 1,
      delaysMs: [],
      failureClass: 'security',
      charge: 'charged',
      batchStopped: true,
      reason: 'security',
    })
    expect(delays).toEqual([])
  }, 20000)

  test('runner_with_state_integrity_failure_class_stops_batch_without_delays', async () => {
    const resultFile = path.join(tmpDir, 'out.json')
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }

    const runner = async () => ({
      state: 'crashed',
      exitCode: 1,
      failureClass: 'state_integrity',
    })

    const res = await runWithPolicy({
      runner,
      resultFile,
      sleep,
    })

    expect(res).toEqual({
      outcome: 'stopped',
      attempts: 1,
      delaysMs: [],
      failureClass: 'state_integrity',
      charge: 'charged',
      batchStopped: true,
      reason: 'state_integrity',
    })
    expect(delays).toEqual([])
  }, 20000)

  test('runner_with_invalid_failure_class_throws_type_error', async () => {
    const resultFile = path.join(tmpDir, 'out.json')
    const runner = async () => ({
      state: 'crashed',
      exitCode: 1,
      failureClass: 'invalid_class',
    })

    await expect(
      runWithPolicy({
        runner,
        resultFile,
      }),
    ).rejects.toThrow(new TypeError('classe de falha inválida'))
  }, 20000)

  // Leitura do result file é efeito de sistema injetável: sem dublê, nenhum arquivo real é tocado.
  test('run_with_policy_reads_result_via_injected_double', async () => {
    const resultFile = path.join(tmpDir, 'result-nao-existe.json')
    const reads: string[] = []
    const readResult = (file: string) => {
      reads.push(file)
      return { resultPresent: true, unitResult: { outcome: 'ok' } }
    }

    const runner = async () => ({ state: 'exited', exitCode: 0 })

    const res = await runWithPolicy({
      runner,
      resultFile,
      readResult,
    })

    expect(reads).toEqual([resultFile])
    expect(res).toEqual({
      outcome: 'ok',
      attempts: 1,
      delaysMs: [],
      failureClass: null,
      charge: 'charged',
      batchStopped: false,
      reason: null,
    })
  }, 20000)
})

