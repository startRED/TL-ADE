import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError, JournalCorruptError, StaleWorkflowVersionError } from '../../src/journal/errors.ts'
import { digest16 } from '../../src/journal/canonical.ts'
import { fold, openJournal, readJournal } from '../../src/journal/journal.ts'
import {
  acceptStaleVersion,
  assertStampCurrent,
  findStaleIntents,
} from '../../src/journal/stamp.ts'

interface ReadJournalResult {
  events: Array<Record<string, unknown>>
  tornTail: null | {
    line: number
    bytesDropped: number
    validBytes: number
  }
}

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

function createMissionDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-journal-parity-'))
  tmpDirs.push(dir)
  return dir
}

async function writeEvents(
  missionDir: string,
  count: number,
): Promise<{ filePath: string; events: Array<Record<string, unknown>> }> {
  const journal = openJournal({ missionDir, runtimeStamp: '1:aa:bb' })
  const events: Array<Record<string, unknown>> = []
  for (let i = 1; i <= count; i++) {
    const ev = await journal.append({ kind: 'note', data: { n: i } })
    events.push(ev)
  }
  await journal.close()
  const filePath = path.join(missionDir, 'journal.jsonl')
  return { filePath, events }
}

async function writeFiveEvents(
  missionDir: string,
): Promise<{ filePath: string; events: Array<Record<string, unknown>> }> {
  return writeEvents(missionDir, 5)
}

function catchError(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('esperava erro mas nada foi lançado')
}

