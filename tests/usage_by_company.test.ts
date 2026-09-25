import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { main, renderReport } from '../src/cli/report.ts'
import { createGitPort } from '../src/git/gitport.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { openJournal } from '../src/journal/journal.ts'
import { buildRuntimeStamp } from '../src/journal/stamp.ts'
import { usageByCompany } from '../src/models/usage.ts'
import type { EffectiveQuota } from '../src/models/usage.ts'
import { commitLines, formatMeasureTrailers, storyMeasure } from '../src/telemetry/cost.ts'
import { buildModelTelemetry } from '../src/telemetry/telemetry.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const AT = '2026-09-23T10:00:00.000Z'
const MODEL = { claude: 'claude-opus-5-5', codex: 'gpt-6-sol', agy: 'gemini-3.8-flash-high' } as const
type Fam = keyof typeof MODEL

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) removeTmpDir(d)
  dirs = []
})

let seq = 0
/** Chamada de modelo como o motor grava: família, modelo, papel, custo (null = desconhecido) e duração. */
function call(unit: string, family: Fam, role: 'maker' | 'checker_round', usd: number | null, durationMs: number) {
  seq++
  return {
    seq,
    at: AT,
    kind: 'telemetry',
    unit,
    data: buildModelTelemetry({
      mission_id: 'm1',
      story_id: unit,
      step_id: `${unit}:${seq}:${role}`,
      family,
      role,
      effort: 'high',
      models: [{ role: 'executor', model_id: MODEL[family] }],
      duration_ms: durationMs,
      tokens: usd === null ? { source: 'unavailable' } : { source: 'reported', input: 1, output: 1, cache_read: 0, cache_write: 0, usd },
      usage: undefined,
      pack: { sections: [{ section: 'contract', bytes: 10, digest: '1111111111111111' }], bytes: 10 },
      skills: [],
      sources: [],
      outcome: 'ok',
      ttft_ms: null,
      approval_decisions: 0,
      network_attempts: 0,
      files_touched: 1,
      tool_output_raw_bytes: 0,
      tool_output_model_bytes: 0,
    }),
  }
}
const review = (unit: string, approved: boolean) => ({ at: AT, kind: 'review_result', unit, data: { round: 1, approved } })
const done = (unit: string, status: string, added: number, removed: number) => ({
  at: AT,
  kind: 'story_done',
  unit,
  data: { unit, status, commit: status === 'awaiting_operator' ? null : 'c0ffee', measure: { rounds: 1, lines_added: added, lines_removed: removed } },
})
const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))

/** Journal do exemplo: o Claude escreve P1..P5 (41 chamadas, US$ 38,20, 1.840 linhas), o Codex revisa e escreve P6, o Google revisa. */
function exampleEvents() {
  const events: Array<Record<string, any>> = []
  for (let p = 1; p <= 5; p++) {
    const unit = `P${p}`
    // 9 + 8 + 8 + 8 + 8 = 41 chamadas; 40 a US$ 0,90 e uma a US$ 2,20
    events.push(...times(p === 1 ? 9 : 8, (i) => call(unit, 'claude', 'maker', p === 1 && i === 0 ? 2.2 : 0.9, 204_000)))
    events.push(call(unit, 'codex', 'checker_round', 0.5, 60_000), review(unit, true), done(unit, 'delivered', 300, 68))
  }
  events.push(...times(2, () => call('P6', 'codex', 'maker', 0.5, 60_000)))
  events.push(...times(6, () => call('P6', 'agy', 'checker_round', 0, 66_000)), review('P6', true), done('P6', 'committed', 80, 20))
  return events
}

const QUOTA: EffectiveQuota = { claude: { used: 62, source: 'official' }, codex: { used: 10, source: 'estimated' }, agy: { used: 40, source: 'manual' } }

async function writeJournal(missionDir: string, events: Array<Record<string, any>>) {
  const journal = openJournal({
    missionDir,
    runtimeStamp: buildRuntimeStamp({ configDigest: digest16({}), capabilitiesDigest: digest16({}) }),
    now: () => new Date(AT),
  })
  for (const { at: _at, seq: _seq, ...e } of events) await journal.append(e)
  await journal.close()
}

