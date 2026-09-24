import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openJournal } from '../src/journal/journal.ts'
import { projectMissionFromSources } from '../src/panel/projection.ts'
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
})
