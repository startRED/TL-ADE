import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { BRIEF_SCHEMA, createLlmIntent, INTENT_SCHEMA, intentRefs, DEFAULT_INTENT_REFS, PLAN_SCHEMA, type Ask } from '../src/intent/llm-intent.ts'
import { createIntake } from '../src/panel/intake.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-llm-intent-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }))
  return dir
}

const INTENT = {
  title: 'Anexar imagens ao pedido',
  summary: 'Você vai poder anexar imagens ao escrever o pedido.',
  complexity: 'bounded',
  difficulty: 'normal',
  domains: ['frontend', 'ts'],
  needs_ui: true,
  questions: [
    { id: 'q1', question: 'Quantas imagens por pedido?', why: 'Muda a tela.', allow_other: true, options: [{ label: 'Até 5', hint: 'Cobre quase tudo' }, { label: 'Sem limite', hint: 'Pode pesar' }] },
  ],
}

const PLAN = {
  title: 'Imagens no pedido',
  summary: 'A caixa de pedido aceita imagens.',
  explanation: 'Você arrasta imagens para a caixa do pedido.',
  decisions: ['Guardar na pasta da missão, porque já é por missão; descartado: banco de dados'],
  stories: [
    { id: 'A', title: 'Anexar na caixa de pedido', request: 'Aceitar imagens arrastadas ou coladas na caixa de pedido.', acceptance: [{ given: 'a caixa de pedido aberta', when: 'o usuário arrasta uma imagem PNG', then: 'a miniatura aparece com o nome do arquivo' }, { given: 'cinco imagens anexadas', when: 'o usuário tenta a sexta', then: 'aparece o aviso do limite' }], scope_paths: ['packages/web/src/Intake.tsx'], do_not_touch: ['proto/**'], depends_on: [], test_file: 'tests/panel_web_attach.test.ts' },
    { id: 'B', title: 'Guardar as imagens na missão', request: 'Salvar os anexos junto do pedido.', acceptance: [{ given: 'um pedido com duas imagens', when: 'ele é enviado', then: 'as duas ficam na pasta da missão' }], scope_paths: ['src/panel/intake.ts'], do_not_touch: [], depends_on: ['A'], test_file: 'tests/panel_attach_store.test.ts' },
  ],
}

function fakeAsk(replies: Record<string, unknown>) {
  const calls: Array<{ stepId: string; prompt: string; schema: object }> = []
  const ask: Ask = async (call) => {
    calls.push(call)
    if (!(call.stepId in replies)) throw new Error(`etapa inesperada: ${call.stepId}`)
    return replies[call.stepId]
  }
  return { ask, calls }
}

