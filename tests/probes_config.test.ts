import { describe, expect, test } from 'vitest'
import { configDefaults } from 'vitest/config'
import { selectTests } from '../vitest.config.mjs'

describe('probes config', () => {
  test('default_suite_excludes_probes', () => {
    expect(selectTests({})).toEqual({
      include: ['tests/**/*.test.ts'],
      exclude: [...configDefaults.exclude, 'tests/probes/**'],
    })
  })

  test('probes_target_includes_only_probes', () => {
    expect(selectTests({ ADE_PROBES: '1' })).toEqual({
      include: ['tests/probes/**/*.test.ts'],
      exclude: [...configDefaults.exclude],
    })
  })

  test('probes_flag_other_than_1_is_ignored', () => {
    expect(selectTests({ ADE_PROBES: '0' })).toEqual(selectTests({}))
    expect(selectTests({ ADE_PROBES: 'true' })).toEqual(selectTests({}))
  })
})
