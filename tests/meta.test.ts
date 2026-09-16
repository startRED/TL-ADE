import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const CHARTER_PATH = fileURLToPath(new URL('../PROJECT_CHARTER.md', import.meta.url))

// AC4: PROJECT_CHARTER.md existe na raiz e diz o que a ADE é, o que não é e o
// que não pode entrar no código nesta fatia.
describe('PROJECT_CHARTER.md', () => {
  test('project_charter_declares_what_ade_is_is_not_and_scope_limits', () => {
    expect(existsSync(CHARTER_PATH)).toBe(true)

    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const normalized = charter.toLowerCase()

    // o que a ADE é
    expect(normalized).toContain('a ade é')
    // o que a ADE não é
    expect(normalized).toContain('não é')
    // o que não pode entrar no código nesta fatia (regra de ampliação de escopo)
    expect(normalized).toContain('fatia')
    expect(normalized).toContain('src/')
  })
})
