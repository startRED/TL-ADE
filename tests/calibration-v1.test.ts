import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { main } from '../src/cli/index.js'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { calibrate } from '../src/telemetry/harness.ts'
import { buildModelTelemetry } from '../src/telemetry/telemetry.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const STAMP = '1:abc123:def456'

/** Evento de model_call com pack de `packBytes`, dos quais `diffBytes` são a seção de diff. */
function callEvent(story: string, packBytes: number, diffBytes: number) {
  return {
    kind: 'telemetry',
    data: buildModelTelemetry({
      mission_id: 'M1', story_id: story, step_id: `${story}:implement:1`, family: 'claude', role: 'checker', effort: 'high',
      models: [{ role: 'executor', model_id: 'claude-opus-5-5' }], outcome: 'ok', ttft_ms: null,
      duration_ms: 10, approval_decisions: 0, network_attempts: 0, files_touched: 1,
      tool_output_raw_bytes: 0, tool_output_model_bytes: 0, sources: [],
      pack: {
        bytes: packBytes,
        sections: [
          { section: 'contract', bytes: packBytes - diffBytes, digest: 'c' },
          { section: 'diff', bytes: diffBytes, digest: 'd' },
        ],
      },
    }),
  }
}

/** 20 stories com UI; as `escaped` primeiras têm defeito visual achado depois do complete. */
function visualEvents({ escaped = 0, firstSight = 0 } = {}) {
  const events: any[] = []
  for (let i = 1; i <= 20; i++) {
    const unit = `S${String(i).padStart(2, '0')}`
    if (i <= firstSight) {
      events.push({ kind: 'visual_eval_done', unit, data: { round: 2, status: 'awaiting_operator', reason: 'visual_cut_not_met' } })
      events.push({ kind: 'story_done', unit, data: { status: 'awaiting_operator', reason: 'visual_cut_not_met', unit, commit: null } })
      events.push({ kind: 'decision', source: 'operator', unit, data: { decision: 'visual_accepted_as_is', unit } })
    } else {
      events.push({ kind: 'visual_eval_done', unit, data: { round: 1, status: 'pass' } })
    }
    if (i <= escaped) events.push({ kind: 'visual_defect_escaped', unit, data: { unit, defect: 'contraste' } })
  }
  return events
}

function capture() {
  let out = ''
  let err = ''
  return { deps: { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s) }, out: () => out, err: () => err }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTmpDir(d) })