describe('journal parity', () => {
  // AC1 & AC2: Cadeia de hash detecta adulteração e remoção de linhas
  test('journal_hash_chain_detects_tampering', async () => {
    const missionDir = createMissionDir()
    const { filePath, events } = await writeFiveEvents(missionDir)

    // Afirmação positiva que falha no stub atual (readJournal não implementado)
    const intact = readJournal(filePath) as unknown as ReadJournalResult
    expect(intact.events).toHaveLength(5)
    expect(intact.events).toEqual(events)
    expect(intact.tornTail).toBeNull()

    const originalContent = readFileSync(filePath, 'utf8')
    const lines = originalContent.split('\n')

    // Caso 1: "n":3 da linha 3 vira "n":4 -> prev_mismatch na linha 4
    const tamperedLines1 = [...lines]
    expect(tamperedLines1[2]).toContain('"n":3')
    tamperedLines1[2] = tamperedLines1[2].replace('"n":3', '"n":4')
    writeFileSync(filePath, tamperedLines1.join('\n'), 'utf8')

    const err1 = catchError(() => readJournal(filePath))
    expect(err1).toBeInstanceOf(JournalCorruptError)
    const corruptErr1 = err1 as JournalCorruptError
    expect(corruptErr1.code).toBe('journal_corrupt')
    expect(corruptErr1.exitCode).toBe(2)
    expect(corruptErr1.details).toEqual({ line: 4, reason: 'prev_mismatch' })

    // Caso 2: byte de índice 2 da linha 3 muda de 'a' para 'b' -> corrupção na linha 3
    const tamperedLines2 = [...lines]
    const line3Buf = Buffer.from(tamperedLines2[2], 'utf8')
    expect(line3Buf[2]).toBe('a'.charCodeAt(0))
    line3Buf[2] = 'b'.charCodeAt(0)
    tamperedLines2[2] = line3Buf.toString('utf8')
    writeFileSync(filePath, tamperedLines2.join('\n'), 'utf8')

    const err2 = catchError(() => readJournal(filePath))
    expect(err2).toBeInstanceOf(AdeError)
    expect(err2).toBeInstanceOf(JournalCorruptError)
    const corruptErr2 = err2 as JournalCorruptError
    expect(corruptErr2.code).toBe('journal_corrupt')
    expect(corruptErr2.exitCode).toBe(2)
    expect(corruptErr2.details?.line).toBe(3)

    // Caso 3: remoção da linha 2 -> seq_gap na linha 2
    const tamperedLines3 = [...lines]
    tamperedLines3.splice(1, 1)
    writeFileSync(filePath, tamperedLines3.join('\n'), 'utf8')

    const err3 = catchError(() => readJournal(filePath))
    expect(err3).toBeInstanceOf(JournalCorruptError)
    const corruptErr3 = err3 as JournalCorruptError
    expect(corruptErr3.code).toBe('journal_corrupt')
    expect(corruptErr3.exitCode).toBe(2)
    expect(corruptErr3.details).toEqual({ line: 2, reason: 'seq_gap' })
  })

  // AC3: Linhas com JSON inválido, fora do schema ou não-canônicas são recusadas
  test('invalid_journal_line_is_refused', async () => {
    const missionDir = createMissionDir()
    const { filePath, events } = await writeFiveEvents(missionDir)

    // Afirmação positiva que falha no stub atual
    const intact = readJournal(filePath) as unknown as ReadJournalResult
    expect(intact.events).toHaveLength(5)
    expect(intact.events).toEqual(events)
    expect(intact.tornTail).toBeNull()

    const originalContent = readFileSync(filePath, 'utf8')
    const lines = originalContent.split('\n')

    // Linha 2 com texto que não é JSON -> invalid_json na linha 2
    const nonJsonLines = [...lines]
    nonJsonLines[1] = 'não é json'
    writeFileSync(filePath, nonJsonLines.join('\n'), 'utf8')

    const err1 = catchError(() => readJournal(filePath))
    expect(err1).toBeInstanceOf(JournalCorruptError)
    const corruptErr1 = err1 as JournalCorruptError
    expect(corruptErr1.code).toBe('journal_corrupt')
    expect(corruptErr1.exitCode).toBe(2)
    expect(corruptErr1.details).toEqual({ line: 2, reason: 'invalid_json' })

    // Linha 2 trocada por JSON válido que não passa no schema -> schema_invalid na linha 2
    const invalidSchemaLines = [...lines]
    invalidSchemaLines[1] = '{"seq":2}'
    writeFileSync(filePath, invalidSchemaLines.join('\n'), 'utf8')

    const err2 = catchError(() => readJournal(filePath))
    expect(err2).toBeInstanceOf(JournalCorruptError)
    const corruptErr2 = err2 as JournalCorruptError
    expect(corruptErr2.code).toBe('journal_corrupt')
    expect(corruptErr2.exitCode).toBe(2)
    expect(corruptErr2.details).toEqual({ line: 2, reason: 'schema_invalid' })

    // Linha 2 íntegra mas não canônica (espaço após '{') -> not_canonical na linha 2
    const nonCanonicalLines = [...lines]
    nonCanonicalLines[1] = nonCanonicalLines[1].replace('{', '{ ')
    writeFileSync(filePath, nonCanonicalLines.join('\n'), 'utf8')

    const err3 = catchError(() => readJournal(filePath))
    expect(err3).toBeInstanceOf(JournalCorruptError)
    const corruptErr3 = err3 as JournalCorruptError
    expect(corruptErr3.code).toBe('journal_corrupt')
    expect(corruptErr3.exitCode).toBe(2)
    expect(corruptErr3.details).toEqual({ line: 2, reason: 'not_canonical' })
  })

  // AC4: Cauda incompleta (torn tail) é reportada sem truncar o arquivo no disco
  test('torn_tail_is_reported_without_truncating', async () => {
    const missionDir = createMissionDir()
    const { filePath, events } = await writeEvents(missionDir, 2)

    // Afirmação positiva que falha no stub atual
    const intact = readJournal(filePath) as unknown as ReadJournalResult
    expect(intact.events).toHaveLength(2)
    expect(intact.events).toEqual(events)
    expect(intact.tornTail).toBeNull()

    // Acrescenta cauda incompleta sem \n terminal
    appendFileSync(filePath, '{"at":"20')

    const statBefore = statSync(filePath)
    const result = readJournal(filePath) as unknown as ReadJournalResult

    expect(result.events).toHaveLength(2)
    expect(result.events).toEqual(events)
    expect(result.tornTail).toEqual({
      line: 3,
      bytesDropped: 9,
      validBytes: statBefore.size - 9,
    })

    const statAfter = statSync(filePath)
    expect(statAfter.size).toBe(statBefore.size)
  })

  // Leitura de arquivo inexistente ou de tamanho zero devolve eventos vazios
  test('missing_or_empty_journal_reads_as_empty', () => {
    const missionDir = createMissionDir()

    // Caminho inexistente
    const missingPath = path.join(missionDir, 'nao-existe.jsonl')
    const missingResult = readJournal(missingPath) as unknown as ReadJournalResult
    expect(missingResult).toEqual({ events: [], tornTail: null })

    // Arquivo vazio de 0 bytes
    const emptyPath = path.join(missionDir, 'empty.jsonl')
    writeFileSync(emptyPath, '', 'utf8')
    const emptyResult = readJournal(emptyPath) as unknown as ReadJournalResult
    expect(emptyResult).toEqual({ events: [], tornTail: null })
  })

  // Cauda incompleta com byte UTF-8 inválido é reportada em bytes físicos sem truncar
  test('torn_tail_with_invalid_utf8_byte_is_reported_in_physical_bytes', async () => {
    const missionDir = createMissionDir()
    const { filePath, events } = await writeEvents(missionDir, 2)

    const intact = readJournal(filePath) as unknown as ReadJournalResult
    expect(intact.events).toHaveLength(2)
    expect(intact.events).toEqual(events)
    expect(intact.tornTail).toBeNull()

    // Acrescenta um único byte 0x80 (UTF-8 incompleto/inválido) sem \n terminal
    appendFileSync(filePath, Buffer.from([0x80]))

    const statBefore = statSync(filePath)
    const result = readJournal(filePath) as unknown as ReadJournalResult

    expect(result.events).toHaveLength(2)
    expect(result.events).toEqual(events)
    expect(result.tornTail).toEqual({
      line: 3,
      bytesDropped: 1,
      validBytes: statBefore.size - 1,
    })

    const statAfter = statSync(filePath)
    expect(statAfter.size).toBe(statBefore.size)
  })

  // Linha completa válida no schema contendo surrogate isolado é recusada como not_canonical
  test('lone_surrogate_in_schema_valid_line_is_refused_as_not_canonical', async () => {
    const missionDir = createMissionDir()
    const { filePath, events } = await writeEvents(missionDir, 1)

    const intact = readJournal(filePath) as unknown as ReadJournalResult
    expect(intact.events).toHaveLength(1)
    expect(intact.events).toEqual(events)
    expect(intact.tornTail).toBeNull()

    // Monta linha 2 válida no schema com surrogate isolado (\ud800) em data.text
    const firstEventDigest = digest16(events[0])
    const line2 =
      JSON.stringify({
        format_version: 1,
        seq: 2,
        at: '2026-09-17T12:00:00Z',
        prev: firstEventDigest,
        kind: 'note',
        effect_class: 'none',
        input_digest: '0000000000000000',
        intent_context: {},
        worktree: '',
        receipt_path: '',
        session_ref: null,
        runtime_stamp: '1:aa:bb',
        data: { text: '\uD800' },
      }) + '\n'

    appendFileSync(filePath, line2, 'utf8')

    const err = catchError(() => readJournal(filePath))
    expect(err).toBeInstanceOf(JournalCorruptError)
    const corruptErr = err as JournalCorruptError
    expect(corruptErr.code).toBe('journal_corrupt')
    expect(corruptErr.exitCode).toBe(2)
    expect(corruptErr.details).toEqual({ line: 2, reason: 'not_canonical' })
  })
})