/** Repositório com planos em .ade/config.json e uma missão cujo último model_chains registrou o Google a 20%. */
async function repoWithMission() {
  const repo = makeTmpDir('ade-usage-')
  dirs.push(repo)
  fs.mkdirSync(path.join(repo, '.ade'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.ade', 'config.json'), JSON.stringify({ models: { plans: { claude: 'max5', codex: 'plus', agy: 'ai_pro' } } }))
  const missionDir = path.join(repo, '.ade', 'missions', 'm1')
  await writeJournal(missionDir, [
    { kind: 'model_chains', data: { chains: {}, why: {}, quota: { claude: null, codex: null, agy: { used: 20, resets_at: '2026-09-28T00:00:00.000Z', source: 'manual' } } } },
    ...times(6, () => call('P6', 'agy', 'checker_round', 0, 66_000)),
  ])
  const manual = (resetsAt: string) =>
    fs.writeFileSync(path.join(repo, '.ade', 'quota-manual.json'), JSON.stringify({ agy: { used: 40, resets_at: resetsAt, source: 'manual' } }))
  const report = async (receipt: Record<string, unknown> | null) => {
    const stdout = { write: (_s: string) => {} }
    const code = await main(['--mission', missionDir], {
      env: {},
      stdout,
      stderr: stdout,
      now: () => NOW,
      quotaPort: { readReceipt: async ({ family }: { family: string }) => (receipt && receipt.family === family ? receipt : null) },
    })
    expect(code).toBe(0)
    return fs.readFileSync(path.join(missionDir, 'report.md'), 'utf8')
  }
  return { manual, report }
}

describe('relatório de uso por empresa', () => {
  test('criterio_1_cada_empresa_mostra_cota_chamadas_partes_linhas_dolar_por_mil_linhas_e_minutos', () => {
    const rows = usageByCompany(exampleEvents(), NOW, QUOTA)
    expect(rows.map((r) => r.family)).toEqual(['claude', 'codex', 'agy'])
    const [claude, codex, agy] = rows
    expect(claude).toMatchObject({ quota: { used: 62, source: 'official' }, calls: 41, unknown_cost_calls: 0, approved_stories: 5, approved_lines: 1840 })
    expect(claude.usd).toBeCloseTo(38.2, 6)
    expect(claude.usd_per_1000_lines).toBeCloseTo(20.76, 2)
    expect(claude.minutes_per_call).toBeCloseTo(3.4, 6)
    // o Codex revisou P1..P5 e escreveu P6
    expect(codex).toMatchObject({ quota: { used: 10, source: 'estimated' }, calls: 7, approved_stories: 1, approved_lines: 100 })
    expect(codex.usd_per_1000_lines).toBeCloseTo(35, 6)
    expect(agy).toMatchObject({ quota: { used: 40, source: 'manual' }, calls: 6, approved_stories: 0, approved_lines: 0, usd_per_1000_lines: null })
    expect(agy.minutes_per_call).toBeCloseTo(1.1, 6)

    const report = renderReport('m1', [], [], null, [], rows)
    expect(report).toContain('## Uso por empresa')
    expect(report).toContain('claude: cota 62% (oficial) · 41 chamadas · 5 partes · 1.840 linhas · US$ 38,20 · US$ 20,76 por mil linhas · 3,4 min por chamada')
    expect(report).toContain('agy: cota 40% (manual) · 6 chamadas · sem linhas aprovadas · 1,1 min por chamada')
    expect(report).toContain('codex: cota 10% (estimada) · 7 chamadas')
  })

  test('criterio_2_cota_manual_nao_vencida_vence_o_model_chains_antigo_oficial_vence_a_manual_e_vencida_vira_estimada', async () => {
    const { manual, report } = await repoWithMission()
    manual('2026-09-28T00:00:00.000Z')
    expect(await report(null)).toContain('agy: cota 40% (manual) · 6 chamadas')

    const official = { source: 'official', family: 'agy', used_percent: 55, reserved_percent: 0, observed_at: AT, weekly_reset_at: '2026-09-28T00:00:00.000Z' }
    expect(await report(official)).toContain('agy: cota 55% (oficial) · 6 chamadas')

    // vencida e sem oficial: estimativa pelo tamanho do plano (AI Pro, tamanho 2)
    manual('2026-09-22T00:00:00.000Z')
    const text = await report(null)
    expect(text).toContain('agy: cota 80% (estimada) · 6 chamadas')
    expect(text).not.toContain('cota 20%')
  })

  test('criterio_2_borda_recibo_oficial_sem_percentual_e_recusado', async () => {
    const { report } = await repoWithMission()
    await expect(report({ source: 'official', family: 'agy', observed_at: AT, weekly_reset_at: '2026-09-28T00:00:00.000Z' })).rejects.toThrow(/used_percent/)
  })

  test('criterio_3_linhas_vao_para_quem_escreveu_a_rodada_aprovada_e_chamadas_contam_para_cada_empresa', () => {
    const events = [
      call('P7', 'claude', 'maker', 1, 60_000),
      call('P7', 'agy', 'checker_round', 0, 60_000),
      review('P7', false),
      // a escada passou para outra empresa, que escreveu a rodada aprovada
      call('P7', 'codex', 'maker', 1, 60_000),
      call('P7', 'agy', 'checker_round', 0, 60_000),
      review('P7', true),
      done('P7', 'delivered', 40, 10),
    ]
    const byFamily = Object.fromEntries(usageByCompany(events, NOW, {}).map((r) => [r.family, r]))
    expect(byFamily.codex).toMatchObject({ calls: 1, approved_stories: 1, approved_lines: 50 })
    expect(byFamily.claude).toMatchObject({ calls: 1, approved_stories: 0, approved_lines: 0, quota: null })
    expect(byFamily.agy).toMatchObject({ calls: 2, approved_lines: 0 })
  })

  test('criterio_4_sem_linhas_aprovadas_nao_divide_por_zero_e_partes_estacionadas_ou_reprovadas_nao_somam', () => {
    const events = [
      call('P8', 'claude', 'maker', 1, 60_000),
      review('P8', true),
      // aprovada pelo revisor mas estacionada na entrega
      done('P8', 'awaiting_operator', 500, 0),
      call('P9', 'claude', 'maker', 1, 60_000),
      review('P9', false),
      done('P9', 'awaiting_operator', 300, 0),
    ]
    const [claude] = usageByCompany(events, NOW, {})
    expect(claude).toMatchObject({ family: 'claude', approved_stories: 0, approved_lines: 0, usd_per_1000_lines: null })
    expect(renderReport('m1', [], [], null, [], [claude])).toContain('claude: cota sem leitura · 2 chamadas · sem linhas aprovadas · US$ 2,00 · 1,0 min por chamada')
  })

  test('criterio_5_chamadas_sem_custo_aparecem_separadas_e_nao_entram_como_zero_no_custo_por_mil_linhas', () => {
    const events = [
      call('P10', 'claude', 'maker', 3, 60_000),
      call('P10', 'claude', 'maker', null, 60_000),
      call('P10', 'claude', 'maker', null, 60_000),
      review('P10', true),
      done('P10', 'committed', 900, 100),
    ]
    const [claude] = usageByCompany(events, NOW, {})
    expect(claude).toMatchObject({ calls: 3, unknown_cost_calls: 2, usd: 3, approved_lines: 1000, usd_per_1000_lines: null })
    const text = renderReport('m1', [], [], null, [], [claude])
    expect(text).toContain('1 partes · 1.000 linhas · US$ 3,00 · 2 chamadas sem custo · 1,0 min por chamada')
    expect(text).not.toContain('por mil linhas')
  })

  // 25/09: Codex e Gemini não informam dólar; a soma estima pelos tokens e o preço de lista, inclusive nas chamadas
  // gravadas antes do preço existir (só tokens, cost_usd nulo).
  test('chamada_antiga_do_gemini_so_com_tokens_entra_pelo_preco_de_lista', () => {
    const old = { seq: 900, at: AT, kind: 'telemetry', unit: 'P11', data: { ...call('P11', 'agy', 'maker', null, 60_000).data, tokens_in: 1_000_000, tokens_out: 0, cache_read: 0, cache_write: 0, models: [{ role: 'executor', model_id: 'gemini-3.8-flash-medium' }] } }
    const [agy] = usageByCompany([old], NOW, {})
    expect(agy).toMatchObject({ calls: 1, unknown_cost_calls: 0, usd: 0.75 })
  })

  test('criterio_6_medida_da_parte_traz_linhas_adicionadas_e_removidas_contra_o_commit_base_sem_mudar_os_rodapes', async () => {
    const repo = makeRepo()
    try {
      fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'um\ndois\ntres\n', 'utf8')
      repo.git(['add', '.'])
      repo.git(['commit', '-m', 'base'])
      const base = repo.git(['rev-parse', 'HEAD']).trim()
      // troca uma linha, remove outra e cria um arquivo de 3 linhas: 4 adicionadas, 2 removidas
      fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'um\nDOIS\n', 'utf8')
      fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'x\ny\nz\n', 'utf8')
      const port = createGitPort({ worktreeDir: repo.dir })
      const { commit } = await port.commit({ message: 'parte' })
      expect(await commitLines(port, base, commit)).toEqual({ lines_added: 4, lines_removed: 2 })
      // sem commit-base observável, as linhas ficam desconhecidas, nunca 0
      expect(await commitLines(port, null, commit)).toEqual({ lines_added: null, lines_removed: null })
    } finally {
      removeRepo(repo.dir)
    }
    const measure = storyMeasure([{ seq: 1, kind: 'story_started', unit: 'P1', data: { unit: 'P1', criteria: 2 } }], 'P1')
    expect(formatMeasureTrailers({ ...measure, lines_added: 4, lines_removed: 2 })).toBe(formatMeasureTrailers(measure))
  })

  test('criterio_7_relatorio_sem_uso_por_empresa_fica_igual_ao_de_antes', () => {
    expect(renderReport('m1', [], [], null, [])).not.toContain('Uso por empresa')
    expect(renderReport('m1', [], [], null, [], [])).toBe(renderReport('m1', [], [], null, []))
  })
})
