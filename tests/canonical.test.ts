import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { canonicalize, digest16 } from '../src/journal/canonical.ts'

// AC3: canonicalizar os objetos do conjunto de referência produz bytes
// idênticos aos do runtime Python de referência (json.dumps com sort_keys=True,
// ensure_ascii=False, separators=(',', ':')).
describe('canonical', () => {
  test('canonicalize_output_byte_identical_to_python_reference_fixture', () => {
    const raw = readFileSync(new URL('../fixtures/jcs/reference.jsonl', import.meta.url), 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)

    expect(lines.length).toBeGreaterThan(0)

    for (const line of lines) {
      const { input, expected } = JSON.parse(line) as { input: unknown; expected: string }
      const actual = canonicalize(input)
      expect(Buffer.from(actual, 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(true)
    }
  })

  test('canonicalize_integer_valued_float_matches_js_number_tostring', () => {
    expect(canonicalize({ a: 1.0 })).toBe('{"a":1}')
  })

  test('canonicalize_rejects_lone_surrogate', () => {
    const withLoneSurrogate = { bad: '\uD800' }
    expect(() => canonicalize(withLoneSurrogate)).toThrow()
  })
})

describe('digest16', () => {
  test('digest16_returns_16_lowercase_hex_chars', () => {
    expect(digest16({ a: 1 })).toMatch(/^[0-9a-f]{16}$/)
    expect(digest16({})).toBe('44136fa355b3678a')
  })

  test('digest16_is_stable_across_key_order', () => {
    const obj1 = { a: 1, b: { c: 2, d: 3 } }
    const obj2 = { b: { d: 3, c: 2 }, a: 1 }
    expect(digest16(obj1)).toBe(digest16(obj2))
    expect(digest16({ a: 1 })).not.toBe(digest16({ a: 2 }))
  })

  test('digest16_matches_sha256_prefix_of_canonical_text', () => {
    const raw = readFileSync(new URL('../fixtures/jcs/reference.jsonl', import.meta.url), 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)

    expect(lines.length).toBeGreaterThan(0)

    for (const line of lines) {
      const { input } = JSON.parse(line) as { input: unknown }
      const expected = createHash('sha256').update(canonicalize(input), 'utf8').digest('hex').slice(0, 16)
      expect(digest16(input)).toBe(expected)
    }
  })

  test('digest16_treats_integer_valued_float_as_integer', () => {
    expect(digest16({ a: 1.0 })).toBe(digest16({ a: 1 }))
  })

  test('digest16_propagates_canonicalize_errors', () => {
    expect(typeof digest16).toBe('function')
    expect(() => digest16({ bad: '\uD800' })).toThrow(TypeError)
    expect(() => digest16(undefined)).toThrow()
  })
})

