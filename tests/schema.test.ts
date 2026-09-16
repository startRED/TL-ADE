import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { validate } from '../src/schema/index.js'

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
})
