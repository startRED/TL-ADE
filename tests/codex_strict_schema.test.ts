import fs from 'node:fs'
import { describe, expect, test } from 'vitest'

import { dropNulls, fitToSchema, strictSchema } from '../src/adapters/codex/strict-schema.ts'

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

// 24/09, missão real: o modo estrito tira dependencies e maxLength do schema que o Codex vê; ele devolveu
// `withdrawn: false` sem citation/withdrawn_reason e um `problem` de 250 caracteres, e a revisão inteira foi recusada
// por formato e contada como reprovação. Na volta, o parecer é ajustado ao schema original sem mudar o que ele diz.
describe('ajuste do parecer do Codex ao schema original', () => {
  test('withdrawn_false_sem_citacao_sai_e_texto_longo_e_encurtado', () => {
    const review = {
      action_items: [{ id: 'F1', severity: 'high', category: 'patch', problem: 'x'.repeat(250), required_action: 'fazer', target_role: 'maker', evidence_refs: ['eval:V1'], location: 'eval:V1', withdrawn: false }],
      summary: 'y'.repeat(500),
    }
    const fitted = fitToSchema(review, JSON.parse(fs.readFileSync('schemas/review-result.schema.json', 'utf8')))
    expect(fitted.action_items[0]).not.toHaveProperty('withdrawn')
    expect(fitted.action_items[0].problem.length).toBe(220)
    expect(fitted.action_items[0].problem.endsWith('…')).toBe(true)
    expect(fitted.summary.length).toBe(400)
    expect(fitted.action_items[0].required_action).toBe('fazer')
  })
})
