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
import { JournalCorruptError } from '../../src/journal/errors.js'
import { digest16 } from '../../src/journal/canonical.js'
import { openJournal, readJournal } from '../../src/journal/journal.js'

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
