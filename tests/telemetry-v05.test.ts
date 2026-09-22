import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseTokens, parseUsage } from '../src/adapters/claude/parse.js'
import { parseCodexTokens } from '../src/adapters/codex/parse.js'
import { dispatchAgy, setAgyAvailable } from '../src/adapters/agy/index.js'
import { sumQuotaUsage, sumTokensByRole } from '../src/cli/report.js'
import { main as doctorMain } from '../src/cli/doctor.js'
import { openJournal } from '../src/journal/journal.js'
import { compilePack, telemetrySections } from '../src/pack/pack.js'
import { buildModelTelemetry, closeMissionSummary, modelsFromUsage } from '../src/telemetry/telemetry.js'
import { auditHarness, evaluateDefaultPruning, evaluateModelPromotion } from '../src/telemetry/harness.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const CLAUDE_ENVELOPE = {
  usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 40 },
  total_cost_usd: 0.0123,
  modelUsage: {
    'claude-opus-5': { costBasis: 'list' },
    'claude-fable-5-1': { costBasis: 'list' },
  },
}
const CODEX_ENVELOPE = { usage: { input_tokens: 300, output_tokens: 70 } }

const PACK = {
  sections: [
    { section: 'contract', bytes: 60, digest: '1111111111111111' },
    { section: 'skills', bytes: 40, digest: '2222222222222222' },
  ],
  bytes: 100,
}

function baseInput(overrides: Record<string, any> = {}) {
  return {
    mission_id: 'mission-1',
    story_id: 'ADE-T1',
    step_id: 'ADE-T1:r1:maker',
    family: 'claude',
    role: 'maker',
    effort: 'default',
    models: modelsFromUsage(parseUsage(CLAUDE_ENVELOPE).models, 'claude-opus-5'),
    duration_ms: 2000,
    tokens: parseTokens(CLAUDE_ENVELOPE),
    usage: parseUsage(CLAUDE_ENVELOPE),
    pack: PACK,
    skills: [
      { name: 'ponytail', bytes: 30, sha256: SHA_A, source: 'catalog@01dc2ec' },
      { name: 'local-rule', bytes: 10, sha256: SHA_B, source: 'local' },
    ],
    sources: [],
    outcome: 'ok',
    ttft_ms: null,
    approval_decisions: 0,
    network_attempts: 0,
    files_touched: 1,
    tool_output_raw_bytes: 0,
    tool_output_model_bytes: 0,
    ...overrides,
  }
}

function tel(seq: number, data: Record<string, any>, at = '2026-09-20T01:00:00.000Z') {
  return { seq, at, kind: 'telemetry', data }
}

let tmpDirs: string[] = []
beforeEach(() => setAgyAvailable(true))
afterEach(() => {
  for (const d of tmpDirs) removeTmpDir(d)
  tmpDirs = []
})

