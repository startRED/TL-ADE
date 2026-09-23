import fs from 'node:fs'
import { describe, expect, test } from 'vitest'

import { dropNulls, strictSchema } from '../src/adapters/codex/strict-schema.ts'

describe('schema estrito do codex', () => {
  test('todo_campo_vira_obrigatorio_opcional_vira_anulavel_e_somem_as_palavras_que_a_openai_recusa', () => {
    const review = JSON.parse(fs.readFileSync('schemas/review-result.schema.json', 'utf8'))
    const strict = strictSchema(review)
    const text = JSON.stringify(strict)
    for (const word of ['"dependencies"', '"pattern"', '"definitions"', '"$schema"', '#/definitions/']) expect(text).not.toContain(word)
    const finding = strict.$defs.finding
    expect(finding.required).toEqual(Object.keys(finding.properties))
    expect(finding.properties.citation.type).toEqual(['string', 'null'])
    expect(finding.properties.id.type).toBe('string')
  })

  test('na_volta_os_opcionais_null_saem_antes_de_validar_contra_o_original', () => {
    expect(dropNulls({ a: 1, b: null, c: [{ d: null, e: 'x' }] })).toEqual({ a: 1, c: [{ e: 'x' }] })
  })
})