describe('runtime stamp parity', () => {
  // AC1 & AC2: Intenção sob versão desatualizada bloqueia até aceite gravado como decision
  test('stale_runtime_version_stops_until_accepted', async () => {
    const missionDir = createMissionDir()
    const journal1 = openJournal({ missionDir, runtimeStamp: '0:aa:bb' })
    await journal1.append({
      kind: 'step_intent',
      step_id: 'T1:r1:maker',
      effect_class: 'model_call',
    })
    await journal1.close()

    const filePath = path.join(missionDir, 'journal.jsonl')
    const { events } = readJournal(filePath) as unknown as ReadJournalResult

    // Critério 1: assertStampCurrent lança StaleWorkflowVersionError para core atual 1
    const err = catchError(() => assertStampCurrent(events, 1))
    expect(err).toBeInstanceOf(StaleWorkflowVersionError)
    const staleErr = err as StaleWorkflowVersionError
    expect(staleErr.code).toBe('stale_workflow_version')
    expect(staleErr.exitCode).toBe(2)
    expect(staleErr.details).toEqual({
      stale: [
        {
          seq: 1,
          step_id: 'T1:r1:maker',
          effect_class: 'model_call',
          runtime_stamp: '0:aa:bb',
        },
      ],
      current_core_version: 1,
    })

    const staleBefore = findStaleIntents(events, 1)
    expect(staleBefore).toEqual([
      {
        seq: 1,
        step_id: 'T1:r1:maker',
        effect_class: 'model_call',
        runtime_stamp: '0:aa:bb',
      },
    ])

    // Critério 2: reabertura com core 1 e aceite pelo operador
    const journal2 = openJournal({ missionDir, runtimeStamp: '1:aa:bb' })
    const accepted = await acceptStaleVersion(journal2, events, {
      source: 'operator',
      currentCoreVersion: 1,
    })
    expect(accepted).not.toBeNull()
    expect(accepted?.kind).toBe('decision')
    expect(accepted?.seq).toBe(2)
    expect(accepted?.source).toBe('operator')
    expect(accepted?.data).toEqual({
      decision: 'accept_stale_version',
      current_core_version: 1,
      stale_seqs: [1],
    })
    await journal2.close()

    const { events: eventsAfter } = readJournal(filePath) as unknown as ReadJournalResult
    expect(eventsAfter).toHaveLength(2)
    expect(() => assertStampCurrent(eventsAfter, 1)).not.toThrow()
    expect(findStaleIntents(eventsAfter, 1)).toEqual([])

    // Aceite vale somente para o core_version em que foi concedido (exemplo core 2)
    const staleCore2 = findStaleIntents(eventsAfter, 2)
    expect(staleCore2).toEqual([
      {
        seq: 1,
        step_id: 'T1:r1:maker',
        effect_class: 'model_call',
        runtime_stamp: '0:aa:bb',
      },
    ])
    const errCore2 = catchError(() => assertStampCurrent(eventsAfter, 2))
    expect(errCore2).toBeInstanceOf(StaleWorkflowVersionError)
  })

  // AC3: Divergência somente de digests ou intenções já fechadas não bloqueiam
  test('only_core_version_divergence_blocks', async () => {
    // Caso 1: divergência apenas de config_digest e capabilities_digest não bloqueia
    const missionDir1 = createMissionDir()
    const journal1 = openJournal({ missionDir: missionDir1, runtimeStamp: '1:cc:dd' })
    await journal1.append({
      kind: 'step_intent',
      step_id: 'T1:r1:maker',
      effect_class: 'model_call',
    })
    await journal1.close()

    const filePath1 = path.join(missionDir1, 'journal.jsonl')
    const linesBefore1 = readFileSync(filePath1, 'utf8').split('\n').filter(Boolean).length
    const { events: events1 } = readJournal(filePath1) as unknown as ReadJournalResult

    expect(findStaleIntents(events1, 1)).toEqual([])
    expect(() => assertStampCurrent(events1, 1)).not.toThrow()

    const reopen1 = openJournal({ missionDir: missionDir1, runtimeStamp: '1:cc:dd' })
    const res1 = await acceptStaleVersion(reopen1, events1, {
      source: 'operator',
      currentCoreVersion: 1,
    })
    expect(res1).toBeNull()
    await reopen1.close()

    const linesAfter1 = readFileSync(filePath1, 'utf8').split('\n').filter(Boolean).length
    expect(linesAfter1).toBe(linesBefore1)

    // Caso 2: intent sob core 0 já fechado por step_result não bloqueia
    const missionDir2 = createMissionDir()
    const journal2 = openJournal({ missionDir: missionDir2, runtimeStamp: '0:aa:bb' })
    await journal2.append({
      kind: 'step_intent',
      step_id: 'T1:r1:maker',
      effect_class: 'model_call',
    })
    await journal2.append({
      kind: 'step_result',
      step_id: 'T1:r1:maker',
      status: 'completed',
    })
    await journal2.close()

    const filePath2 = path.join(missionDir2, 'journal.jsonl')
    const linesBefore2 = readFileSync(filePath2, 'utf8').split('\n').filter(Boolean).length
    const { events: events2 } = readJournal(filePath2) as unknown as ReadJournalResult

    expect(findStaleIntents(events2, 1)).toEqual([])
    expect(() => assertStampCurrent(events2, 1)).not.toThrow()

    const reopen2 = openJournal({ missionDir: missionDir2, runtimeStamp: '1:aa:bb' })
    const res2 = await acceptStaleVersion(reopen2, events2, {
      source: 'operator',
      currentCoreVersion: 1,
    })
    expect(res2).toBeNull()
    await reopen2.close()

    const linesAfter2 = readFileSync(filePath2, 'utf8').split('\n').filter(Boolean).length
    expect(linesAfter2).toBe(linesBefore2)

    // Caso vazio: findStaleIntents([]) devolve [] e não lança
    expect(findStaleIntents([])).toEqual([])
    expect(() => assertStampCurrent([])).not.toThrow()
  })

  // AC4: Re-exportação de fold a partir do módulo journal
  test('journal_module_reexports_fold', () => {
    const result = fold([])
    expect(result).toEqual({
      lastSeq: 0,
      kinds: {},
      steps: {},
      openIntents: [],
      decisions: [],
    })
    expect(typeof fold).toBe('function')
  })
})

