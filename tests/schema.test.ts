import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { validate, validateSupported } from '../src/schema/index.js'
import { parseClaudeOutput, parseUnitResult } from '../src/adapters/claude/parse.js'

const SCHEMA_NAMES = [
  'journal-event',
  'ade-config',
  'plan',
  'task-contract',
  'eval',
  'unit-result',
  'review-result',
  'capability-set',
] as const

function loadFixture(schemaName: string, kind: 'valid' | 'invalid'): unknown {
  const raw = readFileSync(
    new URL(`../fixtures/schemas/${schemaName}/${kind}.json`, import.meta.url),
    'utf8',
  )
  return JSON.parse(raw)
}

// AC2: cada um dos oito contratos aceita um exemplo válido e recusa um exemplo
// inválido apontando o caminho do campo com erro; configuração com campo
// desconhecido é recusada com código 4, nunca ignorada em silêncio.
describe('published schemas', () => {
  test('published_schemas_accept_valid_and_refuse_invalid_fixtures', () => {
    expect(SCHEMA_NAMES.length).toBe(8)

    for (const schemaName of SCHEMA_NAMES) {
      const validDoc = loadFixture(schemaName, 'valid')
      const validResult = validate(schemaName, validDoc)
      expect(validResult.valid, `${schemaName} valid fixture should be accepted`).toBe(true)

      const invalidDoc = loadFixture(schemaName, 'invalid')
      const invalidResult = validate(schemaName, invalidDoc)
      expect(invalidResult.valid, `${schemaName} invalid fixture should be refused`).toBe(false)
      if (invalidResult.valid) continue

      expect(invalidResult.errors.length).toBeGreaterThan(0)
      const pointsAtUnexpectedField = invalidResult.errors.some((error) =>
        error.path.includes('__unexpected__'),
      )
      expect(
        pointsAtUnexpectedField,
        `${schemaName} error should point at the unknown field's path`,
      ).toBe(true)

      // configuração com campo desconhecido nunca é ignorada em silêncio: sai com código 4
      if (schemaName === 'ade-config') {
        expect(invalidResult.code).toBe(4)
      }
    }
  })

  const LEGACY_V1_UNIT_RESULT = {
    format_version: 1,
    story_id: 'ADE-S1',
    state: 'done',
    phase: 'green',
    round: 1,
    tree_before: '0123456789abcdef',
    tree_after: 'fedcba9876543210',
    eval_records: [
      {
        id: 'E1',
        phase: 'red',
        passed: false,
        red_reason: 'assertion_failed',
      },
    ],
    gate_records: [],
    passes: true,
    reason: 'eval verde após implementação',
    sources: ['0123456789abcdef'],
  }

  const LEGACY_V1_INVALID_UNIT_RESULT = {
    ...LEGACY_V1_UNIT_RESULT,
    __unexpected__: true,
  }

  test('CA1: validateSupported accepts format_version 1 as valid, legacy (current: false)', () => {
    const unitResult = validateSupported('unit-result', LEGACY_V1_UNIT_RESULT)
    expect(unitResult.valid).toBe(true)
    expect(unitResult.errors).toEqual([])
    expect(unitResult.formatVersion).toBe(1)
    expect(unitResult.current).toBe(false)

    const validReviewResult = loadFixture('review-result', 'valid')
    const reviewResult = validateSupported('review-result', validReviewResult)
    expect(reviewResult.valid).toBe(true)
    expect(reviewResult.errors).toEqual([])
    expect(reviewResult.formatVersion).toBe(1)
    expect(reviewResult.current).toBe(false)
  })

  test('CA2: validateSupported refuses format_version 3 with code 4 and unsupported_result_format on /format_version', () => {
    const docWithV3 = { format_version: 3 }
    const reviewRes = validateSupported('review-result', docWithV3)
    expect(reviewRes.valid).toBe(false)
    expect(reviewRes.current).toBe(false)
    expect(reviewRes.formatVersion).toBe(3)
    if (reviewRes.valid) return
    expect(reviewRes.code).toBe(4)
    expect(reviewRes.errors.length).toBeGreaterThan(0)
    const reviewErr = reviewRes.errors.find((e) => e.path === '/format_version')
    expect(reviewErr).toBeDefined()
    expect(
      reviewErr?.code === 'unsupported_result_format' ||
        reviewErr?.message?.includes('unsupported_result_format'),
    ).toBe(true)

    const unitRes = validateSupported('unit-result', docWithV3)
    expect(unitRes.valid).toBe(false)
    expect(unitRes.formatVersion).toBe(3)
    expect(unitRes.current).toBe(false)
    if (unitRes.valid) return
    expect(unitRes.code).toBe(4)
    const unitErr = unitRes.errors.find((e) => e.path === '/format_version')
    expect(unitErr).toBeDefined()
    expect(
      unitErr?.code === 'unsupported_result_format' ||
        unitErr?.message?.includes('unsupported_result_format'),
    ).toBe(true)
  })

  test('CA3: validate preserves acceptance of valid fixtures for the other six official schemas', () => {
    const otherSchemas = SCHEMA_NAMES.filter(
      (name) => name !== 'unit-result' && name !== 'review-result',
    )
    expect(otherSchemas.length).toBe(6)

    for (const schemaName of otherSchemas) {
      const validDoc = loadFixture(schemaName, 'valid')
      const result = validate(schemaName, validDoc)
      expect(result.valid, `${schemaName} valid fixture should continue to be accepted`).toBe(true)
      expect(result.errors).toEqual([])
    }
  })

  test('CA4: validateSupported refuses legacy document with __unexpected__ field pointing to /__unexpected__ and code 4', () => {
    const invalidUnitResult = LEGACY_V1_INVALID_UNIT_RESULT
    const unitRes = validateSupported('unit-result', invalidUnitResult)
    expect(unitRes.valid).toBe(false)
    expect(unitRes.current).toBe(false)
    expect(unitRes.formatVersion).toBe(1)
    if (unitRes.valid) return
    expect(unitRes.code).toBe(4)
    expect(unitRes.errors.length).toBeGreaterThan(0)
    const unitUnexpected = unitRes.errors.find((e) => e.path === '/__unexpected__')
    expect(unitUnexpected).toBeDefined()

    const invalidReviewResult = loadFixture('review-result', 'invalid')
    const reviewRes = validateSupported('review-result', invalidReviewResult)
    expect(reviewRes.valid).toBe(false)
    expect(reviewRes.current).toBe(false)
    expect(reviewRes.formatVersion).toBe(1)
    if (reviewRes.valid) return
    expect(reviewRes.code).toBe(4)
    expect(reviewRes.errors.length).toBeGreaterThan(0)
    const reviewUnexpected = reviewRes.errors.find((e) => e.path === '/__unexpected__')
    expect(reviewUnexpected).toBeDefined()
  })

})

