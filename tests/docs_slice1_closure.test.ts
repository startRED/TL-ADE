import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const CLOSURE_PATH = fileURLToPath(new URL('../docs/plans/slice-1-fechamento.md', import.meta.url))
const SLICE_PATH = fileURLToPath(new URL('../docs/plans/slice-1.md', import.meta.url))

type MatrixRow = Record<string, string>

const REQUIRED_IDS = [
  'S1-01',
  'S1-02',
  'S1-03',
  'S1-04',
  'S1-05',
  'S1-06',
  'S1-07',
  'S1-08',
  'S1-09',
  'RM-COBERTURA',
  'RM-MEDICAO',
]

const HIGHLIGHT_NAMES = [
  'canonicalize_output_byte_identical_to_python_reference_fixture',
  'journal_hash_chain_detects_tampering',
  'receipt_running_state_is_readable_mid_flight_by_a_cold_process',
  'reconcile_rejects_pid_reuse_via_fingerprint_mismatch',
  'doctor_resolves_npm_shim_to_real_exe_on_windows',
  'worker_env_is_scrubbed',
  'secret_in_diff_stops_batch',
  'eval_born_green_is_rejected',
  'isolation_canary_detects_write_outside_worktree',
  'crash_before_maker_effect_releases_the_call',
  'crash_after_maker_effect_consumes_call_and_continues_from_checkpoint',
  'crash_after_commit_is_reconciled_without_a_second_commit',
]

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  return from < 0 ? '' : text.slice(from, to < 0 ? undefined : to)
}

function namedEvalsFromPlan(text: string): Set<string> {
  const stories = section(text, '## 3.', '## 4.')
  const required = section(text, '## 4.', '## 5.')
  const names = new Set<string>()
  for (const match of stories.matchAll(/V\([^,]+,\s*([a-z0-9_]+)\)/g)) names.add(match[1])
  const highlights = section(required, '**Portão de merge nomeado', '**`fast_lane')
  for (const match of highlights.matchAll(/^\| `([a-z0-9_]+)` \|/gm)) names.add(match[1])
  const ported = section(required, '**Portados de', '**Mapa de nomes')
  for (const match of ported.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
    if (!match[1].endsWith('_')) names.add(match[1])
  }
  return names
}

function inventoryNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^\| `([a-z][a-z0-9_]+)` \| (?:§3|§4|§3 e §4) \|/gm)].map(
      (match) => match[1],
    ),
  )
}

function markdownRows(text: string, heading: string): MatrixRow[] {
  const body = section(text, heading, '\n## ')
  const lines = body.split(/\r?\n/).filter((line) => line.startsWith('|'))
  if (lines.length < 2) return []
  const cells = (line: string) => line.split('|').slice(1, -1).map((cell) => cell.trim())
  const headers = cells(lines[0])
  return lines.slice(2).map((line) =>
    Object.fromEntries(headers.map((header, index) => [header, cells(line)[index] ?? ''])),
  )
}

function invalidProvenRows(rows: MatrixRow[]): MatrixRow[] {
  return rows.filter((row) =>
    row.estado === 'comprovado' &&
    (!/^[0-9a-f]{40}$/.test(row.commit) ||
      !row.sistema ||
      !row.resultado ||
      !row.evidencia ||
      row.evidencia === 'não comprovado')
  )
}

function closureState(rows: MatrixRow[]): string {
  return REQUIRED_IDS.every((id) => rows.some((row) => row.criterio === id && row.estado === 'comprovado'))
    ? 'fechado'
    : 'fechamento pendente'
}

