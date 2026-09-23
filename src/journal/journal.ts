import fs from 'node:fs'
import path from 'node:path'
import { canonicalize, digest16 } from './canonical.ts'
import { AdeError, InvalidEventError, JournalCorruptError } from './errors.ts'
import { validate } from '../schema/index.ts'

export const GENESIS_PREV = '0000000000000000'

const RUNTIME_STAMP_REGEX = /^[0-9]+:[0-9a-f]+:[0-9a-f]+$/

const ENVELOPE_FIELDS = ['format_version', 'seq', 'at', 'prev', 'runtime_stamp']

const TOP_LEVEL_PROPERTIES = new Set([
  'format_version',
  'seq',
  'at',
  'prev',
  'kind',
  'effect_class',
  'input_digest',
  'intent_context',
  'worktree',
  'receipt_path',
  'session_ref',
  'runtime_stamp',
  'step_id',
  'status',
  'source',
  'data',
  'artifact_ref',
  'cache_hit',
  'workspace',
  'risk_escalated',
])

/**
 * Diário append-only serializado com integridade hash e persistência em disco.
 */
export class Journal {
  filePath: string
  fd: number
  fsImpl: typeof fs
  now: () => Date
  runtimeStamp: string
  lastSeq: number
  lastDigest: string
  tail: Promise<unknown>
  closed: boolean
  _fdClosed: boolean

  constructor({ filePath, fd, fsImpl, now, runtimeStamp, lastSeq, lastDigest }: {
    filePath: string
    fd: number
    fsImpl: typeof fs
    now: () => Date
    runtimeStamp: string
    lastSeq: number
    lastDigest: string
  }) {
    this.filePath = filePath
    this.fd = fd
    this.fsImpl = fsImpl
    this.now = now
    this.runtimeStamp = runtimeStamp
    this.lastSeq = lastSeq
    this.lastDigest = lastDigest
    this.tail = Promise.resolve()
    this.closed = false
    this._fdClosed = false
  }

  /**
   * Grava um evento no journal com atomicidade e garantia de fsync.
   */
  append(partial: Record<string,unknown>): Promise<Record<string,unknown>> {
    if (this.closed) {
      return Promise.reject(new AdeError('journal_closed', 'journal fechado', 2))
    }

    const task = async () => {
      // Rejeita partial não-objeto via schema antes de inspecionar campos do envelope
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        const result = validate('journal-event', partial)
        throw new InvalidEventError(result.errors)
      }

      // Rejeita campos de envelope controlados exclusivamente pelo journal
      for (const field of ENVELOPE_FIELDS) {
        if (field in partial) {
          throw new InvalidEventError([
            {
              path: `/${field}`,
              message: 'campo do envelope é definido pelo journal',
            },
          ])
        }
      }

      // Separa propriedades canônicas do envelope e atributos adicionais para preservação em data
      const extra: Record<string,unknown> = {}
      const cleanPartial: Record<string,unknown> = {}
      for (const [k, v] of Object.entries(partial)) {
        if (TOP_LEVEL_PROPERTIES.has(k)) {
          cleanPartial[k] = v
        } else {
          extra[k] = v
        }
      }

      let data = cleanPartial.data
      if (Object.keys(extra).length > 0) {
        data = data && typeof data === 'object' ? { ...data, ...extra } : extra
      }

      // input_digest padrão deriva do payload sem intent_context
      let inputDigest = cleanPartial.input_digest
      if (inputDigest === undefined) {
        const withoutIntentContext = { ...partial }
        delete withoutIntentContext.intent_context
        inputDigest = digest16(withoutIntentContext)
      }

      const currentDate = typeof this.now === 'function' ? this.now() : new Date()
      const at = currentDate.toISOString().replace(/\.\d{3}Z$/, 'Z')

      const event = {
        effect_class: 'none',
        intent_context: {},
        worktree: '',
        receipt_path: '',
        session_ref: null,
        ...cleanPartial,
        ...(data !== undefined ? { data } : {}),
        input_digest: inputDigest,
        format_version: 1,
        seq: this.lastSeq + 1,
        at,
        prev: this.lastDigest,
        runtime_stamp: this.runtimeStamp,
      }

      const result = validate('journal-event', event)
      if (!result.valid) {
        throw new InvalidEventError(result.errors)
      }

      const line = canonicalize(event) + '\n'
      const buffer = Buffer.from(line, 'utf8')
      let offset = 0
      // Persiste o buffer completo lidando com escritas parciais antes de sincronizar
      while (offset < buffer.length) {
        const written = this.fsImpl.writeSync(
          this.fd,
          buffer,
          offset,
          buffer.length - offset,
        )
        if (typeof written === 'number') {
          if (written <= 0) {
            throw new Error('Falha ao escrever no journal: nenhum byte gravado')
          }
          offset += written
        } else {
          offset = buffer.length
        }
      }
      this.fsImpl.fsyncSync(this.fd)

      this.lastSeq = event.seq
      this.lastDigest = digest16(event)

      return event
    }