/** Repositório temporário com `.ade/config.json` e uma missão cujo journal recebe `events`. */
async function repoWithMission(events: any[], config: any) {
  const repo = makeTmpDir('ade-calib-')
  dirs.push(repo)
  mkdirSync(path.join(repo, '.ade'), { recursive: true })
  const configPath = path.join(repo, '.ade', 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const missionDir = path.join(repo, '.ade', 'missions', 'M1')
  const journal = openJournal({ missionDir, runtimeStamp: STAMP })
  for (const e of events) await journal.append(e)
  await journal.close()
  return { repo, configPath, missionDir }
}

describe('calibração por telemetria da v1', () => {
  test('propoe_teto_do_pack_e_corte_de_diff_iguais_ao_p90_e_registra_os_numeros', async () => {
    const events = Array.from({ length: 20 }, (_, i) => callEvent(`S${i + 1}`, (i + 1) * 1000, (i + 1) * 100))
    const proposal = calibrate(events)
    expect(proposal).toMatchObject({ max_pack_bytes: 18000, review_max_diff_bytes: 1800, amostra: 20 })
    expect(proposal).not.toHaveProperty('visual_cut')
    expect(proposal.motivo).toContain('18000')
    expect(proposal.motivo).toContain('1800')

    const { missionDir } = await repoWithMission(events, { limits: { max_pack_bytes: 120000 } })
    const io = capture()
    expect(await main(['report', '--calibrate', '--mission', missionDir], io.deps)).toBe(0)
    expect(io.out()).toContain('max_pack_bytes: 18000')
    const recorded = readJournal(path.join(missionDir, 'journal.jsonl')).events.filter((e) => e.kind === 'calibration_proposed')
    expect(recorded).toHaveLength(1)
    expect(recorded[0].data).toMatchObject({
      status: 'pending',
      proposta: { max_pack_bytes: 18000, review_max_diff_bytes: 1800, amostra: 20 },
      em_vigor: { max_pack_bytes: 120000, review_max_diff_bytes: 60000, visual_cut: 7.5 },
    })
  })

  test('mais_de_10_por_cento_de_defeitos_visuais_escapados_em_20_stories_propoe_corte_8', () => {
    const proposal = calibrate(visualEvents({ escaped: 3 }))
    expect(proposal).toMatchObject({ visual_cut: 8, amostra: 20 })
    expect(proposal.motivo).toContain('escaped_visual_defects')
    expect(proposal.motivo).toContain('3/20')
    expect(proposal.motivo).toContain('8,0')
    // Exatamente 10 % não passa do gatilho publicado (> 10 %).
    expect(calibrate(visualEvents({ escaped: 2 }))).not.toHaveProperty('visual_cut')
  })

  test('trabalho_aprovado_a_primeira_vista_aguardando_operador_propoe_corte_7', () => {
    const proposal = calibrate(visualEvents({ firstSight: 20 }))
    expect(proposal).toMatchObject({ visual_cut: 7, amostra: 20 })
    expect(proposal.motivo).toContain('7,0')
  })

  test('proposta_registrada_fica_pendente_e_limites_em_vigor_nao_mudam_sem_config_aprovada', async () => {
    const events = [
      ...Array.from({ length: 20 }, (_, i) => callEvent(`S${i + 1}`, (i + 1) * 1000, (i + 1) * 100)),
      ...visualEvents({ escaped: 3 }),
    ]
    const config = { limits: { max_pack_bytes: 120000, review: { max_diff_bytes: 60000 } }, visual: { cut: 7.5 } }
    const { configPath, missionDir } = await repoWithMission(events, config)
    const before = readFileSync(configPath, 'utf8')

    expect(await main(['report', '--calibrate', '--mission', missionDir], capture().deps)).toBe(0)
    expect(readFileSync(configPath, 'utf8')).toBe(before)

    // Execução seguinte começa sem mudança de configuração: o relatório mostra o que vale e a pendência.
    const journal = openJournal({ missionDir, runtimeStamp: STAMP })
    await journal.append({ kind: 'mission_started', data: { mission_id: 'M1' } })
    await journal.close()
    const out = path.join(missionDir, 'report.md')
    expect(await main(['report', '--mission', missionDir], capture().deps)).toBe(0)
    const report = readFileSync(out, 'utf8')
    expect(report).toContain('Calibração pendente')
    expect(report).toContain('max_pack_bytes: 120000 em vigor, proposto 18000')
    expect(report).toContain('visual_cut: 7.5 em vigor, proposto 8')
    expect(readFileSync(configPath, 'utf8')).toBe(before)

    // Com a configuração aprovada igual à proposta, nada fica pendente.
    writeFileSync(configPath, JSON.stringify({ limits: { max_pack_bytes: 18000, review: { max_diff_bytes: 1800 } }, visual: { cut: 8 } }))
    expect(await main(['report', '--mission', missionDir], capture().deps)).toBe(0)
    expect(readFileSync(out, 'utf8')).not.toContain('Calibração pendente')
  })

  test('telemetria_insuficiente_devolve_ausencia_de_proposta_com_motivo', async () => {
    const few = [
      ...Array.from({ length: 5 }, (_, i) => callEvent(`S${i + 1}`, 5000, 500)),
      ...visualEvents({ escaped: 3 }).filter((e) => ['S01', 'S02', 'S03'].includes(e.unit)),
    ]
    const proposal = calibrate(few)
    expect(proposal).toEqual({ proposta: null, motivo: expect.stringContaining('20') })
    expect(proposal).not.toHaveProperty('max_pack_bytes')
    expect(calibrate([])).toMatchObject({ proposta: null })

    const { missionDir } = await repoWithMission(few, {})
    const io = capture()
    expect(await main(['report', '--calibrate', '--mission', missionDir], io.deps)).toBe(0)
    expect(io.out()).toContain('sem proposta')
    const recorded = readJournal(path.join(missionDir, 'journal.jsonl')).events.filter((e) => e.kind === 'calibration_proposed')
    expect(recorded).toHaveLength(0)

    // Configuração ilegível é erro, não limite padrão calado.
    writeFileSync(path.join(missionDir, '..', '..', 'config.json'), '{quebrado')
    const bad = capture()
    expect(await main(['report', '--calibrate', '--mission', missionDir], bad.deps)).not.toBe(0)
    expect(bad.err()).toContain('config')
  })

  test('documentacao_de_fechamento_cobre_operacoes_seguranca_e_evals_com_caminhos_existentes', () => {
    const docs = {
      operations: 'docs/operations/unattended-night.md',
      security: 'docs/security/human-review-surfaces.md',
      evals: 'docs/evals/dogfood-suite.md',
    }
    const text = Object.fromEntries(Object.entries(docs).map(([k, p]) => {
      expect(existsSync(path.join(ROOT, p)), p).toBe(true)
      return [k, readFileSync(path.join(ROOT, p), 'utf8')]
    }))
    expect(text.operations).toContain('ade run --unattended')
    expect(text.operations).toMatch(/relatório matinal/i)
    expect(text.operations).toContain('ade report --calibrate')
    expect(text.security).toMatch(/contenção e isolamento/i)
    expect(text.security).toMatch(/servidor local do painel/i)
    expect(text.security).toMatch(/ingestão do catálogo/i)
    expect(text.evals).toContain('tests/dogfood-suite.test.ts')
    expect(text.evals).toMatch(/três execuções/i)

    const cited = Object.values(text).flatMap((t) =>
      [...t.matchAll(/(?:`|\]\()((?:src|docs|tests|fixtures|schemas|scripts|bin|examples|packages)\/[^`)\s#]+)/g)].map((m) => m[1]))
    expect(cited.length).toBeGreaterThan(5)
    for (const p of cited) expect(existsSync(path.join(ROOT, p)), `caminho citado inexistente: ${p}`).toBe(true)
  })
})
