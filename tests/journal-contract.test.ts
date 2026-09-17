import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { validate } from '../src/schema/index.js'
import {
  AdeError,
  JournalCorruptError,
  InvalidEventError,
  StaleWorkflowVersionError,
  CoordinatorConflictError,
  LeaseAwaitingOperatorError,
} from '../src/journal/errors.js'
import {
  CORE_VERSION,
  buildRuntimeStamp,
  parseRuntimeStamp,
  findStaleIntents,
  assertStampCurrent,
  acceptStaleVersion,
} from '../src/journal/stamp.js'
import {
  GENESIS_PREV,
  openJournal,
  readJournal,
  fold,
} from '../src/journal/journal.js'
import { acquireLease } from '../src/lease/lease.js'
import { getProcessStartTime, isProcessAlive } from '../src/lease/process-info.js'

// AC1 & AC2: o schema aceita fixtures antigas, campos novos válidos e recusa valores inválidos
describe('journal contract', () => {
  test('journal_event_schema_extension_is_additive', () => {
    const validRaw = readFileSync(
      new URL('../fixtures/schemas/journal-event/valid.json', import.meta.url),
      'utf8',
    )
    const validFixture = JSON.parse(validRaw) as Record<string, unknown>

    const invalidRaw = readFileSync(
      new URL('../fixtures/schemas/journal-event/invalid.json', import.meta.url),
      'utf8',
    )
    const invalidFixture = JSON.parse(invalidRaw) as Record<string, unknown>

    // (1) valid.json continua aceito; invalid.json continua recusado apontando __unexpected__
    const validResult = validate('journal-event', validFixture)
    expect(validResult.valid).toBe(true)

    const invalidResult = validate('journal-event', invalidFixture)
    expect(invalidResult.valid).toBe(false)
    expect(
      invalidResult.errors.some((err) => err.path.includes('__unexpected__')),
    ).toBe(true)

    // (2) evento com step_id, status, source e data é aceito
    const extendedValid = {
      ...validFixture,
      step_id: 'step-1',
      status: 'running',
      source: 'operator',
      data: { key: 'value', count: 42 },
    }
    const extendedResult = validate('journal-event', extendedValid)
    expect(extendedResult.valid).toBe(true)

    // com step_id: '' é recusado
    const emptyStepIdResult = validate('journal-event', {
      ...extendedValid,
      step_id: '',
    })
    expect(emptyStepIdResult.valid).toBe(false)

    // com status: '' é recusado
    const emptyStatusResult = validate('journal-event', {
      ...extendedValid,
      status: '',
    })
    expect(emptyStatusResult.valid).toBe(false)

    // com source: '' é recusado
    const emptySourceResult = validate('journal-event', {
      ...extendedValid,
      source: '',
    })
    expect(emptySourceResult.valid).toBe(false)

    // com data não-objeto (ex.: string) é recusado
    const stringDataResult = validate('journal-event', {
      ...extendedValid,
      data: 'texto',
    })
    expect(stringDataResult.valid).toBe(false)
  })

  // AC3: cada uma das 5 subclasses estende AdeError e carrega code, exitCode e details
  test('typed_errors_carry_exit_codes', () => {
    const baseError = new AdeError('base_code', 'mensagem base', 2, { extra: 'ok' })
    expect(baseError).toBeInstanceOf(Error)
    expect(baseError).toBeInstanceOf(AdeError)
    expect(baseError.name).toBe('AdeError')
    expect(baseError.code).toBe('base_code')
    expect(baseError.exitCode).toBe(2)
    expect(baseError.message).toBe('mensagem base')
    expect(baseError.details).toEqual({ extra: 'ok' })

    // JournalCorruptError: exit 2, code journal_corrupt, details {line, reason}
    const corruptError = new JournalCorruptError(3, 'prev_mismatch')
    expect(corruptError).toBeInstanceOf(Error)
    expect(corruptError).toBeInstanceOf(AdeError)
    expect(corruptError.name).toBe('JournalCorruptError')
    expect(corruptError.code).toBe('journal_corrupt')
    expect(corruptError.exitCode).toBe(2)
    expect(corruptError.message).toBe('journal corrompido na linha 3: prev_mismatch')
    expect(corruptError.details).toEqual({ line: 3, reason: 'prev_mismatch' })

    // InvalidEventError: exit 4, code schema_invalid, details {errors}
    const schemaErrors = [{ path: '/step_id', message: 'minLength falhou' }]
    const invalidEventError = new InvalidEventError(schemaErrors)
    expect(invalidEventError).toBeInstanceOf(Error)
    expect(invalidEventError).toBeInstanceOf(AdeError)
    expect(invalidEventError.name).toBe('InvalidEventError')
    expect(invalidEventError.code).toBe('schema_invalid')
    expect(invalidEventError.exitCode).toBe(4)
    expect(invalidEventError.message).toBe('evento inválido: /step_id minLength falhou')
    expect(invalidEventError.details).toEqual({ errors: schemaErrors })

    // StaleWorkflowVersionError: exit 2, code stale_workflow_version, details {stale, current_core_version}
    const staleIntents = [
      { seq: 1, step_id: 's1', effect_class: 'none', runtime_stamp: '2:aa:bb' },
    ]
    const staleError = new StaleWorkflowVersionError(staleIntents, 1)
    expect(staleError).toBeInstanceOf(Error)
    expect(staleError).toBeInstanceOf(AdeError)
    expect(staleError.name).toBe('StaleWorkflowVersionError')
    expect(staleError.code).toBe('stale_workflow_version')
    expect(staleError.exitCode).toBe(2)
    expect(staleError.message).toBe(
      'stale_workflow_version: 1 intenção(ões) aberta(s) de outro core_version; atual 1',
    )
    expect(staleError.details).toEqual({
      stale: staleIntents,
      current_core_version: 1,
    })

    // CoordinatorConflictError: exit 5, code coordinator_conflict, details {owner}
    const conflictWithOwner = new CoordinatorConflictError({ pid: 42 })
    expect(conflictWithOwner).toBeInstanceOf(Error)
    expect(conflictWithOwner).toBeInstanceOf(AdeError)
    expect(conflictWithOwner.name).toBe('CoordinatorConflictError')
    expect(conflictWithOwner.code).toBe('coordinator_conflict')
    expect(conflictWithOwner.exitCode).toBe(5)
    expect(conflictWithOwner.message).toBe('coordinator_conflict: lease em uso por pid 42')
    expect(conflictWithOwner.details).toEqual({ owner: { pid: 42 } })

    const conflictWithoutOwner = new CoordinatorConflictError(null)
    expect(conflictWithoutOwner.exitCode).toBe(5)
    expect(conflictWithoutOwner.code).toBe('coordinator_conflict')
    expect(conflictWithoutOwner.message).toBe(
      'coordinator_conflict: lease em uso por pid desconhecido',
    )
    expect(conflictWithoutOwner.details).toEqual({ owner: null })

    // LeaseAwaitingOperatorError: exit 3, code awaiting_operator, details {owner, reason}
    const awaitingError = new LeaseAwaitingOperatorError(
      { pid: 99 },
      'dono vivo com lease expirado',
    )
    expect(awaitingError).toBeInstanceOf(Error)
    expect(awaitingError).toBeInstanceOf(AdeError)
    expect(awaitingError.name).toBe('LeaseAwaitingOperatorError')
    expect(awaitingError.code).toBe('awaiting_operator')
    expect(awaitingError.exitCode).toBe(3)
    expect(awaitingError.message).toBe('awaiting_operator: dono vivo com lease expirado')
    expect(awaitingError.details).toEqual({
      owner: { pid: 99 },
      reason: 'dono vivo com lease expirado',
    })
  })

  // AC4: buildRuntimeStamp e parseRuntimeStamp validam formato e lançam TypeError
  test('runtime_stamp_builds_and_parses', () => {
    expect(CORE_VERSION).toBe(1)

    // buildRuntimeStamp
    expect(
      buildRuntimeStamp({ configDigest: 'aa', capabilitiesDigest: 'bb' }),
    ).toBe('1:aa:bb')
    expect(
      buildRuntimeStamp({
        coreVersion: 7,
        configDigest: 'abc',
        capabilitiesDigest: 'def',
      }),
    ).toBe('7:abc:def')

    // buildRuntimeStamp inválido
    expect(() =>
      buildRuntimeStamp({
        coreVersion: -1,
        configDigest: 'aa',
        capabilitiesDigest: 'bb',
      }),
    ).toThrow(TypeError)
    expect(() =>
      buildRuntimeStamp({
        configDigest: 'ZZ',
        capabilitiesDigest: 'bb',
      }),
    ).toThrow(TypeError)
    expect(() =>
      buildRuntimeStamp({
        configDigest: 'aa',
        capabilitiesDigest: 'ZZ',
      }),
    ).toThrow(TypeError)

    // parseRuntimeStamp
    expect(parseRuntimeStamp('7:abc:def')).toEqual({
      coreVersion: 7,
      configDigest: 'abc',
      capabilitiesDigest: 'def',
    })
    expect(parseRuntimeStamp('1:aa:bb')).toEqual({
      coreVersion: 1,
      configDigest: 'aa',
      capabilitiesDigest: 'bb',
    })

    // parseRuntimeStamp inválido
    expect(() => parseRuntimeStamp('1:aa')).toThrow(TypeError)
    expect(() => parseRuntimeStamp('x:1:2')).toThrow(TypeError)
    expect(() => parseRuntimeStamp('')).toThrow(TypeError)
  })

  // Interfaces exportadas pelos módulos do épico
  test('epic_modules_export_their_interfaces', () => {
    // journal.js
    expect(GENESIS_PREV).toBe('0000000000000000')
    expect(typeof openJournal).toBe('function')
    expect(typeof readJournal).toBe('function')
    expect(typeof fold).toBe('function')

    // stamp.js
    expect(CORE_VERSION).toBe(1)
    expect(typeof buildRuntimeStamp).toBe('function')
    expect(typeof parseRuntimeStamp).toBe('function')
    expect(typeof findStaleIntents).toBe('function')
    expect(typeof assertStampCurrent).toBe('function')
    expect(typeof acceptStaleVersion).toBe('function')

    // lease.js
    expect(typeof acquireLease).toBe('function')

    // process-info.js
    expect(typeof getProcessStartTime).toBe('function')
    expect(typeof isProcessAlive).toBe('function')
  })
})