describe('cérebro do pedido com IA', () => {
  test('primeiro entende e pergunta com opções de verdade, a recomendada primeiro, outra resposta e não sei', async () => {
    const { ask, calls } = fakeAsk({ entender: INTENT })
    const res = await createLlmIntent({ askFor: () => ask }).compile({ request: 'Quero anexar imagens no pedido', repoDir: repo(), missionId: 'm1', options: {} as any, eligibleSkills: [] })

    expect(calls.map((c) => c.stepId)).toEqual(['entender'])
    expect(calls[0].schema).toBe(INTENT_SCHEMA)
    expect(calls[0].prompt).toContain('Quero anexar imagens no pedido')
    expect(res.understanding).toMatchObject({ complexity: 'bounded', summary: INTENT.summary })
    const [q] = res.questions ?? []
    expect(q.text).toBe('Quantas imagens por pedido?')
    expect(q.options.map((o: any) => o.label)).toEqual(['Até 5', 'Sem limite', 'Responder com minhas palavras', 'Não sei (a TL-ADE decide)'])
    expect(q.options[0]).toMatchObject({ recommended: true, why: 'Cobre quase tudo' })
    expect(q.options[2].free_text).toBe(true)
  })

  test('com as respostas, planeja sem refazer a entrevista e as partes levam os critérios da IA', async () => {
    const { ask, calls } = fakeAsk({ entender: INTENT, planejar: PLAN })
    const intent = createLlmIntent({ askFor: () => ask })
    const dir = repo()
    const first = await intent.compile({ request: 'Quero anexar imagens no pedido', repoDir: dir, missionId: 'm1', options: {} as any, eligibleSkills: [] })
    const res = await intent.compile({ request: 'Quero anexar imagens no pedido', repoDir: dir, missionId: 'm1', options: {} as any, eligibleSkills: [], questions: first.questions, understanding: first.understanding, answers: { q1: 'Até 3, pequenas' } })

    expect(calls.map((c) => c.stepId)).toEqual(['entender', 'planejar'])
    expect(calls[1].schema).toBe(PLAN_SCHEMA)
    expect(calls[1].prompt).toContain('Quantas imagens por pedido? → Até 3, pequenas')
    const contracts = res.contracts as any[]
    expect(contracts.map((c) => [c.id, c.title])).toEqual([['S1', 'Anexar na caixa de pedido'], ['S2', 'Guardar as imagens na missão']])
    expect(contracts[0].task).toContain('Aceitar imagens arrastadas ou coladas')
    expect(contracts[0].scenarios[0]).toMatchObject({ given: 'a caixa de pedido aberta', when: 'o usuário arrasta uma imagem PNG', then: 'a miniatura aparece com o nome do arquivo' })
    expect(contracts[0].requirements[0].ears).toBe('WHEN o usuário arrasta uma imagem PNG THE SYSTEM SHALL a miniatura aparece com o nome do arquivo')
    expect(contracts[0].guardrails.scope_paths).toEqual(expect.arrayContaining(['packages/web/src/Intake.tsx', 'tests/panel_web_attach.test.ts']))
    expect(contracts[1].depends_on).toEqual(['S1'])
    expect(res.understanding).toMatchObject({ explanation: PLAN.explanation, decisions: PLAN.decisions })
  })

  test('pedido grande vira briefing antes do plano', async () => {
    const briefing = { title: 'App de receitas', goal: 'Guardar e buscar receitas.', users: 'Quem cozinha em casa.', in_scope: ['Cadastrar receita', 'Buscar por ingrediente'], out_of_scope: [], done_means: ['Receita salva aparece na busca'], constraints: [], versions: [{ name: 'v1', goal: 'Cadastro e busca', includes: ['Cadastrar receita', 'Buscar por ingrediente'] }] }
    const { ask, calls } = fakeAsk({ entender: { ...INTENT, complexity: 'project', questions: [] }, briefing })
    const res = await createLlmIntent({ askFor: () => ask }).compile({ request: 'Crie um app de receitas completo', repoDir: repo(), missionId: 'm2', options: {} as any, eligibleSkills: [] })
    expect(calls.map((c) => [c.stepId, c.schema])).toEqual([['entender', INTENT_SCHEMA], ['briefing', BRIEF_SCHEMA]])
    expect(res.briefing).toEqual(briefing)
  })

  test('no painel: pedido, resposta escrita e plano válido gravado na missão', async () => {
    const { ask } = fakeAsk({ entender: INTENT, planejar: PLAN })
    const intake = createIntake({ intent: createLlmIntent({ askFor: () => ask }), runMission: async () => {}, eligibleSkills: () => [], beginActivity: () => () => {}, onError: () => {} })
    const dir = repo()
    const asked = await intake.submit(dir, 'Quero anexar imagens no pedido')
    expect(asked.stage).toBe('interview')
    expect(asked.understanding?.summary).toBe(INTENT.summary)
    const planned = await intake.answer(dir, { q1: 'Até 3, pequenas' })
    expect(planned.stage).toBe('plan')
    expect(planned.decisions?.[0]).toMatchObject({ value: 'Até 3, pequenas', origin: 'usuario' })
    expect(planned.parts?.map((p) => p.title)).toEqual(['Anexar na caixa de pedido', 'Guardar as imagens na missão'])
    expect(planned.parts?.[0].criteria[0]).toBe('Dado a caixa de pedido aberta, quando o usuário arrasta uma imagem PNG, então a miniatura aparece com o nome do arquivo')
    expect(fs.existsSync(path.join(dir, '.ade', 'missions', planned.mission_id, 'stories', 'S2.json'))).toBe(true)
  })

  test('sem planos em Modelos nem papel no config, entende e planeja com Claude e tem o Codex de reserva', () => {
    expect(intentRefs(repo(), undefined)).toEqual(DEFAULT_INTENT_REFS)
    expect(intentRefs(repo(), { roles: { intent_compiler: { primary: { family: 'codex', model_id: 'gpt-6-sol' }, fallbacks: [] } } })).toEqual([{ family: 'codex', model_id: 'gpt-6-sol' }])
  })
})