    const run = this.tail.then(task)
    this.tail = run.catch(() => {})
    return run
  }

  /**
   * Aguarda a fila pendente e fecha o descritor de arquivo de forma idempotente.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.tail
    if (!this._fdClosed) {
      this._fdClosed = true
      this.fsImpl.closeSync(this.fd)
    }
  }
}

/**
 * Abre o diário append-only garantindo integridade e lock do escritor (s2).
 */
export function openJournal({
  missionDir,
  runtimeStamp,
  fsImpl = fs,
  now = () => new Date(),
}: {
missionDir: string
runtimeStamp: string
fsImpl?: typeof fs
now?: () => Date
} = ({} as any)): Journal {
  if (typeof runtimeStamp !== 'string' || !RUNTIME_STAMP_REGEX.test(runtimeStamp)) {
    throw new TypeError('runtime_stamp inválido: ' + runtimeStamp)
  }

  const mkdirSync =
    typeof fsImpl.mkdirSync === 'function'
      ? fsImpl.mkdirSync.bind(fsImpl)
      : fs.mkdirSync
  const existsSync =
    typeof fsImpl.existsSync === 'function'
      ? fsImpl.existsSync.bind(fsImpl)
      : fs.existsSync
  const readFileSync =
    typeof fsImpl.readFileSync === 'function'
      ? fsImpl.readFileSync.bind(fsImpl)
      : fs.readFileSync

  // Usa fsImpl para todas as operações de filesystem garantindo isolamento em testes
  mkdirSync(missionDir, { recursive: true })
  const filePath = path.join(missionDir, 'journal.jsonl')

  let lastSeq = 0
  let lastDigest = GENESIS_PREV

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1]
      const lastEvent = JSON.parse(lastLine)
      lastSeq = lastEvent.seq
      lastDigest = digest16(lastEvent)
    }
  }

  const fd = fsImpl.openSync(filePath, 'a')

  return new Journal({
    filePath,
    fd,
    fsImpl,
    now,
    runtimeStamp,
    lastSeq,
    lastDigest,
  })
}

/**
 * Lê e valida sequencialmente o diário e a cadeia de hash (s3).
 */
export function readJournal(filePath: string): {
events: Array<Record<string,any>>
tornTail: null|{ line: number; bytesDropped: number; validBytes: number }
} {
  if (!fs.existsSync(filePath)) {
    return { events: [], tornTail: null }
  }

  const buf = fs.readFileSync(filePath)
  if (buf.length === 0) {
    return { events: [], tornTail: null }
  }

  const lastLf = buf.lastIndexOf(10)

  if (lastLf === -1) {
    return {
      events: [],
      tornTail: {
        line: 1,
        bytesDropped: buf.length,
        validBytes: 0,
      },
    }
  }

  const validBytes = lastLf + 1
  const completeBuf = buf.subarray(0, validBytes)
  const segments = completeBuf.toString('utf8').slice(0, -1).split('\n')

  let tornTail: null|{ line: number; bytesDropped: number; validBytes: number } = null
  if (lastLf < buf.length - 1) {
    const bytesDropped = buf.length - validBytes
    tornTail = {
      line: segments.length + 1,
      bytesDropped,
      validBytes,
    }
  }

  const events: Array<Record<string,unknown>> = []
  let expectedPrev = GENESIS_PREV

  for (let i = 0; i < segments.length; i++) {
    const line = i + 1

    let parsed
    try {
      parsed = JSON.parse(segments[i])
    } catch {
      throw new JournalCorruptError(line, 'invalid_json')
    }

    const result = validate('journal-event', parsed)
    if (!result.valid) {
      throw new JournalCorruptError(line, 'schema_invalid')
    }

    const ev: Record<string,unknown> = parsed

    if (ev.format_version !== 1) {
      throw new JournalCorruptError(line, 'unknown_format_version')
    }

    if (ev.seq !== line) {
      throw new JournalCorruptError(line, 'seq_gap')
    }

    if (ev.prev !== expectedPrev) {
      throw new JournalCorruptError(line, 'prev_mismatch')
    }

    let canonical
    try {
      canonical = canonicalize(ev)
    } catch {
      throw new JournalCorruptError(line, 'not_canonical')
    }

    if (canonical !== segments[i]) {
      throw new JournalCorruptError(line, 'not_canonical')
    }

    events.push(ev)
    expectedPrev = digest16(ev)
    if (ev.data && typeof ev.data === 'object' && 'reconciled' in ev.data) {
      ev.reconciled = ev.data.reconciled
    }
  }

  return { events, tornTail }
}

// Reexporta a função fold para consolidação pura do estado da missão.
export { fold } from './fold.ts'

