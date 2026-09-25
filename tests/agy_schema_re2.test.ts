import fs from 'node:fs'
import { expect, test } from 'vitest'
import { buildAgyArgs, goRegexSafe } from '../src/adapters/agy/argv.ts'

// 25/09, missão real: o agy valida o schema com o regexp do Go, que recusa "(?!"; o schema de resultado de unidade
// tem esse padrão nas refs tipadas e a etapa de prova parava. Vai uma cópia sem esses padrões; os outros ficam.
test('schema_do_agy_sai_sem_padrao_que_o_go_recusa', () => {
  const unit = fs.readFileSync(new URL('../schemas/unit-result.schema.json', import.meta.url), 'utf8')
  const args = buildAgyArgs({ prompt: 'p', model: 'm', schema: unit })
  const sent = args[args.indexOf('--json-schema') + 1]
  expect(sent).not.toMatch(/\(\?[=!]/)
  expect(JSON.parse(sent).type).toBe(JSON.parse(unit).type)
  expect(goRegexSafe({ properties: { pattern: { type: 'string', pattern: '^a(?!b)' }, id: { type: 'string', pattern: '^[a-z]+$' } } }))
    .toEqual({ properties: { pattern: { type: 'string' }, id: { type: 'string', pattern: '^[a-z]+$' } } })
})
