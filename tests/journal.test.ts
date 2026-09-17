import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { canonicalize, digest16 } from '../src/journal/canonical.js'
import { AdeError, InvalidEventError } from '../src/journal/errors.js'
import { GENESIS_PREV, openJournal } from '../src/journal/journal.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  tmpDirs = []
})

function createMissionDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-journal-'))
  tmpDirs.push(dir)
  return dir
}

// AC1: Dado um journal aberto com fsImpl espião, quando await journal.append({kind:'note'}) resolve,
// então fsyncSync já foi chamado com o mesmo fd devolvido por openSync e depois do writeSync daquela linha.
describe('journal append and durability', () => {
  test('append_fsyncs_the_descriptor_before_resolving', async () => {
    const missionDir = createMissionDir()

    // openJournal com runtimeStamp inválido lança TypeError
    expect(() =>
      openJournal({ missionDir, runtimeStamp: 'v1' }),
    ).toThrow(TypeError)

    const calls: Array<[string, number]> = []
    const fsImpl = {
      ...fs,
      openSync: (...args: Parameters<typeof fs.openSync>) => {
        const fd = fs.openSync(...args)
        calls.push(['open', fd])
        return fd
      },
      writeSync: (fd: number, ...rest: [any, any?, any?]) => {
        calls.push(['write', fd])
        return (fs.writeSync as any)(fd, ...rest)
      },
      fsyncSync: (fd: number) => {
        calls.push(['fsync', fd])
        return fs.fsyncSync(fd)
      },
      closeSync: (fd: number) => {
        calls.push(['close', fd])
        return fs.closeSync(fd)
      },
    }

    const fixedDate = new Date('2026-09-17T12:00:00.123Z')
    const journal = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
      fsImpl,
      now: () => fixedDate,
    })

    const event = await journal.append({ kind: 'note' })

    // Afirmar a ordem open, write, fsync e fds iguais logo após o await append
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls[0][0]).toBe('open')
    expect(calls[1][0]).toBe('write')
    expect(calls[2][0]).toBe('fsync')
    const fd = calls[0][1]
    expect(calls[1][1]).toBe(fd)
    expect(calls[2][1]).toBe(fd)

    // Formato canônico e envelope padrão do evento
    expect(event).toEqual({
      format_version: 1,
      seq: 1,
      at: '2026-09-17T12:00:00Z',
      prev: GENESIS_PREV,
      kind: 'note',
      effect_class: 'none',
      intent_context: {},
      worktree: '',
      receipt_path: '',
      session_ref: null,
      runtime_stamp: '1:aa:bb',
      input_digest: digest16({ kind: 'note' }),
    })

    // Conteúdo gravado no arquivo em disco é canônico
    const filePath = path.join(missionDir, 'journal.jsonl')
    const rawContent = readFileSync(filePath, 'utf8')
    expect(rawContent).toBe(canonicalize(event) + '\n')
    const parsedLines = rawContent.trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(parsedLines).toHaveLength(1)
    expect(parsedLines[0]).toEqual(event)

    // Fechamento e idempotência de close()
    await journal.close()
    await journal.close()

    // append após close() rejeita com AdeError(journal_closed, exit 2)
    await expect(journal.append({ kind: 'note' })).rejects.toSatisfy(
      (err: unknown) => {
        return (
          err instanceof AdeError &&
          err.code === 'journal_closed' &&
          err.exitCode === 2
        )
      },
    )
  })

  // AC2: Dado um journal vazio, quando 20 append são disparados sem await entre si e
  // esperados com Promise.all, então o arquivo tem 20 linhas com seq de 1 a 20 em ordem
  // e cada prev é digest16 do evento da linha anterior (a primeira com 16 zeros).
  test('concurrent_appends_are_serialized_with_valid_chain', async () => {
    const missionDir = createMissionDir()
    const journal = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
    })

    const promises = Array.from({ length: 20 }, (_, i) =>
      journal.append({ kind: 'note', index: i }),
    )
    const events = await Promise.all(promises)
    await journal.close()

    const filePath = path.join(missionDir, 'journal.jsonl')
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.trimEnd().split('\n').map((l) => JSON.parse(l))

    expect(lines).toHaveLength(20)
    expect(events).toHaveLength(20)

    for (let i = 0; i < 20; i++) {
      expect(lines[i].seq).toBe(i + 1)
      expect(events[i].seq).toBe(i + 1)
      expect(lines[i]).toEqual(events[i])

      if (i === 0) {
        expect(lines[i].prev).toBe(GENESIS_PREV)
      } else {
        expect(lines[i].prev).toBe(digest16(lines[i - 1]))
      }
    }
  })

  // AC3: Dado um partial sem kind, quando append é chamado, então rejeita com
  // InvalidEventError (exit 4), nada é gravado e o append seguinte recebe seq 1.
  test('invalid_event_is_refused_with_exit_4_and_consumes_no_seq', async () => {
    const missionDir = createMissionDir()
    const journal = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
    })
    const filePath = path.join(missionDir, 'journal.jsonl')

    // append({}) rejeita por falta de kind, arquivo continua vazio
    await expect(journal.append({} as any)).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof InvalidEventError &&
        err.exitCode === 4 &&
        err.code === 'schema_invalid'
      )
    })
    expect(readFileSync(filePath, 'utf8')).toBe('')

    // append({kind:'note', seq: 9}) rejeita com path /seq e exit 4
    await expect(
      journal.append({ kind: 'note', seq: 9 } as any),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as InvalidEventError
      return (
        e instanceof InvalidEventError &&
        e.exitCode === 4 &&
        e.code === 'schema_invalid' &&
        (e.details as any)?.errors?.[0]?.path === '/seq'
      )
    })
    expect(readFileSync(filePath, 'utf8')).toBe('')

    // Rejeição para outros campos do envelope definidos pelo journal
    for (const field of ['format_version', 'at', 'prev', 'runtime_stamp']) {
      await expect(
        journal.append({ kind: 'note', [field]: 'invalid' } as any),
      ).rejects.toSatisfy((err: unknown) => {
        const e = err as InvalidEventError
        return (
          e instanceof InvalidEventError &&
          e.exitCode === 4 &&
          (e.details as any)?.errors?.[0]?.path === `/${field}`
        )
      })
    }
    expect(readFileSync(filePath, 'utf8')).toBe('')

    // Append válido subsequente recebe seq 1
    const validEvent = await journal.append({ kind: 'note' })
    expect(validEvent.seq).toBe(1)

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0].seq).toBe(1)

    await journal.close()
  })

  // AC4: Dado um journal com 2 linhas fechado e reaberto, quando um novo append ocorre,
  // então sai com seq 3 e prev igual a digest16 da linha 2.
  test('reopened_journal_continues_the_chain', async () => {
    const missionDir = createMissionDir()

    const j1 = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
    })
    const e1 = await j1.append({ kind: 'note', message: 'primeiro' })
    const e2 = await j1.append({ kind: 'note', message: 'segundo' })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e2.prev).toBe(digest16(e1))
    await j1.close()

    // Reabre o journal existente
    const j2 = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
    })
    const e3 = await j2.append({ kind: 'note', message: 'terceiro' })
    expect(e3.seq).toBe(3)
    expect(e3.prev).toBe(digest16(e2))
    await j2.close()

    const filePath = path.join(missionDir, 'journal.jsonl')
    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(3)
    expect(lines[0].seq).toBe(1)
    expect(lines[1].seq).toBe(2)
    expect(lines[2].seq).toBe(3)
    expect(lines[2].prev).toBe(digest16(lines[1]))
  })

  // Prova de regressão: partial primitivo ou não-objeto é recusado com exit 4
  test('primitive_or_invalid_partial_is_refused_with_exit_4', async () => {
    const missionDir = createMissionDir()
    const journal = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
    })

    const invalidInputs = ['texto', 42, true, null, undefined, [1, 2]]
    for (const input of invalidInputs) {
      await expect(journal.append(input as any)).rejects.toSatisfy(
        (err: unknown) => {
          return (
            err instanceof InvalidEventError &&
            err.exitCode === 4 &&
            err.code === 'schema_invalid'
          )
        },
      )
    }

    const filePath = path.join(missionDir, 'journal.jsonl')
    expect(readFileSync(filePath, 'utf8')).toBe('')

    const validEvent = await journal.append({ kind: 'note' })
    expect(validEvent.seq).toBe(1)
    await journal.close()
  })

  // Prova de robustez: escritas parciais de writeSync são completadas antes do fsyncSync
  test('partial_writes_are_retried_until_complete_before_fsync', async () => {
    const missionDir = createMissionDir()
    const writeLengths: number[] = []
    let fsyncCalled = false

    const fsImpl = {
      ...fs,
      writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number) => {
        const actualLength = length ?? (buffer as Buffer).length
        const chunkSize = Math.min(actualLength, 15)
        writeLengths.push(chunkSize)
        return fs.writeSync(fd, buffer, offset ?? 0, chunkSize)
      },
      fsyncSync: (fd: number) => {
        fsyncCalled = true
        return fs.fsyncSync(fd)
      },
    }

    const journal = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
      fsImpl: fsImpl as unknown as typeof fs,
    })

    const event = await journal.append({
      kind: 'note',
      message: 'mensagem suficientemente longa para exigir multiplas escritas parciais no fsync',
    })
    await journal.close()

    expect(writeLengths.length).toBeGreaterThan(1)
    expect(fsyncCalled).toBe(true)

    const filePath = path.join(missionDir, 'journal.jsonl')
    const rawContent = readFileSync(filePath, 'utf8')
    expect(rawContent).toBe(canonicalize(event) + '\n')
    expect(JSON.parse(rawContent.trim())).toEqual(event)
  })

  // Prova de injeção de dependência: open e reopen utilizam métodos de fsImpl
  test('open_and_reopen_use_injected_fsimpl_methods', async () => {
    const missionDir = createMissionDir()
    const calls: string[] = []

    const fsImpl = {
      ...fs,
      mkdirSync: ((dirPath: fs.PathLike, options?: any) => {
        calls.push('mkdir')
        return fs.mkdirSync(dirPath, options)
      }) as typeof fs.mkdirSync,
      existsSync: ((dirPath: fs.PathLike) => {
        calls.push('exists')
        return fs.existsSync(dirPath)
      }) as typeof fs.existsSync,
      readFileSync: ((filePath: fs.PathOrFileDescriptor, options?: any) => {
        calls.push('read')
        return fs.readFileSync(filePath, options)
      }) as typeof fs.readFileSync,
    }

    const j1 = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
      fsImpl,
    })
    expect(calls).toContain('mkdir')
    expect(calls).toContain('exists')

    const e1 = await j1.append({ kind: 'note', title: 'linha-1' })
    await j1.close()

    calls.length = 0
    const j2 = openJournal({
      missionDir,
      runtimeStamp: '1:aa:bb',
      fsImpl,
    })
    expect(calls).toContain('mkdir')
    expect(calls).toContain('exists')
    expect(calls).toContain('read')

    const e2 = await j2.append({ kind: 'note', title: 'linha-2' })
    expect(e2.seq).toBe(2)
    expect(e2.prev).toBe(digest16(e1))
    await j2.close()
  })
})