describe('registro de fechamento do Slice 1', () => {
  test('CA1 inventaria nove obrigacoes, todos os evals e requisitos do roadmap', () => {
    expect(existsSync(CLOSURE_PATH), 'registro de fechamento ausente').toBe(true)
    const closure = existsSync(CLOSURE_PATH) ? readFileSync(CLOSURE_PATH, 'utf8') : ''
    const rows = markdownRows(closure, '## Matriz')
    const ids = new Set(rows.map((row) => row.criterio))
    expect(REQUIRED_IDS.filter((id) => !ids.has(id))).toEqual([])

    const expectedNames = namedEvalsFromPlan(readFileSync(SLICE_PATH, 'utf8'))
    const recordedNames = inventoryNames(closure)
    expect([...expectedNames].filter((name) => !recordedNames.has(name))).toEqual([])
    const withoutS109 = markdownRows(closure.replace(/^\| S1-09 .*$/m, ''), '## Matriz')
    expect(withoutS109.some((row) => row.criterio === 'S1-09')).toBe(false)
    expect(closure).toContain('cobertura ≥85%')
    expect(closure).toContain('linhas portadas por dia')
    expect(closure).toContain('replanejamento')
  })

  test('CA2 recusa comprovacao sem commit, sistema, resultado ou evidencia rastreavel', () => {
    const closure = existsSync(CLOSURE_PATH) ? readFileSync(CLOSURE_PATH, 'utf8') : ''
    const rows = markdownRows(closure, '## Matriz')
    expect(invalidProvenRows(rows)).toEqual([])
    const invalid = {
      estado: 'comprovado',
      commit: '',
      sistema: 'Linux',
      resultado: 'saída 0',
      evidencia: 'fixture/linux.log',
    }
    expect(invalidProvenRows([invalid])).toEqual([invalid])
    expect(closure).toContain('testes encontrados')
    expect(closure).toContain('provas executadas')
    expect(closure).toContain('registros operacionais')
  })

  test('CA3 dogfood D1 isolado mantem fechamento pendente e explicita lacunas', () => {
    const closure = existsSync(CLOSURE_PATH) ? readFileSync(CLOSURE_PATH, 'utf8') : ''
    const rows = markdownRows(closure, '## Matriz')
    expect(closureState(rows)).toBe('fechamento pendente')
    expect(closureState([{
      criterio: 'S1-08',
      estado: 'parcial',
      evidencia: 'docs/operations/dogfood-d1.md',
    }])).toBe('fechamento pendente')
    expect(closure).toMatch(/^Estado: \*\*fechamento pendente\*\*$/m)
    expect(closure).toContain('evidencias: [docs/operations/dogfood-d1.md]')
    expect(closure).toContain('gates_done: []')
    expect(closure).toContain('first_source_edit_ms: indisponível')
    expect(closure).toContain('maker_wall_ms não substitui first_source_edit_ms')
    expect(closure).toContain('9a37c9832ce92b085f4eb9aabd6ffb64589ef01a')
    expect(closure).toContain('e733575395575c9098ab3a2d195d485ac15ef16f')
    expect(rows.filter((row) => row.estado !== 'comprovado').length).toBeGreaterThan(0)
  })

  test('CA4 preserva deduplicacao, evals adicionais e doze celulas normativas de crash', () => {
    const closure = existsSync(CLOSURE_PATH) ? readFileSync(CLOSURE_PATH, 'utf8') : ''
    const repeated = [
      'journal_hash_chain_detects_tampering',
      'worker_env_is_scrubbed',
      'secret_in_diff_stops_batch',
      'crash_before_maker_effect_releases_the_call',
      'crash_after_maker_effect_consumes_call_and_continues_from_checkpoint',
      'crash_after_commit_is_reconciled_without_a_second_commit',
    ]
    const portedExample = [...repeated, ...Array.from({ length: 38 }, (_, index) => `ported_${index}`)]
    expect(portedExample).toHaveLength(44)
    expect(new Set([...portedExample, ...HIGHLIGHT_NAMES]).size).toBe(50)
    expect(closure).toContain('44 + 6 = 50')
    expect(closure).toContain('evals adicionais de §3')
    expect(closure).toContain('lista nominal contém 45')

    const crashRows = markdownRows(closure, '### Células normativas de crash')
    expect(crashRows).toHaveLength(12)
    expect(new Set(crashRows.map((row) => row.ator))).toEqual(new Set(['engine', 'worker']))
    expect(new Set(crashRows.map((row) => row.fase))).toEqual(new Set([
      'antes do spawn',
      'depois do efeito do Maker',
      'antes do contain',
      'depois do contain',
      'antes do commit',
      'depois do commit',
    ]))
    expect(closure).toContain('12 prevalecem sobre 24, 28 e 14')
  })
})
