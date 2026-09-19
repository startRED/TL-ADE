import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { validate, validateSupported } from '../src/schema/index.js'

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

  test('CA1: validateSupported accepts format_version 1 as valid, legacy (current: false)', () => {
    const validUnitResult = loadFixture('unit-result', 'valid')
    const unitResult = validateSupported('unit-result', validUnitResult)
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
    const invalidUnitResult = loadFixture('unit-result', 'invalid')
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

