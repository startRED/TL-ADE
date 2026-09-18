import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.js'
import {
  RECEIPT_STATES,
  chargeOf,
  isValidFingerprint,
  isValidRequest,
  readReceipt,
  receiptPath,
  requestDigest,
  startingReceipt,
  withRunning,
  withTerminal,
  writeReceipt,
} from '../src/runner/receipt.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

describe('receipt', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('ade-receipt-')
  })

  afterEach(() => {
    removeTmpDir(tmpDir)
  })

  test('receipt_written_before_spawn_is_readable_by_another_process_as_starting', () => {
    const file = receiptPath(tmpDir, 's1-maker')
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const receipt = startingReceipt({
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    writeReceipt(file, receipt)

    // Processo Node frio e separado, sem IPC
    const raw = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', file],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const parsed = JSON.parse(raw)

    expect(parsed.schema).toBe(1)
    expect(parsed.state).toBe('starting')
    expect(parsed.mission_id).toBe('m1')
    expect(parsed.step_id).toBe('s1-maker')
    expect(parsed.request_digest).toBe(requestDigest(request))
    expect(parsed.request).toEqual(request)
    expect(parsed.process_fingerprint).toBeNull()
    expect(parsed.started_at).toBe('2026-09-17T00:00:00.000Z')
    expect(parsed.exited_at).toBeNull()
    expect(parsed.exit_code).toBeNull()
    expect(parsed.reason).toBeNull()

    const read = readReceipt(file)
    expect(read).toEqual(parsed)
  })

  test(
    'receipt_running_state_is_readable_mid_flight_by_a_cold_process',
    () => {
      const file = receiptPath(tmpDir, 's1-maker')
      const request = {
        unit: 's1',
        authorization: 'd0',
        cwd: tmpDir,
        argv: ['node', 'cli.js'],
        timeout: 120,
        result_file: path.join(tmpDir, 'out.json'),
      }
      const initial = startingReceipt({
        missionId: 'm1',
        stepId: 's1-maker',
        request,
        now: () => '2026-09-17T00:00:00.000Z',
      })
      writeReceipt(file, initial)

      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      try {
        const fingerprint = {
          pid: child.pid!,
          start_time: '2026-09-17T00:00:01.000Z',
          host: 'maquina',
        }
        const running = withRunning(initial, fingerprint, '2026-09-17T00:00:01.000Z')
        writeReceipt(file, running)

        const raw = execFileSync(
          process.execPath,
          ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', file],
          {
            encoding: 'utf8',
            maxBuffer: 1 << 26,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        const parsed = JSON.parse(raw)

        expect(parsed.state).toBe('running')
        expect(parsed.process_fingerprint).toEqual(fingerprint)
        expect(parsed.process_fingerprint.pid).toBe(child.pid)
        expect(parsed.started_at).toBe('2026-09-17T00:00:01.000Z')
      } finally {
        try {
          if (process.platform === 'win32' && child.pid) {
            execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
              windowsHide: true,
              maxBuffer: 1 << 26,
              shell: false,
              stdio: 'ignore',
            })
          } else {
            child.kill('SIGKILL')
          }
        } catch {
          // ignora erro no encerramento do processo de teste
        }
      }
    },
    20000,
  )

  test('receipt_write_survives_fault_injection_before_fsync', () => {
    const file = receiptPath(tmpDir, 's1-maker')
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const initial = startingReceipt({
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })
    writeReceipt(file, initial)

    const updated = withTerminal(
      withRunning(
        initial,
        { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' },
        '2026-09-17T00:00:01.000Z',
      ),
      'exited',
      { exitCode: 0, reason: null, nowIso: '2026-09-17T00:00:02.000Z' },
    )

    expect(() =>
      writeReceipt(file, updated, {
        fsyncSync: () => {
          throw new Error('ADE_FAULT')
        },
      }),
    ).toThrow('ADE_FAULT')

    const existing = readReceipt(file)
    expect(existing).toEqual(initial)

    const dir = path.dirname(file)
    const tmpEntries = fs.readdirSync(dir).filter((entry) => entry.includes('.tmp-'))
    expect(tmpEntries).toEqual([])
  })

  test('receipt_transitions_support_start_failed_timeout_and_crashed', () => {
    const file = receiptPath(tmpDir, 's1-transitions')
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const starting = startingReceipt({
      missionId: 'm1',
      stepId: 's1-transitions',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    // starting -> start_failed (transição positiva)
    const startFailed = withTerminal(starting, 'start_failed', {
      reason: 'binary_not_found',
      nowIso: '2026-09-17T00:00:01.000Z',
    })
    expect(startFailed.state).toBe('start_failed')
    expect(startFailed.process_fingerprint).toBeNull()
    expect(startFailed.exit_code).toBeNull()
    expect(startFailed.reason).toBe('binary_not_found')
    expect(startFailed.exited_at).toBe('2026-09-17T00:00:01.000Z')
    writeReceipt(file, startFailed)
    expect(readReceipt(file)).toEqual(startFailed)

    // running -> timeout (transição positiva)
    const fingerprint = { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' }
    const running = withRunning(starting, fingerprint, '2026-09-17T00:00:01.000Z')
    const timeout = withTerminal(running, 'timeout', {
      reason: 'timeout_exceeded',
      nowIso: '2026-09-17T00:00:05.000Z',
    })
    expect(timeout.state).toBe('timeout')
    expect(timeout.process_fingerprint).toEqual(fingerprint)
    expect(timeout.reason).toBe('timeout_exceeded')
    expect(timeout.exited_at).toBe('2026-09-17T00:00:05.000Z')
    writeReceipt(file, timeout)
    expect(readReceipt(file)).toEqual(timeout)

    // running -> crashed (transição positiva)
    const crashed = withTerminal(running, 'crashed', {
      exitCode: 137,
      reason: 'killed_by_signal',
      nowIso: '2026-09-17T00:00:06.000Z',
    })
    expect(crashed.state).toBe('crashed')
    expect(crashed.process_fingerprint).toEqual(fingerprint)
    expect(crashed.exit_code).toBe(137)
    expect(crashed.reason).toBe('killed_by_signal')
    expect(crashed.exited_at).toBe('2026-09-17T00:00:06.000Z')
    writeReceipt(file, crashed)
    expect(readReceipt(file)).toEqual(crashed)
  })

  test('receipt_rejects_invalid_state_transitions', () => {
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const starting = startingReceipt({
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })
    const fingerprint = { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' }
    const running = withRunning(starting, fingerprint, '2026-09-17T00:00:01.000Z')

    // running -> terminal válido
    const exited = withTerminal(running, 'exited', { exitCode: 0 })

    // Transição terminal -> terminal lança TypeError('transição de recibo inválida')
    expect(() => withTerminal(exited, 'crashed')).toThrow(TypeError)
    expect(() => withTerminal(exited, 'crashed')).toThrow('transição de recibo inválida')

    // Transição running -> running lança TypeError('transição de recibo inválida')
    expect(() => withRunning(running, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(TypeError)
    expect(() => withRunning(running, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(
      'transição de recibo inválida',
    )

    // Transição terminal -> running lança TypeError('transição de recibo inválida')
    expect(() => withRunning(exited, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(TypeError)
    expect(() => withRunning(exited, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(
      'transição de recibo inválida',
    )

    // starting direto para exited/timeout/crashed lança TypeError('transição de recibo inválida')
    expect(() => withTerminal(starting, 'exited')).toThrow(TypeError)
    expect(() => withTerminal(starting, 'exited')).toThrow('transição de recibo inválida')
    expect(() => withTerminal(starting, 'timeout')).toThrow('transição de recibo inválida')
    expect(() => withTerminal(starting, 'crashed')).toThrow('transição de recibo inválida')

    // running para start_failed lança TypeError('transição de recibo inválida')
    expect(() => withTerminal(running, 'start_failed')).toThrow(TypeError)
    expect(() => withTerminal(running, 'start_failed')).toThrow('transição de recibo inválida')

    // State terminal não permitido lança TypeError('state terminal inválido')
    expect(() => withTerminal(running, 'unknown_state' as unknown as 'exited')).toThrow(TypeError)
    expect(() => withTerminal(running, 'unknown_state' as unknown as 'exited')).toThrow(
      'state terminal inválido',
    )

    // Persiste recibo running e verifica que transições proibidas não alteram o arquivo já gravado
    const file = receiptPath(tmpDir, 's1-persisted')
    writeReceipt(file, running)
    const beforeBytes = fs.readFileSync(file)

    expect(() => withTerminal(running, 'start_failed')).toThrow(TypeError)
    expect(() => withRunning(running, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(TypeError)
    expect(() => withTerminal(exited, 'crashed')).toThrow(TypeError)

    const afterBytes = fs.readFileSync(file)
    expect(afterBytes).toEqual(beforeBytes)
  })

  test('receipt_rejects_invalid_request_structure_and_types', () => {
    const validRequest = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }

    expect(isValidRequest(validRequest)).toBe(true)
    expect(isValidRequest(null)).toBe(false)
    expect(isValidRequest([])).toBe(false)
    expect(isValidRequest('string')).toBe(false)
    expect(isValidRequest(123)).toBe(false)

    // Faltando unit
    expect(isValidRequest({ ...validRequest, unit: '' })).toBe(false)
    const noUnit = { ...validRequest }
    delete (noUnit as Record<string, unknown>).unit
    expect(isValidRequest(noUnit)).toBe(false)

    // Faltando authorization
    expect(isValidRequest({ ...validRequest, authorization: '' })).toBe(false)
    const noAuth = { ...validRequest }
    delete (noAuth as Record<string, unknown>).authorization
    expect(isValidRequest(noAuth)).toBe(false)

    // Faltando cwd
    expect(isValidRequest({ ...validRequest, cwd: '' })).toBe(false)
    const noCwd = { ...validRequest }
    delete (noCwd as Record<string, unknown>).cwd
    expect(isValidRequest(noCwd)).toBe(false)

    // argv inválido
    expect(isValidRequest({ ...validRequest, argv: [] })).toBe(false)
    expect(isValidRequest({ ...validRequest, argv: 'node' })).toBe(false)
    expect(isValidRequest({ ...validRequest, argv: [123] })).toBe(false)
    const noArgv = { ...validRequest }
    delete (noArgv as Record<string, unknown>).argv
    expect(isValidRequest(noArgv)).toBe(false)

    // timeout inválido
    expect(isValidRequest({ ...validRequest, timeout: 0 })).toBe(false)
    expect(isValidRequest({ ...validRequest, timeout: -1 })).toBe(false)
    expect(isValidRequest({ ...validRequest, timeout: '120' })).toBe(false)
    expect(isValidRequest({ ...validRequest, timeout: Number.NaN })).toBe(false)
    const noTimeout = { ...validRequest }
    delete (noTimeout as Record<string, unknown>).timeout
    expect(isValidRequest(noTimeout)).toBe(false)

    // result_file inválido
    expect(isValidRequest({ ...validRequest, result_file: '' })).toBe(false)
    const noResultFile = { ...validRequest }
    delete (noResultFile as Record<string, unknown>).result_file
    expect(isValidRequest(noResultFile)).toBe(false)

    // Campo extra proibido pelo contrato fechado de 6 campos
    expect(isValidRequest({ ...validRequest, extra_campo: true })).toBe(false)

    // startingReceipt e requestDigest rejeitam requests inválidos com TypeError('request inválido')
    expect(() =>
      startingReceipt({
        missionId: 'm1',
        stepId: 's1',
        request: noUnit,
      }),
    ).toThrow(TypeError)
    expect(() =>
      startingReceipt({
        missionId: 'm1',
        stepId: 's1',
        request: noUnit,
      }),
    ).toThrow('request inválido')

    expect(() =>
      startingReceipt({
        missionId: 'm1',
        stepId: 's1',
        request: [] as unknown as typeof validRequest,
      }),
    ).toThrow('request inválido')

    expect(() => requestDigest(noUnit)).toThrow(TypeError)
    expect(() => requestDigest(noUnit)).toThrow('request inválido')
  })

  test('receipt_fingerprint_accepts_real_platform_start_times_and_rejects_malformed_linux', () => {
    const base = { pid: 4242, host: 'maquina' }
    // Windows: CreationDate.ToUniversalTime().ToString('o') do PowerShell (fração de 7 dígitos)
    expect(isValidFingerprint({ ...base, start_time: '2026-09-17T12:34:56.1234567Z' })).toBe(true)
    // Linux: <boot_id de /proc/sys/kernel/random/boot_id>:<ticks de /proc/pid/stat>
    expect(
      isValidFingerprint({ ...base, start_time: '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718:123456' }),
    ).toBe(true)

    // Linux malformado: boot_id que não é UUID canônico ou ticks ausentes
    for (const bad of [
      '-:0',
      'deadbeef:7',
      '3f1c2b4a9d8e4f70a1b2c3d4e5f60718:1',
      '3F1C2B4A-9D8E-4F70-A1B2-C3D4E5F60718:1',
      '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f6071:1',
      '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718:',
      '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718:12a',
      ':123',
    ]) {
      expect(isValidFingerprint({ ...base, start_time: bad }), bad).toBe(false)
    }
  })

  test('receipt_rejects_invalid_fingerprint_structure_and_types', () => {
    const validFp = { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' }
    expect(isValidFingerprint(validFp)).toBe(true)
    expect(isValidFingerprint({ ...validFp, start_time: null })).toBe(true)

    expect(isValidFingerprint(null)).toBe(false)
    expect(isValidFingerprint([])).toBe(false)
    expect(isValidFingerprint('str')).toBe(false)

    // pid inválido
    expect(isValidFingerprint({ ...validFp, pid: 0 })).toBe(false)
    expect(isValidFingerprint({ ...validFp, pid: -10 })).toBe(false)
    expect(isValidFingerprint({ ...validFp, pid: 1.5 })).toBe(false)
    expect(isValidFingerprint({ ...validFp, pid: '4242' })).toBe(false)
    const noPid = { ...validFp }
    delete (noPid as Record<string, unknown>).pid
    expect(isValidFingerprint(noPid)).toBe(false)

    // start_time inválido
    expect(isValidFingerprint({ ...validFp, start_time: 12345 })).toBe(false)
    expect(isValidFingerprint({ ...validFp, start_time: '' })).toBe(false)
    const noStartTime = { ...validFp }
    delete (noStartTime as Record<string, unknown>).start_time
    expect(isValidFingerprint(noStartTime)).toBe(false)

    // host inválido
    expect(isValidFingerprint({ ...validFp, host: '' })).toBe(false)
    const noHost = { ...validFp }
    delete (noHost as Record<string, unknown>).host
    expect(isValidFingerprint(noHost)).toBe(false)

    // campo extra proibido
    expect(isValidFingerprint({ ...validFp, extra: 1 })).toBe(false)

    // withRunning rejeita fingerprint inválido
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const starting = startingReceipt({
      missionId: 'm1',
      stepId: 's1',
      request,
    })

    expect(() => withRunning(starting, noPid)).toThrow(TypeError)
    expect(() => withRunning(starting, noPid)).toThrow('fingerprint inválido')
    expect(() => withRunning(starting, noHost)).toThrow('fingerprint inválido')
  })

  test('read_receipt_rejects_corrupted_and_semantically_invalid_receipts', () => {
    const validRequest = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const validReceipt = startingReceipt({
      missionId: 'm1',
      stepId: 's1-maker',
      request: validRequest,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    const testCorrupt = (data: unknown) => {
      const corruptFile = path.join(tmpDir, `corrupt-${Math.random().toString(36).slice(2)}.json`)
      fs.writeFileSync(corruptFile, typeof data === 'string' ? data : JSON.stringify(data))
      expect(() => readReceipt(corruptFile)).toThrow(AdeError)
      try {
        readReceipt(corruptFile)
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('receipt_corrupt')
        expect(adeErr.exitCode).toBe(2)
        expect(adeErr.details).toEqual({ file: corruptFile })
      }
    }

    // Objeto vazio ou não objeto
    testCorrupt({})
    testCorrupt([])
    testCorrupt('"apenas string"')

    // Schema diferente de 1
    testCorrupt({ ...validReceipt, schema: 2 })

    // State desconhecido
    testCorrupt({ ...validReceipt, state: 'pending' })

    // Digest que não bate com o hash de request
    testCorrupt({ ...validReceipt, request_digest: 'a'.repeat(64) })

    // Request ausente ou corrompido
    testCorrupt({ ...validReceipt, request: {} })

    // Starting com fingerprint preenchido (incoerente)
    testCorrupt({
      ...validReceipt,
      process_fingerprint: { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' },
    })

    // Running com fingerprint null (incoerente)
    testCorrupt({
      ...validReceipt,
      state: 'running',
      process_fingerprint: null,
    })

    // Running com campos de saída não nulos
    testCorrupt({
      ...validReceipt,
      state: 'running',
      process_fingerprint: { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' },
      exit_code: 0,
    })

    // Exited com fingerprint null (incoerente)
    testCorrupt({
      ...validReceipt,
      state: 'exited',
      process_fingerprint: null,
      exited_at: '2026-09-17T00:00:02.000Z',
    })

    // Start_failed com fingerprint preenchido (incoerente)
    testCorrupt({
      ...validReceipt,
      state: 'start_failed',
      process_fingerprint: { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' },
      exited_at: '2026-09-17T00:00:02.000Z',
    })
  })

  test('read_receipt_rejects_receipt_with_lone_surrogate_in_request', () => {
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const receipt = startingReceipt({
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    // Troca `unit` por um surrogate solitario escapado: JSON.parse aceita, mas `canonicalize`
    // recusa por nao ser escalar Unicode valido. Isso e recibo corrompido, nao erro bruto.
    const text = JSON.stringify(receipt).replace('"unit":"s1"', '"unit":"\\ud800"')
    expect(text).toContain('\\ud800')
    const file = path.join(tmpDir, 'lone-surrogate.json')
    fs.writeFileSync(file, text + '\n')

    expect(() => readReceipt(file)).toThrow(AdeError)
    try {
      readReceipt(file)
      expect.unreachable('deveria ter lancado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('receipt_corrupt')
      expect(adeErr.exitCode).toBe(2)
      expect(adeErr.details).toEqual({ file })
    }
  })

  test('charge_of_start_failed_is_released', () => {
    expect(chargeOf('starting')).toBe('released')
    expect(chargeOf('start_failed')).toBe('released')
    expect(chargeOf('running')).toBe('charged')
    expect(chargeOf('exited')).toBe('charged')
    expect(chargeOf('timeout')).toBe('charged')
    expect(chargeOf('crashed')).toBe('charged')

    expect(() => chargeOf('xpto')).toThrow(TypeError)
    expect(() => chargeOf('xpto')).toThrow('state inválido')
  })

  test('receipt_path_and_starting_receipt_contract', () => {
    expect(receiptPath('C:\\repo\\.ade\\missions\\m1', 's1-maker')).toBe(
      path.join('C:\\repo\\.ade\\missions\\m1', 'jobs', 's1-maker.json'),
    )

    expect(RECEIPT_STATES).toEqual([
      'starting',
      'running',
      'exited',
      'timeout',
      'crashed',
      'start_failed',
    ])

    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: 'C:\\wt\\s1',
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: 'C:\\wt\\s1\\out.json',
    }
    const receipt = startingReceipt({
      missionId: 'm1',
      stepId: 's1-maker',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    expect(receipt.schema).toBe(1)
    expect(receipt.state).toBe('starting')
    expect(receipt.process_fingerprint).toBeNull()
    expect(receipt.request_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.request_digest).toBe(requestDigest(request))
    expect(receipt.started_at).toBe('2026-09-17T00:00:00.000Z')
    expect(receipt.exited_at).toBeNull()
    expect(receipt.exit_code).toBeNull()
    expect(receipt.reason).toBeNull()
  })

  test('with_running_and_with_terminal_reject_incomplete_receipts_and_invalid_patch_fields', () => {
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const starting = startingReceipt({ missionId: 'm1', stepId: 's1', request })
    const fingerprint = { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' }
    const running = withRunning(starting, fingerprint, '2026-09-17T00:00:01.000Z')

    // Recibo incompleto (faltando campos obrigatórios) é rejeitado antes de transicionar
    const incomplete = { state: 'starting' } as unknown as typeof starting
    expect(() => withRunning(incomplete, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(TypeError)
    expect(() => withRunning(incomplete, fingerprint, '2026-09-17T00:00:02.000Z')).toThrow(
      'receipt inválido',
    )

    const incompleteRunning = { state: 'running' } as unknown as typeof running
    expect(() => withTerminal(incompleteRunning, 'exited', { exitCode: 0 })).toThrow(TypeError)
    expect(() => withTerminal(incompleteRunning, 'exited', { exitCode: 0 })).toThrow(
      'receipt inválido',
    )

    // nowIso inválido em withRunning
    expect(() => withRunning(starting, fingerprint, 'não é uma data')).toThrow(TypeError)
    expect(() => withRunning(starting, fingerprint, 'não é uma data')).toThrow('nowIso inválido')

    // exitCode, reason e nowIso inválidos em withTerminal
    expect(() =>
      withTerminal(running, 'exited', { exitCode: '0' as unknown as number }),
    ).toThrow(TypeError)
    expect(() =>
      withTerminal(running, 'exited', { exitCode: '0' as unknown as number }),
    ).toThrow('exitCode inválido')

    expect(() =>
      withTerminal(running, 'exited', { exitCode: 1.5 }),
    ).toThrow('exitCode inválido')

    expect(() =>
      withTerminal(running, 'exited', { reason: 123 as unknown as string }),
    ).toThrow(TypeError)
    expect(() =>
      withTerminal(running, 'exited', { reason: 123 as unknown as string }),
    ).toThrow('reason inválido')

    expect(() =>
      withTerminal(running, 'exited', { nowIso: 'não é uma data' }),
    ).toThrow(TypeError)
    expect(() =>
      withTerminal(running, 'exited', { nowIso: 'não é uma data' }),
    ).toThrow('nowIso inválido')
  })

  test('receipt_instants_must_be_iso_utc', () => {
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const valid = startingReceipt({
      missionId: 'm1',
      stepId: 's1',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    // started_at fora do formato ISO 8601 UTC canônico é tratado como recibo corrompido na leitura
    const file1 = path.join(tmpDir, 'invalido-started-at.json')
    fs.writeFileSync(file1, JSON.stringify({ ...valid, started_at: 'invalido' }))
    expect(() => readReceipt(file1)).toThrow(AdeError)
    expect(() => readReceipt(file1)).toThrow('recibo ilegível')

    // exited_at fora do formato ISO 8601 UTC canônico
    const fingerprint = { pid: 4242, start_time: '2026-09-17T00:00:01.000Z', host: 'maquina' }
    const running = withRunning(valid, fingerprint, '2026-09-17T00:00:01.000Z')
    const exited = withTerminal(running, 'exited', { exitCode: 0, nowIso: '2026-09-17T00:00:02.000Z' })
    const file2 = path.join(tmpDir, 'invalido-exited-at.json')
    fs.writeFileSync(file2, JSON.stringify({ ...exited, exited_at: '2026-09-17 00:00:02' }))
    expect(() => readReceipt(file2)).toThrow(AdeError)
    expect(() => readReceipt(file2)).toThrow('recibo ilegível')

    // process_fingerprint.start_time fora do formato ISO 8601 UTC canônico
    const file3 = path.join(tmpDir, 'invalido-fingerprint-start-time.json')
    fs.writeFileSync(
      file3,
      JSON.stringify({
        ...running,
        process_fingerprint: { ...fingerprint, start_time: '17/09/2026' },
      }),
    )
    expect(() => readReceipt(file3)).toThrow(AdeError)
    expect(() => readReceipt(file3)).toThrow('recibo ilegível')

    expect(isValidFingerprint({ ...fingerprint, start_time: '17/09/2026' })).toBe(false)
  })

  test('read_receipt_returns_null_for_missing_file_and_fails_on_corrupt_json', () => {
    const missing = path.join(tmpDir, 'nao-existe.json')
    expect(readReceipt(missing)).toBeNull()

    const corrupt = path.join(tmpDir, 'corrupto.json')
    fs.writeFileSync(corrupt, '{ invalid json')

    expect(() => readReceipt(corrupt)).toThrow(AdeError)
    try {
      readReceipt(corrupt)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('receipt_corrupt')
      expect(adeErr.exitCode).toBe(2)
      expect(adeErr.message).toBe('recibo ilegível: ' + corrupt)
      expect(adeErr.details).toEqual({ file: corrupt })
    }
  })

  test('receipt_rejects_non_canonical_instants_and_invalid_now', () => {
    const request = {
      unit: 's1',
      authorization: 'd0',
      cwd: tmpDir,
      argv: ['node', 'cli.js'],
      timeout: 120,
      result_file: path.join(tmpDir, 'out.json'),
    }
    const valid = startingReceipt({
      missionId: 'm1',
      stepId: 's1',
      request,
      now: () => '2026-09-17T00:00:00.000Z',
    })

    // Instantes que casam com a regex e passam em Date.parse, mas são normalizados por
    // rollover e nunca sairiam de Date#toISOString(): rollover de dia e de hora.
    const naoCanonicos = [
      '2026-02-30T00:00:00.000Z',
      '2026-01-01T24:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
    ]
    for (const instante of naoCanonicos) {
      const file = path.join(tmpDir, `rollover-${instante.replace(/[:.]/g, '-')}.json`)
      fs.writeFileSync(file, JSON.stringify({ ...valid, started_at: instante }))
      expect(() => readReceipt(file)).toThrow(AdeError)
      expect(() => readReceipt(file)).toThrow('recibo ilegível')

      expect(isValidFingerprint({ pid: 4242, start_time: instante, host: 'maquina' })).toBe(false)

      expect(() =>
        withRunning(valid, { pid: 4242, start_time: null, host: 'maquina' }, instante),
      ).toThrow('nowIso inválido')
    }

    // startingReceipt valida o valor devolvido por now()
    expect(() =>
      startingReceipt({ missionId: 'm1', stepId: 's1', request, now: () => '2026-02-30T00:00:00.000Z' }),
    ).toThrow(TypeError)
    expect(() =>
      startingReceipt({ missionId: 'm1', stepId: 's1', request, now: () => '2026-02-30T00:00:00.000Z' }),
    ).toThrow('now inválido')

    expect(() =>
      startingReceipt({ missionId: 'm1', stepId: 's1', request, now: () => 'agora' }),
    ).toThrow('now inválido')
    expect(() =>
      startingReceipt({
        missionId: 'm1',
        stepId: 's1',
        request,
        now: () => 1758067200000 as unknown as string,
      }),
    ).toThrow('now inválido')

    // O default de produção continua produzindo um instante canônico
    const comDefault = startingReceipt({ missionId: 'm1', stepId: 's1', request })
    expect(new Date(comDefault.started_at).toISOString()).toBe(comDefault.started_at)

    // Regressão: '0000-02-29' é 29 de fevereiro do ano 0000 (bissexto no calendário
    // gregoriano) e é compatível com o contrato documentado de `Date#toISOString()`. Não
    // pode ser recusado por interpretação de ano de dois dígitos (Date.UTC trataria como 1900).
    const anoZeroBissexto = startingReceipt({
      missionId: 'm1',
      stepId: 's1',
      request,
      now: () => '0000-02-29T00:00:00.000Z',
    })
    expect(anoZeroBissexto.started_at).toBe('0000-02-29T00:00:00.000Z')
  })
})
