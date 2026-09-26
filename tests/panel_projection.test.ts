import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openJournal } from '../src/journal/journal.ts'
import { projectMissionFromSources } from '../src/panel/projection.ts'
import { elapsed } from '../packages/web/src/format.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) removeTmpDir(d)
  dirs = []
})

async function mission(events: Array<Record<string, unknown>>) {
  const dir = makeTmpDir('ade-projection-')
  dirs.push(dir)
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ mission_id: 'm1', phases: [{ epics: [{ stories: ['S1'] }] }] }))
  const journal = openJournal({ missionDir: dir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  for (const ev of events) await journal.append(ev)
  await journal.close()
  return projectMissionFromSources({ missionDir: dir }).stories[0]
}

// 24/09, missão real vista na tela: a parte retomada continuava "parou" enquanto o motor rodava o verde dela, e o
// gasto por parte ficava vazio porque só contava eventos model_call, que o motor não grava (o gasto vem na telemetria).
describe('projeção da missão para a tela', () => {
  test('parte_retomada_volta_a_andar_na_tela', async () => {
    const s1 = await mission([
      { kind: 'story_started', data: { unit: 'S1', worktree_dir: 'w', tree_before: 't0' } },
      { kind: 'story_done', data: { unit: 'S1', status: 'awaiting_operator', reason: 'eval_red_not_red' } },
      { kind: 'decision', data: { decision: 'unit_retry', unit: 'S1' } },
      { kind: 'story_resumed', data: { unit: 'S1', reason: 'story_started_in_journal' } },
    ])
    expect(s1).toMatchObject({ status: 'in_progress', reason: null })
  })

  // 25/09, pedido do operador: ver com que esforço cada modelo trabalha enquanto a chamada roda (a telemetria só chega
  // no fim). O motor anuncia modelo e esforço em model_started; o último de cada papel vale.
  test('modelo_e_esforco_de_cada_papel_aparecem_quando_a_chamada_comeca', async () => {
    const s1 = await mission([
      { kind: 'model_started', data: { unit: 'S1', role: 'prova', family: 'codex', model_id: 'gpt-6-sol', effort: 'high' } },
      { kind: 'model_started', data: { unit: 'S1', role: 'maker', family: 'claude', model_id: 'claude-opus-5-5', effort: 'low' } },
      { kind: 'model_started', data: { unit: 'S1', role: 'maker', family: 'claude', model_id: 'claude-opus-5-5', effort: 'high' } },
    ])
    expect(s1.maker).toEqual({ family: 'claude', model_id: 'claude-opus-5-5', effort: 'high' })
    expect(s1.models).toEqual({ prova: { family: 'codex', model_id: 'gpt-6-sol', effort: 'high' }, maker: { family: 'claude', model_id: 'claude-opus-5-5', effort: 'high' } })
  })

  test('gasto_da_parte_vem_da_telemetria_das_chamadas', async () => {
    const s1 = await mission([
      { kind: 'story_started', data: { unit: 'S1', worktree_dir: 'w', tree_before: 't0' } },
      { kind: 'telemetry', unit: 'S1', data: { step_id: 'S1:proof', role: 'prova', cost_usd: 0.9 } },
      { kind: 'telemetry', unit: 'S1', data: { step_id: 'S1:r1:maker', role: 'maker', cost_usd: 0.66 } },
      // o resumo da missão já traz o total: somá-lo dobraria o gasto
      { kind: 'telemetry', data: { scope: 'mission_summary', cost_usd: 1.56, model_calls: 2 } },
    ])
    expect(s1.cost).toBeCloseTo(1.56)
    expect(s1.calls).toBe(2)
  })

  // 25/09: o painel não deixava claro qual empresa gastava mais; Codex e Gemini ficavam em zero. A missão traz o gasto
  // por empresa, com o preço de lista pelos tokens para quem não informa dólar.
  test('gasto_da_missao_por_empresa_junta_claude_codex_e_gemini', async () => {
    const dir = makeTmpDir('ade-projection-')
    dirs.push(dir)
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ mission_id: 'm1', phases: [{ epics: [{ stories: ['S1'] }] }] }))
    const journal = openJournal({ missionDir: dir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const call = (family: string, role: string, model: string, extra: Record<string, unknown>) =>
      journal.append({ kind: 'telemetry', unit: 'S1', data: { step_id: `S1:${role}`, family, role, duration_ms: 60_000, models: [{ role: 'executor', model_id: model }], ...extra } })
    await call('claude', 'maker', 'claude-opus-5-5', { cost_usd: 1 })
    await call('codex', 'checker_round', 'gpt-6-sol', { cost_usd: null, tokens_in: 100_000, tokens_out: 10_000, cache_read: 0, cache_write: 0 })
    await call('agy', 'prova', 'gemini-3.8-flash-medium', { cost_usd: null, tokens_in: null, tokens_out: null })
    await journal.close()
    const m: any = projectMissionFromSources({ missionDir: dir })
    expect(m.consumed_usd).toBeCloseTo(1.3)
    expect(m.by_company.map((c: any) => [c.family, Number(c.usd.toFixed(2)), c.calls, c.unknown_cost_calls, c.roles])).toEqual([
      ['claude', 1, 1, 0, { código: 1 }],
      ['codex', 0.3, 1, 0, { revisão: 1 }],
      ['agy', 0, 1, 1, { prova: 1 }],
    ])
  })

  // 26/09, pedido do operador: a missão de anexos rodava havia horas e o painel não mostrava há quanto tempo. A missão
  // traz o começo (primeiro evento) e o fim (resumo da missão); a tela conta o tempo em horas e minutos.
  test('missao_traz_comeco_e_fim_para_a_tela_contar_o_tempo', async () => {
    const dir = makeTmpDir('ade-projection-')
    dirs.push(dir)
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ mission_id: 'm1', phases: [{ epics: [{ stories: ['S1'] }] }] }))
    const journal = openJournal({ missionDir: dir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    await journal.append({ kind: 'story_started', data: { unit: 'S1', worktree_dir: 'w', tree_before: 't0' } })
    const running: any = projectMissionFromSources({ missionDir: dir })
    expect(running.started_at).toBe(running.events[0].at)
    expect(running.finished_at).toBeNull()
    // o resumo sai já na primeira parada: não é o fim
    await journal.append({ kind: 'story_done', data: { unit: 'S1', status: 'awaiting_operator', reason: 'x' } })
    await journal.append({ kind: 'telemetry', data: { scope: 'mission_summary', cost_usd: 0, model_calls: 0 } })
    expect((projectMissionFromSources({ missionDir: dir }) as any).finished_at).toBeNull()
    await journal.append({ kind: 'decision', data: { decision: 'unit_retry', unit: 'S1' } })
    await journal.append({ kind: 'story_done', data: { unit: 'S1', status: 'delivered', commit: 'c1' } })
    await journal.close()
    const done: any = projectMissionFromSources({ missionDir: dir })
    expect(done.finished_at).toBe(done.events.at(-1).at)
  })

  test('tempo_da_missao_em_horas_e_minutos', () => {
    const t0 = '2026-09-25T20:29:38Z'
    const at = (min: number) => Date.parse(t0) + min * 60_000
    expect(elapsed(t0, at(0.5))).toBe('menos de 1 min')
    expect(elapsed(t0, at(38))).toBe('38 min')
    expect(elapsed(t0, at(60))).toBe('1 h')
    expect(elapsed(t0, at(5 * 60 + 12))).toBe('5 h 12 min')
  })
})
