import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readReceipt } from '../src/runner/receipt.ts'
import { runWorker } from '../src/runner/spawn.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const HORA_DE_INICIO = '2026-09-23T00:00:01.000Z'

/** Depois do close tudo é microtarefa (o recibo é gravado em modo síncrono); esta macrotarefa marca "ainda pendente". */
function depoisDasMicrotarefas(): Promise<'pendente'> {
  return new Promise((resolve) => setImmediate(() => resolve('pendente')))
}

describe('runWorker: corrida entre o close e a hora de início do processo', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('ade-spawn-')
  })

  afterEach(() => {
    removeTmpDir(tmpDir)
  })

  /** Processo dublê: a prova decide quando ele fecha e quando a consulta da hora de início responde. */
  function startWorker(stepId: string) {
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
    let answerStartTime: (value: string) => void = () => {}
    const startTime = new Promise<string>((resolve) => {
      answerStartTime = resolve
    })
    const run = runWorker({
      resolved: { exe: process.execPath, prefixArgs: [] },
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm1',
      stepId,
      request: {
        unit: 's1',
        authorization: 'd0',
        cwd: tmpDir,
        argv: ['node', 'script.js'],
        timeout: 120,
        result_file: path.join(tmpDir, 'out.json'),
      },
      now: () => '2026-09-23T00:00:00.000Z',
      getStartTime: () => startTime,
      spawnImpl: () => fakeChild,
    })
    return { run, close: (code: number) => listeners.close?.(code), answerStartTime }
  }

  // Regressão da v2: no Windows a consulta custa ~1 s de powershell por chamada; processo que já saiu
  // não prende o desfecho esperando a resposta, e o recibo fica sem hora de início.
  test('close_before_start_time_answer_finishes_without_waiting', async () => {
    const worker = startWorker('s1-close-first')
    worker.close(0)

    const outcome = await Promise.race([worker.run, depoisDasMicrotarefas()])
    // A resposta atrasada da consulta não pode reabrir o recibo terminal.
    worker.answerStartTime(HORA_DE_INICIO)
    await depoisDasMicrotarefas()

    expect(outcome).not.toBe('pendente')
    const result = await worker.run
    expect(result).toMatchObject({ state: 'exited', exitCode: 0, pid: 4242 })
    expect(readReceipt(result.receiptFile)).toMatchObject({
      state: 'exited',
      exit_code: 0,
      process_fingerprint: { pid: 4242, start_time: null, host: os.hostname() },
    })
  })

  test('start_time_answered_before_close_is_kept_in_receipt', async () => {
    const worker = startWorker('s1-answer-first')
    worker.answerStartTime(HORA_DE_INICIO)
    await depoisDasMicrotarefas()
    worker.close(0)

    const result = await worker.run
    expect(readReceipt(result.receiptFile)).toMatchObject({
      state: 'exited',
      exit_code: 0,
      process_fingerprint: { pid: 4242, start_time: HORA_DE_INICIO, host: os.hostname() },
    })
  })
})
