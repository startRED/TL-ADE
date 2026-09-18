import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const D1_PATH = fileURLToPath(new URL('../docs/operations/dogfood-d1.md', import.meta.url))
const GUIA_PATH = fileURLToPath(new URL('../docs/operations/usar-em-outro-projeto.md', import.meta.url))
const ROADMAP_PATH = fileURLToPath(new URL('../docs/roadmap.md', import.meta.url))

const REQUIRED_FIELDS = [
  'commit_base',
  'inicio_utc',
  'fim_utc',
  'custo_observado_usd',
  'duracao_s',
  'maker_wall_ms',
  'probe_usd',
  'branch',
  'commit_story',
]

/** Lê as linhas `- chave: valor` de um registro de dogfood. */
function readFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^- ([a-z_]+): (.+)$/.exec(line)
    if (m) fields.set(m[1], m[2].trim())
  }
  return fields
}

/** Campos obrigatórios ausentes num registro de dogfood (local à prova, por contrato da story). */
function missingDogfoodFields(text: string): string[] {
  const fields = readFields(text)
  return REQUIRED_FIELDS.filter((k) => !fields.has(k))
}

describe('docs/operations', () => {
  // CA1: campos obrigatórios com formato numérico/hex correto
  test('dogfood_d1_has_required_measurement_fields', () => {
    const text = readFileSync(D1_PATH, 'utf8')
    expect(missingDogfoodFields(text)).toEqual([])
    const f = readFields(text)
    expect(Number(f.get('custo_observado_usd'))).toBeGreaterThanOrEqual(0)
    expect(Number(f.get('probe_usd'))).toBeGreaterThanOrEqual(0)
    for (const k of ['duracao_s', 'maker_wall_ms']) {
      const n = Number(f.get(k))
      expect(Number.isInteger(n) && n >= 0, `${k} inteiro >= 0`).toBe(true)
    }
    expect(f.get('branch')).toBe('ade/ade-dogfood-d1/ADE-D1')
    expect(f.get('commit_story')).toMatch(/^[0-9a-f]{40}$/)
    expect(f.get('commit_base')).toMatch(/^[0-9a-f]{40}$/)
  })

  // CA2: linha literal e seções obrigatórias
  test('dogfood_d1_has_literal_line_and_sections', () => {
    const text = readFileSync(D1_PATH, 'utf8')
    expect(text).toContain('- first_source_edit_ms: não disponível (substituída por maker_wall_ms)')
    for (const s of ['## Execução', '## Custo e tempo', '## Paradas', '## Falhas e correções']) {
      expect(text, `seção ${s}`).toMatch(new RegExp(`^${s}$`, 'm'))
    }
  })

  // CA3: guia com o comando e todos os motivos de parada
  test('guide_lists_run_command_and_all_stop_reasons', () => {
    const text = readFileSync(GUIA_PATH, 'utf8')
    expect(text).toContain('node <caminho-da-ADE>/bin/ade.js run --plan plan.json --repo <pasta>')
    const reasons = [
      'budget_calls_exhausted',
      'story_started_in_journal',
      'eval_red_not_red',
      'canary_escaped',
      'budget_usd_exceeded',
      'gate_failed',
      'eval_green_failed',
      'secret',
      'sensitive_path',
      'scope',
      'no_changes',
    ]
    for (const r of reasons) expect(text, r).toContain(`\`${r}\``)
  })

  // CA4: missingDogfoodFields e medição de velocidade no roadmap §1
  test('missing_fields_detected_and_roadmap_has_velocity_line', () => {
    const sample = readFileSync(D1_PATH, 'utf8').replace(/^- custo_observado_usd: .*$/m, '')
    expect(missingDogfoodFields(sample)).toEqual(['custo_observado_usd'])

    const roadmap = readFileSync(ROADMAP_PATH, 'utf8')
    const m = /^- linhas_por_dia: (\d+)$/m.exec(roadmap)
    expect(m, 'roadmap §1 precisa de `- linhas_por_dia: <n>`').not.toBeNull()
    expect(Number(m?.[1])).toBeGreaterThan(0)
    expect(roadmap).toContain('v0.2 (Checker Codex + entrega remota)')
  })
})
