import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { canonicalize } from '../src/journal/canonical.js'

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