describe('unit-result v2 contract evolution', () => {
  function readTranscriptStdout(name: string): string {
    return readFileSync(
      new URL(`../fixtures/transcripts/claude/${name}/stdout.json`, import.meta.url),
      'utf8',
    )
  }

  test('CA1: current fixture and valid Claude transcript return format_version 2, ready_for_verification, verify, cited: true, and no approval property', () => {
    const fixture = loadFixture('unit-result', 'valid') as Record<string, unknown>
    const fixtureVal = validate('unit-result', fixture)
    expect(fixtureVal.valid, `valid fixture should be valid: ${JSON.stringify(fixtureVal.errors)}`).toBe(true)
    expect(fixture.format_version).toBe(2)
    expect(fixture.state).toBe('ready_for_verification')
    expect(fixture.requested_action).toBe('verify')
    expect(fixture).not.toHaveProperty('passes')
    expect(fixture).not.toHaveProperty('approved')
    expect(fixture).not.toHaveProperty('reason')

    const transcriptStdout = readTranscriptStdout('ok_with_structured_output')
    const parsedClaude = parseClaudeOutput(transcriptStdout)
    expect(parsedClaude.error).toBeNull()
    const parsedResult = parseUnitResult(parsedClaude.envelope)
    expect(parsedResult.valid).toBe(true)
    expect(parsedResult.cited).toBe(true)
    const unitResult = parsedResult.unit_result as Record<string, unknown>
    expect(unitResult.format_version).toBe(2)
    expect(unitResult.state).toBe('ready_for_verification')
    expect(unitResult.requested_action).toBe('verify')
    expect(unitResult).not.toHaveProperty('passes')
    expect(unitResult).not.toHaveProperty('approved')
    expect(unitResult).not.toHaveProperty('reason')

    const withReason = { ...fixture, reason: 'narrativa legada não permitida na v2' }
    const resReason = validate('unit-result', withReason)
    expect(resReason.valid).toBe(false)
  })

  test('CA2: valid unit-result v1 is read with current: false by validateSupported and rejected by validate as current contract', () => {
    const v1Doc = {
      format_version: 1,
      story_id: 'ADE-S1',
      state: 'done',
      phase: 'green',
      round: 1,
      tree_before: '0123456789abcdef',
      tree_after: 'fedcba9876543210',
      eval_records: [
        {
          id: 'E1',
          phase: 'red',
          passed: false,
          red_reason: 'assertion_failed',
        },
      ],
      gate_records: [],
      passes: true,
      reason: 'eval verde após implementação',
      sources: ['0123456789abcdef'],
    }

    const supportedRes = validateSupported('unit-result', v1Doc)
    expect(supportedRes.valid).toBe(true)
    expect(supportedRes.formatVersion).toBe(1)
    expect(supportedRes.current).toBe(false)
    expect(supportedRes.errors).toEqual([])

    const currentRes = validate('unit-result', v1Doc)
    expect(currentRes.valid).toBe(false)
    if (currentRes.valid) return
    expect(currentRes.code).toBe(4)
    expect(currentRes.errors.length).toBeGreaterThan(0)
  })

  test('CA3: current fixture with requested_action approve is rejected pointing to /requested_action', () => {
    const fixture = loadFixture('unit-result', 'valid') as Record<string, unknown>
    const mutated = { ...fixture, requested_action: 'approve' }
    const result = validate('unit-result', mutated)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.errors.some((e) => e.path === '/requested_action')).toBe(true)
  })

  test('CA4: claim without evidence_refs or response without contract_revision is rejected pointing to missing field', () => {
    const fixture = loadFixture('unit-result', 'valid') as Record<string, any>

    // 1. Sem contract_revision
    const withoutContractRevision = { ...fixture }
    delete withoutContractRevision.contract_revision
    const resNoContract = validate('unit-result', withoutContractRevision)
    expect(resNoContract.valid).toBe(false)
    if (!resNoContract.valid) {
      expect(
        resNoContract.errors.some(
          (e) => e.path.includes('contract_revision') || e.message.includes('contract_revision'),
        ),
      ).toBe(true)
    }

    // 2. Claim sem evidence_refs
    const withoutEvidenceRefs = JSON.parse(JSON.stringify(fixture))
    if (withoutEvidenceRefs.handoff?.claims?.[0]) {
      delete withoutEvidenceRefs.handoff.claims[0].evidence_refs
    }
    const resNoEvidence = validate('unit-result', withoutEvidenceRefs)
    expect(resNoEvidence.valid).toBe(false)
    if (!resNoEvidence.valid) {
      expect(
        resNoEvidence.errors.some(
          (e) => e.path.includes('evidence_refs') || e.message.includes('evidence_refs'),
        ),
      ).toBe(true)
    }
  })
})