describe('v0.5 telemetria completa e auditoria do harness', () => {
  // (1) Toda chamada de executor ou advisor (implementação, revisão, pesquisa) gera um evento
  // com o contrato completo, também quando falha.
  test('criterio_1_toda_model_call_gera_telemetria_completa_inclusive_pesquisa_e_falha', async () => {
    const REQUIRED = [
      'mission_id', 'story_id', 'step_id', 'family', 'role', 'effort', 'models', 'duration_ms',
      'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'cost_usd', 'cost_source', 'cost_basis',
      'pack_bytes', 'pack_sections', 'skills_injected', 'outcome', 'ttft_ms', 'approval_decisions',
      'network_attempts', 'files_touched', 'tool_output_raw_bytes', 'tool_output_model_bytes',
    ]

    const maker = buildModelTelemetry(baseInput())
    for (const key of REQUIRED) expect(maker).toHaveProperty(key)
    expect(maker).not.toHaveProperty('compaction_events')
    expect(maker.models).toEqual([
      { role: 'advisor', model_id: 'claude-fable-5-1' },
      { role: 'executor', model_id: 'claude-opus-5' },
    ])
    expect(maker.tokens_in).toBe(100)
    expect(maker.tokens_out).toBe(40)
    expect(maker.cache_read).toBe(500)
    expect(maker.cache_write).toBe(20)

    const checker = buildModelTelemetry(baseInput({
      step_id: 'ADE-T1:r1:checker', family: 'codex', role: 'checker_round',
      models: modelsFromUsage([], 'gpt-5.5'), tokens: parseCodexTokens(CODEX_ENVELOPE), usage: undefined,
      outcome: 'rework', files_touched: 0,
    }))
    expect(checker.models).toEqual([{ role: 'executor', model_id: 'gpt-5.5' }])
    expect(checker.outcome).toBe('rework')

    // Falha da chamada: sem uso observado, o evento continua existindo com outcome stop.
    const failed = buildModelTelemetry(baseInput({ tokens: { source: 'unavailable' }, usage: undefined, outcome: 'stop' }))
    expect(failed.outcome).toBe('stop')
    expect(failed.tokens_source).toBe('unknown')
    expect(failed.cost_usd).toBeNull()

    // Outcome fora do contrato é recusado (borda de validação).
    expect(() => buildModelTelemetry(baseInput({ outcome: 'crashed' }))).toThrow(/telemetria inválida/)
    expect(() => buildModelTelemetry(baseInput({ models: [] }))).toThrow(/telemetria inválida/)

    // Pesquisa: o adapter agy devolve a telemetria da própria chamada, com relógio determinístico.
    let clock = 1_000
    const res: any = await dispatchAgy({
      step: async (_meta: any, fn: any) => ({ result: await fn(), status: 'ok', step_id: 's1' }),
      unit: 'ADE-S1',
      stepId: 'ADE-S1:research',
      unknown: { id: 'U1', question: 'Qual a versão?', kind: 'external_fact' },
      budget: { max_usd: 0.5 },
      resolved: { exe: 'agy.exe', prefixArgs: [] },
      outsideDir: 'fora',
      plantCanaryImpl: () => ({ instruction: 'nada', path: 'x' }) as any,
      checkCanaryImpl: () => ({ escaped: false }) as any,
      runWorkerImpl: (async () => {
        clock += 750
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            model: 'gemini-3.8-flash-medium',
            usage: { input_tokens: 10, output_tokens: 5 },
            structured_output: { source: 'https://nodejs.org', date: '2026-09-01', claims: [{ text: 'Node 24' }] },
          }),
        }
      }) as any,
      now: () => clock,
      missionId: 'mission-1',
    } as any)
    expect(res.telemetry.role).toBe('research')
    expect(res.telemetry.step_id).toBe('ADE-S1:research')
    expect(res.telemetry.duration_ms).toBe(750)
    expect(res.telemetry.models).toEqual([{ role: 'executor', model_id: 'gemini-3.8-flash-medium' }])
    expect(res.telemetry.cost_source).toBe('unknown')
    expect(res.telemetry.network_attempts).toBe(1)
    for (const key of REQUIRED) expect(res.telemetry).toHaveProperty(key)
  })

  // (2) Soma das seções = total do pacote; cada skill com tamanho, citação, hash e origem.
  test('criterio_2_telemetry_sections_sum_to_pack_bytes_e_skills_tem_origem', () => {
    const dir = makeTmpDir('tel-pack-')
    tmpDirs.push(dir)
    const pack = compilePack({
      missionDir: dir,
      stepId: 'ADE-T1:pack',
      sections: { contract: '{"id":"ADE-T1"}', policy: 'regras', story: 'história', skills: 'corpo da skill' },
    })
    const sections = telemetrySections(pack.manifest)
    const t = buildModelTelemetry(baseInput({ pack: { sections, bytes: pack.manifest.bytes } }))
    expect(t.pack_bytes).toBe(fs.statSync(pack.pack_path).size)
    expect(t.pack_sections.reduce((acc: number, s: any) => acc + s.bytes, 0)).toBe(t.pack_bytes)

    expect(t.skills_injected).toEqual([
      { name: 'ponytail', bytes: 30, cited: false, sha256: SHA_A, source: 'catalog@01dc2ec' },
      { name: 'local-rule', bytes: 10, cited: false, sha256: SHA_B, source: 'local' },
    ])

    expect(() => buildModelTelemetry(baseInput({ pack: { sections: PACK.sections, bytes: 101 } }))).toThrow(/soma das seções/)
    expect(() => buildModelTelemetry(baseInput({
      skills: [{ name: 'x', bytes: 1, sha256: SHA_A, source: 'github' }],
    }))).toThrow(/origem/)
    expect(() => buildModelTelemetry(baseInput({
      skills: [{ name: 'x', bytes: 1, sha256: 'curto', source: 'local' }],
    }))).toThrow(/sha256/)
  })

  // (3) Família sem custo informado: cost_usd nulo e cost_source unknown.
  test('criterio_3_codex_cost_is_unknown_without_invented_value', () => {
    const codex = buildModelTelemetry(baseInput({
      family: 'codex', models: modelsFromUsage([], 'gpt-5.5'), tokens: parseCodexTokens(CODEX_ENVELOPE), usage: undefined,
    }))
    expect(codex.cost_usd).toBeNull()
    expect(codex.cost_source).toBe('unknown')
    expect(codex.cost_basis).toBeNull()
    expect(codex.tokens_in).toBe(300)
    expect(codex.tokens_source).toBe('reported')

    const claude = buildModelTelemetry(baseInput())
    expect(claude.cost_usd).toBe(0.0123)
    expect(claude.cost_source).toBe('reported')
    expect(claude.cost_basis).toBe('list')
  })

  // (4) cited verdadeiro só para digests realmente citados.
  test('criterio_4_cited_so_para_digests_realmente_citados', () => {
    const t = buildModelTelemetry(baseInput({ sources: ['2222222222222222', SHA_B] }))
    expect(t.pack_sections.map((s: any) => [s.section, s.cited])).toEqual([['contract', false], ['skills', true]])
    expect(t.skills_injected.map((s: any) => [s.name, s.cited])).toEqual([['ponytail', false], ['local-rule', true]])

    expect(() => buildModelTelemetry(baseInput({ sources: 'tudo' }))).toThrow(/sources/)
  })

  // (5) Um único mission_summary no fechamento completo, estacionado ou interrompido.
  test('criterio_5_mission_summary_unico_no_fechamento', () => {
    const stamp = '1:aaaa:cccccccccccccccc'
    const events: any[] = [
      { seq: 1, at: '2026-09-20T00:00:00.000Z', kind: 'decision', source: 'operator', runtime_stamp: stamp, data: { decision: 'plan_approved' } },
      { seq: 2, at: '2026-09-20T00:10:00.000Z', kind: 'human_takeover', runtime_stamp: stamp, data: {} },
      { seq: 3, at: '2026-09-20T00:20:00.000Z', kind: 'run_resumed', runtime_stamp: stamp, data: {} },
      tel(4, buildModelTelemetry(baseInput()), '2026-09-20T00:30:00.000Z'),
      { seq: 5, at: '2026-09-20T01:00:00.000Z', kind: 'story_done', runtime_stamp: stamp, data: { status: 'awaiting_operator' } },
    ]
    const mission = { id: 'mission-1', context: { questions: [{ id: 'Q1' }, { id: 'Q2' }] } }

    for (const outcome of ['completed', 'parked', 'interrupted']) {
      const ev: any = closeMissionSummary({ mission, events, outcome, capabilitiesDigest: 'dddddddddddddddd' })
      expect(ev.kind).toBe('telemetry')
      expect(ev.data).toEqual({
        scope: 'mission_summary',
        mission_id: 'mission-1',
        outcome,
        interventions: 2,
        questions: 2,
        duration_ms: 3_600_000,
        commands: ['approve', 'plan', 'resume', 'run'],
        capabilities_digest: 'dddddddddddddddd',
        capabilities_divergent: true,
        model_calls: 1,
        cost_usd: 0.0123,
        cost_unknown_calls: 0,
      })
    }

    const closed = [...events, { seq: 6, at: '2026-09-20T01:00:01.000Z', kind: 'telemetry', data: { scope: 'mission_summary' } }]
    expect(closeMissionSummary({ mission, events: closed, outcome: 'completed', capabilitiesDigest: 'dddddddddddddddd' })).toBeNull()
    expect(() => closeMissionSummary({ mission, events, outcome: 'talvez', capabilitiesDigest: 'dddddddddddddddd' })).toThrow(/outcome/)
  })

  // (6) Diagnóstico: sete categorias, score, checks com evidência e ações, pelos eventos.
  test('criterio_6_diagnostico_sete_categorias_calculado_pelos_eventos', async () => {
    const CATEGORIES = [
      'tool_coverage', 'context_efficiency', 'quality_gates', 'memory_persistence',
      'eval_coverage', 'security_guardrails', 'cost_efficiency',
    ]
    const good = [
      tel(1, buildModelTelemetry(baseInput({ sources: ['1111111111111111', '2222222222222222'] }))),
      { seq: 2, at: 'x', kind: 'step_result', step_id: 'ADE-T1:eval:red:E1', data: {} },
      { seq: 3, at: 'x', kind: 'step_result', step_id: 'ADE-T1:eval:green:E1', data: {} },
      { seq: 4, at: 'x', kind: 'gates_done', unit: 'ADE-T1', data: { ok: true } },
      { seq: 5, at: 'x', kind: 'review_result', unit: 'ADE-T1', data: { approved: true } },
      { seq: 6, at: 'x', kind: 'contain_result', unit: 'ADE-T1', data: { ok: true } },
      { seq: 7, at: 'x', kind: 'telemetry', data: { scope: 'mission_summary', mission_id: 'mission-1' } },
    ]
    const bad = [
      tel(1, buildModelTelemetry(baseInput({ family: 'codex', tokens: { source: 'unavailable' }, usage: undefined, models: [{ role: 'executor', model_id: 'unknown' }] }))),
      { seq: 2, at: 'x', kind: 'story_done', unit: 'ADE-T1', data: { status: 'awaiting_operator', reason: 'canary_escaped' } },
    ]

    const a = auditHarness(good, {})
    const b = auditHarness(bad, {})
    expect(Object.keys(a.categories).sort()).toEqual([...CATEGORIES].sort())
    expect(Object.keys(b.categories).sort()).toEqual([...CATEGORIES].sort())
    expect(a.score).not.toBeNull()
    expect(b.score).not.toBeNull()
    expect(Number(a.score)).toBeGreaterThan(Number(b.score))
    expect(a.checks.every((c: any) => Array.isArray(c.evidence))).toBe(true)
    const canary = b.checks.find((c: any) => c.id === 'no_canary_escape')
    expect(canary?.pass).toBe(false)
    expect(canary?.evidence).toEqual([2])
    expect(b.top_actions.length).toBeGreaterThan(0)
    expect(b.top_actions.length).toBeLessThanOrEqual(3)

    // Sem eventos não há pontuação inventada por presença de arquivo.
    const empty = auditHarness([], {})
    expect(empty.score).toBeNull()

    // Caminho real: `ade doctor --harness` lê os journals das missões.
    const repo = makeTmpDir('tel-doctor-')
    tmpDirs.push(repo)
    const missionDir = path.join(repo, '.ade', 'missions', 'mission-1')
    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaa:bbbb' })
    await journal.append({ kind: 'telemetry', unit: 'ADE-T1', data: buildModelTelemetry(baseInput()) })
    await journal.close()
    let out = ''
    const code = await doctorMain(['--harness', '--repo', repo], {
      stdout: { write: (s: string) => { out += s; return true } } as any,
      stderr: { write: () => true } as any,
    })
    expect(code).toBe(0)
    const report = JSON.parse(out)
    expect(Object.keys(report.categories).sort()).toEqual([...CATEGORIES].sort())
    expect(report.cache_by_role).toEqual([{ role: 'maker', tokens_in: 100, cache_read: 500, ratio: 500 / 600 }])
  })

  // (7) cache_read / (tokens_in + cache_read) por papel, sem falhar com denominador zero.
  test('criterio_7_cache_por_papel_com_denominador_zero', () => {
    const events = [
      tel(1, buildModelTelemetry(baseInput())),
      tel(2, buildModelTelemetry(baseInput({ step_id: 'ADE-T1:r2:maker' }))),
      tel(3, buildModelTelemetry(baseInput({
        step_id: 'ADE-T1:r1:checker', role: 'checker_round', family: 'codex',
        tokens: { source: 'unavailable' }, usage: undefined,
      }))),
    ]
    const { cache_by_role } = auditHarness(events, {})
    expect(cache_by_role).toEqual([
      { role: 'checker_round', tokens_in: 0, cache_read: 0, ratio: null },
      { role: 'maker', tokens_in: 200, cache_read: 1000, ratio: 1000 / 1200 },
    ])
  })

  // (8) Poda reversível: citação < 20% em 20 stories consecutivas.
  test('criterio_8_poda_reversivel_com_20_stories_e_contagem_auditavel', () => {
    function history(stories: number, citedIn: number) {
      const out: any[] = []
      for (let i = 1; i <= stories; i++) {
        const cited = i <= citedIn
        out.push(tel(i, buildModelTelemetry(baseInput({
          story_id: `ADE-S${i}`,
          step_id: `ADE-S${i}:r1:maker`,
          sources: cited ? [SHA_A] : [],
        }))))
      }
      return out
    }

    const pruned = evaluateDefaultPruning({ events: history(20, 3), config: {} })
    const ponytail = pruned.find((d: any) => d.component === 'skill:ponytail')
    expect(ponytail).toEqual({
      decision: 'harness_default_pruned',
      component: 'skill:ponytail',
      stories: 20,
      cited_stories: 3,
      citation_rate: 0.15,
      reactivate_with: 'harness.opt_in',
    })

    // 19 stories: janela incompleta, nada sai.
    expect(evaluateDefaultPruning({ events: history(19, 0), config: {} })).toEqual([])
    // 4 de 20 = 20%: não é inferior a 20%, fica.
    expect(evaluateDefaultPruning({ events: history(20, 4), config: {} }).find((d: any) => d.component === 'skill:ponytail')).toBeUndefined()
    // Reativação explícita por configuração mantém o componente.
    const kept = evaluateDefaultPruning({ events: history(20, 3), config: { harness: { opt_in: ['skill:ponytail'] } } })
    expect(kept.find((d: any) => d.component === 'skill:ponytail')).toBeUndefined()
    // Decisão já registrada não se repete.
    const recorded = [...history(20, 3), { seq: 99, at: 'x', kind: 'decision', source: 'engine', data: ponytail }]
    expect(evaluateDefaultPruning({ events: recorded, config: {} }).find((d: any) => d.component === 'skill:ponytail')).toBeUndefined()
  })

  // (9) Promoção de modelo exige 5 execuções pareadas válidas por componente afetado.
  test('criterio_9_promocao_de_modelo_exige_cinco_execucoes_pareadas', () => {
    function runs(component: string, pairs: number) {
      const out: any[] = []
      for (let i = 0; i < pairs; i++) {
        for (const variant of ['with', 'without']) {
          out.push({ kind: 'ablation_run', data: { model_id: 'claude-opus-5', component, variant, valid: true } })
        }
      }
      return out
    }
    const components = ['section:skills', 'gate:checker_round']
    const partial = [...runs('section:skills', 5), ...runs('gate:checker_round', 4),
      { kind: 'ablation_run', data: { model_id: 'claude-opus-5', component: 'gate:checker_round', variant: 'with', valid: false } }]

    const blocked = evaluateModelPromotion({ events: partial, candidate: 'claude-opus-5', components, config: {} })
    expect(blocked.allowed).toBe(false)
    expect(blocked.missing).toEqual([{ component: 'gate:checker_round', pairs: 4, required: 5 }])

    const full = [...runs('section:skills', 5), ...runs('gate:checker_round', 5)]
    const notApproved = evaluateModelPromotion({ events: full, candidate: 'claude-opus-5', components, config: {} })
    expect(notApproved).toEqual({ allowed: false, missing: [], reason: 'not_approved_in_config' })

    const approved = evaluateModelPromotion({
      events: full, candidate: 'claude-opus-5', components,
      config: { harness: { approved_models: ['claude-opus-5'] } },
    })
    expect(approved).toEqual({ allowed: true, missing: [], reason: null })
  })

  // (10) Relatórios de custo e cota leem o formato completo e o antigo.
  test('criterio_10_relatorios_de_custo_e_cota_aceitam_formato_completo', () => {
    const now = Date.parse('2026-09-20T02:00:00.000Z')
    const newFormat = [
      tel(1, buildModelTelemetry(baseInput())),
      tel(2, buildModelTelemetry(baseInput({
        family: 'codex', role: 'checker_round', models: modelsFromUsage([], 'gpt-5.5'),
        tokens: parseCodexTokens(CODEX_ENVELOPE), usage: undefined,
      })), '2026-09-19T01:00:00.000Z'),
      tel(3, buildModelTelemetry(baseInput({ tokens: { source: 'unavailable' }, usage: undefined }))),
    ]
    const legacy = [
      { kind: 'telemetry', at: '2026-09-20T01:00:00.000Z', data: { family: 'claude', role: 'maker', tokens: parseTokens(CLAUDE_ENVELOPE) } },
      { kind: 'telemetry', at: '2026-09-19T01:00:00.000Z', data: { family: 'codex', role: 'checker_round', tokens: parseCodexTokens(CODEX_ENVELOPE) } },
      { kind: 'telemetry', at: '2026-09-20T01:00:00.000Z', data: { family: 'claude', role: 'maker', tokens: { source: 'unavailable' } } },
    ]

    expect(sumTokensByRole(newFormat)).toEqual(sumTokensByRole(legacy))
    expect(sumQuotaUsage(newFormat, now)).toEqual(sumQuotaUsage(legacy, now))
    const quota: any = sumQuotaUsage(newFormat, now)
    expect(quota.daily).toEqual([
      { day: '2026-09-19', family: 'codex', role: 'checker_round', quota_tokens: 370, unavailable_calls: 0 },
      { day: '2026-09-20', family: 'claude', role: 'maker', quota_tokens: 640, unavailable_calls: 1 },
    ])
    expect(quota.governance_metrics.fabricated_conversion).toBe(false)
    expect(quota.governance_metrics.total_cost_usd).toBe(0.0123)
  })
})
